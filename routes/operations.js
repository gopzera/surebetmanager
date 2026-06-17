const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { attachMany, attachScalars } = require('../utils/batch');
const { audit, diff } = require('../utils/audit');
const { evaluateRules } = require('../utils/tagRules');
const { buildPreview } = require('../utils/googleSheetsImport');

const router = express.Router();
router.use(auth);

// Normalize freebet account payload from the client. Accepts either the legacy
// `freebet_account_id` (single int) or the new `freebet_account_ids` array; dedupes
// and filters to accounts the user owns. Returns { ids, legacyId } where legacyId
// is just ids[0] (kept on operations.freebet_account_id for backward compat with
// old data / callers still reading the scalar column).
function normalizeFreebetAccounts(payload, validIds) {
  const allowed = new Set(validIds.map(Number));
  let raw = [];
  if (Array.isArray(payload.freebet_account_ids)) {
    raw = payload.freebet_account_ids;
  } else if (payload.freebet_account_id != null) {
    raw = [payload.freebet_account_id];
  }
  const seen = new Set();
  const ids = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isFinite(n) || !allowed.has(n) || seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  return {
    ids,
    json: ids.length > 0 ? JSON.stringify(ids) : null,
    legacyId: ids.length > 0 ? ids[0] : null,
  };
}

// Flexible JSON column. Shape varies by operation type:
//   aumentada25:  [{stake, odd, uses_freebet, account_id}]   (extra Bet365 legs;
//                                                             account_id attributes
//                                                             freebet spend when
//                                                             uses_freebet=1)
//   arbitragem_br / tentativa_duplo / punter:
//     [{stake /*BRL*/, odd, bookmaker, bookmaker_id?, currency?, stake_orig?, rate?}]
//     (all legs in extra_bets; bet365/poly cols stay 0). stake is always BRL;
//     for USD houses stake_orig holds the entered USD and rate the USD→BRL factor.
function serializeExtraBets(val, validAccountIds) {
  if (val == null) return null;
  if (typeof val === 'string') {
    try { JSON.parse(val); return val; } catch { return null; }
  }
  if (!Array.isArray(val)) return null;
  const allowed = Array.isArray(validAccountIds) ? new Set(validAccountIds.map(Number)) : null;
  const cleaned = val
    .map(b => {
      const entry = {
        stake: Number(b?.stake) || 0,
        odd: Number(b?.odd) || 0,
      };
      if (b?.uses_freebet !== undefined) entry.uses_freebet = b.uses_freebet ? 1 : 0;
      if (b?.bookmaker != null) {
        const bk = String(b.bookmaker).trim().slice(0, 80);
        if (bk) entry.bookmaker = bk;
      }
      if (b?.bookmaker_id != null) {
        const bmId = Number(b.bookmaker_id);
        if (Number.isFinite(bmId) && bmId > 0) entry.bookmaker_id = bmId;
      }
      if (b?.currency === 'USD' || b?.currency === 'BRL') entry.currency = b.currency;
      if (b?.early_payout) entry.early_payout = 1; // tentativa_duplo: leg has early payout
      if (b?.won) entry.won = 1; // multi-leg arb: this leg/house was the winning side
      if (b?.stake_orig != null) {
        const so = Number(b.stake_orig);
        if (Number.isFinite(so) && so >= 0) entry.stake_orig = so;
      }
      if (b?.rate != null) {
        const rt = Number(b.rate);
        if (Number.isFinite(rt) && rt > 0) entry.rate = rt;
      }
      if (b?.account_id != null) {
        const accId = Number(b.account_id);
        if (Number.isFinite(accId) && (!allowed || allowed.has(accId))) {
          entry.account_id = accId;
        }
      }
      return entry;
    })
    .filter(b => b.stake > 0 || b.odd > 0);
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

// Settlement for "tentativa de duplo": records the early-payout outcome after the
// game. Shape: { outcome: 'none'|'duplo'|'cashout', adjustment: <BRL added to the
// base arb profit> }. Returns null when there's nothing to record.
function serializeSettlement(val) {
  if (val == null) return null;
  let obj = val;
  if (typeof val === 'string') { try { obj = JSON.parse(val); } catch { return null; } }
  if (!obj || typeof obj !== 'object') return null;
  const outcome = ['none', 'duplo', 'cashout'].includes(obj.outcome) ? obj.outcome : 'none';
  const adjustment = Number(obj.adjustment) || 0;
  if (outcome === 'none' && !adjustment) return null;
  return JSON.stringify({ outcome, adjustment });
}

// Pagination caps — protect against a client asking for the whole table and
// silently DoSing the DB. Clients that want everything should page through.
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

function previewForResponse(payload) {
  const preview = buildPreview(payload);
  return {
    ok: preview.ok,
    total: preview.total,
    valid_count: preview.valid_count,
    invalid_count: preview.invalid_count,
    rows: preview.rows.map(row => row.ok ? {
      row_number: row.row_number,
      ok: true,
      errors: [],
      summary: row.summary,
      operation: row.operation,
    } : {
      row_number: row.row_number,
      ok: false,
      errors: row.errors,
    }),
  };
}

// List operations with filters
router.get('/', async (req, res) => {
  try {
    const { type, from, to, tag } = req.query;
    const rawLimit = Number(req.query.limit);
    const rawOffset = Number(req.query.offset);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    let where = 'WHERE o.user_id = ?';
    const params = [req.user.id];

    if (type) { where += ' AND o.type = ?'; params.push(type); }
    if (from) { where += ' AND o.created_at >= ?'; params.push(from); }
    if (to) { where += ' AND o.created_at <= ?'; params.push(to + ' 23:59:59'); }
    if (tag) {
      where += ' AND o.id IN (SELECT operation_id FROM operation_tags WHERE tag = ?)';
      params.push(tag);
    }

    const countRow = await db.get(`SELECT COUNT(*) as total FROM operations o ${where}`, ...params);
    const total = countRow ? countRow.total : 0;

    const operations = await db.all(
      `SELECT o.* FROM operations o ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    // Batch-attach accounts and tags for all operations in two queries (was N+1).
    await attachMany(operations, {
      sql: `SELECT oa.operation_id, a.id, a.name, oa.stake_bet365 as stake
            FROM operation_accounts oa
            JOIN accounts a ON a.id = oa.account_id
            WHERE oa.operation_id IN ({{IN}})`,
      foreignKey: 'operation_id',
      attachAs: 'accounts',
      map: r => ({ id: r.id, name: r.name, stake: r.stake }),
    });
    await attachScalars(operations, {
      sql: `SELECT operation_id, tag FROM operation_tags
            WHERE operation_id IN ({{IN}}) ORDER BY tag`,
      foreignKey: 'operation_id',
      valueKey: 'tag',
      attachAs: 'tags',
    });

    // Get all tags for this user (for filter dropdown)
    const allTags = await db.all(
      `SELECT DISTINCT ot.tag FROM operation_tags ot
       JOIN operations o ON o.id = ot.operation_id
       WHERE o.user_id = ? ORDER BY ot.tag`,
      req.user.id
    );

    res.json({
      operations, total,
      allTags: allTags.map(r => r.tag),
      pagination: { limit, offset, hasMore: offset + operations.length < total },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Preview Google Sheets JSON import without writing anything.
router.post('/import/preview', async (req, res) => {
  try {
    res.json(previewForResponse(req.body));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao validar importacao' });
  }
});

// Commit Google Sheets JSON import. Always revalidates server-side and appends.
router.post('/import/commit', async (req, res) => {
  try {
    const preview = buildPreview(req.body);
    if (!preview.ok) {
      return res.status(400).json({
        error: 'Corrija as linhas invalidas antes de importar.',
        preview: previewForResponse(req.body),
      });
    }

    const prepared = [];
    for (const row of preview.rows) {
      const op = row.operation;
      const autoTags = await evaluateRules(db, req.user.id, {
        type: op.type,
        game: op.game,
        notes: op.notes,
        result: op.result,
        odd_bet365: op.odd_bet365,
        odd_poly: op.odd_poly,
        stake_bet365: op.stake_bet365,
        stake_poly_usd: op.stake_poly_usd,
        profit: op.profit,
      });
      prepared.push({ op, autoTags });
    }

    const ids = await db.transaction(async (tx) => {
      const inserted = [];
      for (const item of prepared) {
        const op = item.op;
        const extraBetsStr = serializeExtraBets(op.extra_bets, []);
        const r = await tx.run(
          `INSERT INTO operations (user_id, type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, extra_bets, uses_freebet, freebet_account_id, freebet_account_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          req.user.id, op.type, op.game, op.event_date || null,
          op.stake_bet365 || 0, op.odd_bet365 || 0,
          op.stake_poly_usd || 0, op.odd_poly || 0,
          op.exchange_rate || 1,
          op.result || 'pending', op.profit || 0, op.notes || null,
          extraBetsStr, 0, null, null
        );
        inserted.push(r.lastInsertRowid);

        for (const t of item.autoTags) {
          await tx.run(
            'INSERT OR IGNORE INTO operation_tags (operation_id, tag) VALUES (?, ?)',
            r.lastInsertRowid, t
          );
        }
      }
      return inserted;
    });

    await audit(req, 'user', req.user.id, 'imported_google_sheets_operations', {
      count: ids.length,
      operation_ids: ids.slice(0, 25),
    });
    res.json({ ok: true, imported: ids.length, ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao importar operacoes' });
  }
});

// Create operation
router.post('/', async (req, res) => {
  try {
    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids, account_stakes, tags, extra_bets, uses_freebet, settlement } = req.body;

    if (!type || !game) {
      return res.status(400).json({ error: 'Tipo e jogo são obrigatórios' });
    }
    const settlementStr = serializeSettlement(settlement);

    // Resolve account entries: prefer account_stakes (custom per-account stake),
    // fall back to account_ids (equal split, stake = NULL).
    const userAccountsList = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
    const userAccountIds = userAccountsList.map(a => a.id);

    const extraBetsStr = serializeExtraBets(extra_bets, userAccountIds);
    const freebet = uses_freebet ? normalizeFreebetAccounts(req.body, userAccountIds) : { ids: [], json: null, legacyId: null };
    const accountEntries = [];
    if (Array.isArray(account_stakes) && account_stakes.length > 0) {
      for (const entry of account_stakes) {
        const accId = Number(entry.account_id);
        if (userAccountIds.includes(accId)) {
          const stake = entry.stake != null ? parseFloat(entry.stake) : null;
          accountEntries.push({ accId, stake: (stake !== null && !isNaN(stake)) ? stake : null });
        }
      }
    } else if (Array.isArray(account_ids)) {
      for (const accId of account_ids) {
        if (userAccountIds.includes(Number(accId))) {
          accountEntries.push({ accId: Number(accId), stake: null });
        }
      }
    }

    const id = await db.transaction(async (tx) => {
      const r = await tx.run(
        `INSERT INTO operations (user_id, type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, extra_bets, uses_freebet, freebet_account_id, freebet_account_ids, settlement)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        req.user.id, type, game, event_date || null,
        stake_bet365 || 0, odd_bet365 || 0,
        stake_poly_usd || 0, odd_poly || 0,
        exchange_rate || 5.0,
        result || 'pending', profit || 0, notes || null,
        extraBetsStr, uses_freebet ? 1 : 0, freebet.legacyId, freebet.json, settlementStr
      );

      for (const entry of accountEntries) {
        await tx.run(
          'INSERT INTO operation_accounts (operation_id, account_id, stake_bet365) VALUES (?, ?, ?)',
          r.lastInsertRowid, entry.accId, entry.stake
        );
      }

      // Save tags — explicit + auto-applied from user's tag_rules. The rule
      // evaluator reads the payload (type/game/odds/profit/…) and returns
      // any tags that match; rules fire on create AND update (see PUT).
      const autoTags = await evaluateRules(db, req.user.id, {
        type, game, notes, result,
        odd_bet365, odd_poly,
        stake_bet365, stake_poly_usd,
        profit,
      });
      const allTags = new Set();
      if (Array.isArray(tags)) tags.forEach(t => { const v = String(t || '').trim().toLowerCase(); if (v) allTags.add(v); });
      autoTags.forEach(t => allTags.add(t));
      for (const t of allTags) {
        await tx.run(
          'INSERT OR IGNORE INTO operation_tags (operation_id, tag) VALUES (?, ?)',
          r.lastInsertRowid, t
        );
      }

      return { id: r.lastInsertRowid, tagList: [...allTags] };
    });

    await audit(req, 'operation', id.id, 'created', {
      type, game, event_date, profit, result,
      accounts: accountEntries.map(e => e.accId),
      tags: id.tagList.slice(0, 10),
    });
    res.json({ id: id.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Update operation
router.put('/:id', async (req, res) => {
  try {
    const op = await db.get('SELECT * FROM operations WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operação não encontrada' });

    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids, account_stakes, tags, extra_bets, uses_freebet, settlement } = req.body;

    const userAccounts = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
    const userAccountIds = userAccounts.map(a => a.id);

    const nextExtraBets = extra_bets !== undefined ? serializeExtraBets(extra_bets, userAccountIds) : op.extra_bets;
    const nextSettlement = settlement !== undefined ? serializeSettlement(settlement) : (op.settlement ?? null);
    const nextUsesFreebet = uses_freebet !== undefined ? (uses_freebet ? 1 : 0) : (op.uses_freebet || 0);

    // Freebet account(s): if the client sent either field, renormalize. Otherwise
    // preserve whatever's on the row already (JSON wins over the legacy scalar).
    let nextFreebetIdsJson, nextFreebetLegacyId;
    if (req.body.freebet_account_ids !== undefined || req.body.freebet_account_id !== undefined || uses_freebet !== undefined) {
      if (nextUsesFreebet) {
        const n = normalizeFreebetAccounts(req.body, userAccountIds);
        nextFreebetIdsJson = n.json;
        nextFreebetLegacyId = n.legacyId;
      } else {
        nextFreebetIdsJson = null;
        nextFreebetLegacyId = null;
      }
    } else {
      nextFreebetIdsJson = op.freebet_account_ids || null;
      nextFreebetLegacyId = op.freebet_account_id || null;
    }

    const auditPayload = diff(
      { type: op.type, game: op.game, event_date: op.event_date, profit: op.profit, result: op.result,
        stake_bet365: op.stake_bet365, odd_bet365: op.odd_bet365 },
      { type: type ?? op.type, game: game ?? op.game, event_date: event_date ?? op.event_date,
        profit: profit ?? op.profit, result: result ?? op.result,
        stake_bet365: stake_bet365 ?? op.stake_bet365, odd_bet365: odd_bet365 ?? op.odd_bet365 }
    );

    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE operations SET type=?, game=?, event_date=?, stake_bet365=?, odd_bet365=?,
          stake_poly_usd=?, odd_poly=?, exchange_rate=?, result=?, profit=?, notes=?,
          extra_bets=?, uses_freebet=?, freebet_account_id=?, freebet_account_ids=?, settlement=?
        WHERE id = ?`,
        type ?? op.type, game ?? op.game, event_date ?? op.event_date,
        stake_bet365 ?? op.stake_bet365, odd_bet365 ?? op.odd_bet365,
        stake_poly_usd ?? op.stake_poly_usd, odd_poly ?? op.odd_poly,
        exchange_rate ?? op.exchange_rate,
        result ?? op.result, profit ?? op.profit, notes ?? op.notes,
        nextExtraBets, nextUsesFreebet, nextFreebetLegacyId, nextFreebetIdsJson, nextSettlement,
        op.id
      );

      if (account_stakes !== undefined) {
        await tx.run('DELETE FROM operation_accounts WHERE operation_id = ?', op.id);
        for (const entry of (account_stakes || [])) {
          const accId = Number(entry.account_id);
          if (userAccountIds.includes(accId)) {
            const stake = entry.stake != null ? parseFloat(entry.stake) : null;
            const safeStake = (stake !== null && !isNaN(stake)) ? stake : null;
            await tx.run(
              'INSERT INTO operation_accounts (operation_id, account_id, stake_bet365) VALUES (?, ?, ?)',
              op.id, accId, safeStake
            );
          }
        }
      } else if (account_ids !== undefined) {
        await tx.run('DELETE FROM operation_accounts WHERE operation_id = ?', op.id);
        for (const accId of (account_ids || [])) {
          if (userAccountIds.includes(Number(accId))) {
            await tx.run(
              'INSERT INTO operation_accounts (operation_id, account_id, stake_bet365) VALUES (?, ?, NULL)',
              op.id, Number(accId)
            );
          }
        }
      }

      // Auto-tags re-evaluated on every edit: the rule fire list tracks the
      // CURRENT field values, so if the user bumps odd_bet365 above a rule's
      // threshold the matching tag appears; if they lower it, it disappears.
      // Only reset tags when the client sent an explicit tags array OR when
      // any rule-evaluable field was changed (to avoid clobbering manually
      // added tags on an unrelated field edit).
      const shouldRetag = tags !== undefined || [
        'type', 'game', 'notes', 'result',
        'odd_bet365', 'odd_poly',
        'stake_bet365', 'stake_poly_usd',
        'profit',
      ].some(k => req.body[k] !== undefined);

      if (shouldRetag) {
        const autoTags = await evaluateRules(db, req.user.id, {
          type: type ?? op.type, game: game ?? op.game,
          notes: notes ?? op.notes, result: result ?? op.result,
          odd_bet365: odd_bet365 ?? op.odd_bet365,
          odd_poly: odd_poly ?? op.odd_poly,
          stake_bet365: stake_bet365 ?? op.stake_bet365,
          stake_poly_usd: stake_poly_usd ?? op.stake_poly_usd,
          profit: profit ?? op.profit,
        });
        const merged = new Set();
        if (tags !== undefined && Array.isArray(tags)) {
          tags.forEach(t => { const v = String(t || '').trim().toLowerCase(); if (v) merged.add(v); });
        } else {
          const existing = await tx.all('SELECT tag FROM operation_tags WHERE operation_id = ?', op.id);
          existing.forEach(r => merged.add(r.tag));
        }
        autoTags.forEach(t => merged.add(t));

        await tx.run('DELETE FROM operation_tags WHERE operation_id = ?', op.id);
        for (const t of merged) {
          await tx.run(
            'INSERT OR IGNORE INTO operation_tags (operation_id, tag) VALUES (?, ?)',
            op.id, t
          );
        }
      }
    });

    if (auditPayload) await audit(req, 'operation', op.id, 'updated', auditPayload);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Delete operation. Returns a snapshot the client can POST back to /api/operations
// within its undo window — the recreated row gets a new id but preserves every
// field (accounts with stakes, tags, extra_bets, freebet flags, profit, result).
router.delete('/:id', async (req, res) => {
  try {
    const op = await db.get('SELECT * FROM operations WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operação não encontrada' });
    const accRows = await db.all(
      'SELECT account_id, stake_bet365 FROM operation_accounts WHERE operation_id = ?', op.id
    );
    const tagList = (await db.all('SELECT tag FROM operation_tags WHERE operation_id = ?', op.id))
      .map(r => r.tag);

    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM operation_accounts WHERE operation_id = ?', op.id);
      await tx.run('DELETE FROM operation_tags WHERE operation_id = ?', op.id);
      // Giros referencing this op keep their row but lose the link (Turso
      // doesn't enforce FKs — without this, giros.operation_id would dangle).
      await tx.run('UPDATE giros SET operation_id = NULL WHERE operation_id = ?', op.id);
      await tx.run('DELETE FROM operations WHERE id = ?', op.id);
    });
    await audit(req, 'operation', op.id, 'deleted', {
      type: op.type, game: op.game, event_date: op.event_date,
      profit: op.profit, result: op.result,
      accounts: accRows.map(r => r.account_id), tags: tagList,
    });
    let extraBets = null;
    if (op.extra_bets) { try { extraBets = JSON.parse(op.extra_bets); } catch { extraBets = null; } }
    let freebetAccountIds = null;
    if (op.freebet_account_ids) { try { freebetAccountIds = JSON.parse(op.freebet_account_ids); } catch {} }
    if ((!freebetAccountIds || !freebetAccountIds.length) && op.freebet_account_id) {
      freebetAccountIds = [op.freebet_account_id];
    }
    res.json({
      ok: true,
      snapshot: {
        type: op.type, game: op.game, event_date: op.event_date,
        stake_bet365: op.stake_bet365, odd_bet365: op.odd_bet365,
        stake_poly_usd: op.stake_poly_usd, odd_poly: op.odd_poly,
        exchange_rate: op.exchange_rate, result: op.result,
        profit: op.profit, notes: op.notes,
        uses_freebet: op.uses_freebet,
        freebet_account_id: op.freebet_account_id,
        freebet_account_ids: freebetAccountIds,
        extra_bets: extraBets,
        account_stakes: accRows.map(r => ({ account_id: r.account_id, stake: r.stake_bet365 })),
        tags: tagList,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir operação' });
  }
});

module.exports = router;
