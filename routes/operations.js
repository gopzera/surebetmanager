const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { attachMany, attachScalars } = require('../utils/batch');
const { audit, diff } = require('../utils/audit');

const router = express.Router();
router.use(auth);

// Flexible JSON column. Shape varies by operation type:
//   aumentada25:  [{stake, odd, uses_freebet, account_id}]   (extra Bet365 legs;
//                                                             account_id attributes
//                                                             freebet spend when
//                                                             uses_freebet=1)
//   arbitragem_br: [{stake, odd, bookmaker}]                 (all legs; bet365/poly cols stay 0)
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

// List operations with filters
router.get('/', async (req, res) => {
  try {
    const { type, from, to, tag, limit = 50, offset = 0 } = req.query;
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
      ...params, Number(limit), Number(offset)
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

    res.json({ operations, total, allTags: allTags.map(r => r.tag) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Create operation
router.post('/', async (req, res) => {
  try {
    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids, account_stakes, tags, extra_bets, uses_freebet, freebet_account_id } = req.body;

    if (!type || !game) {
      return res.status(400).json({ error: 'Tipo e jogo são obrigatórios' });
    }

    // Resolve account entries: prefer account_stakes (custom per-account stake),
    // fall back to account_ids (equal split, stake = NULL).
    const userAccountsList = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
    const userAccountIds = userAccountsList.map(a => a.id);

    const extraBetsStr = serializeExtraBets(extra_bets, userAccountIds);
    const freebetAccountId = (uses_freebet && freebet_account_id != null && userAccountIds.includes(Number(freebet_account_id)))
      ? Number(freebet_account_id) : null;
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
        `INSERT INTO operations (user_id, type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, extra_bets, uses_freebet, freebet_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        req.user.id, type, game, event_date || null,
        stake_bet365 || 0, odd_bet365 || 0,
        stake_poly_usd || 0, odd_poly || 0,
        exchange_rate || 5.0,
        result || 'pending', profit || 0, notes || null,
        extraBetsStr, uses_freebet ? 1 : 0, freebetAccountId
      );

      for (const entry of accountEntries) {
        await tx.run(
          'INSERT INTO operation_accounts (operation_id, account_id, stake_bet365) VALUES (?, ?, ?)',
          r.lastInsertRowid, entry.accId, entry.stake
        );
      }

      // Save tags
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          const t = tag.trim().toLowerCase();
          if (t) {
            await tx.run(
              'INSERT OR IGNORE INTO operation_tags (operation_id, tag) VALUES (?, ?)',
              r.lastInsertRowid, t
            );
          }
        }
      }

      return r.lastInsertRowid;
    });

    await audit(req, 'operation', id, 'created', {
      type, game, event_date, profit, result,
      accounts: accountEntries.map(e => e.accId),
      tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
    });
    res.json({ id });
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

    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids, account_stakes, tags, extra_bets, uses_freebet, freebet_account_id } = req.body;

    const userAccounts = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
    const userAccountIds = userAccounts.map(a => a.id);

    const nextExtraBets = extra_bets !== undefined ? serializeExtraBets(extra_bets, userAccountIds) : op.extra_bets;
    const nextUsesFreebet = uses_freebet !== undefined ? (uses_freebet ? 1 : 0) : (op.uses_freebet || 0);
    const nextFreebetAccountId = freebet_account_id !== undefined
      ? (freebet_account_id != null && userAccountIds.includes(Number(freebet_account_id)) ? Number(freebet_account_id) : null)
      : (op.freebet_account_id || null);

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
          extra_bets=?, uses_freebet=?, freebet_account_id=?
        WHERE id = ?`,
        type ?? op.type, game ?? op.game, event_date ?? op.event_date,
        stake_bet365 ?? op.stake_bet365, odd_bet365 ?? op.odd_bet365,
        stake_poly_usd ?? op.stake_poly_usd, odd_poly ?? op.odd_poly,
        exchange_rate ?? op.exchange_rate,
        result ?? op.result, profit ?? op.profit, notes ?? op.notes,
        nextExtraBets, nextUsesFreebet, nextFreebetAccountId,
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

      if (tags !== undefined) {
        await tx.run('DELETE FROM operation_tags WHERE operation_id = ?', op.id);
        for (const tag of (tags || [])) {
          const t = tag.trim().toLowerCase();
          if (t) {
            await tx.run(
              'INSERT OR IGNORE INTO operation_tags (operation_id, tag) VALUES (?, ?)',
              op.id, t
            );
          }
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
    res.json({
      ok: true,
      snapshot: {
        type: op.type, game: op.game, event_date: op.event_date,
        stake_bet365: op.stake_bet365, odd_bet365: op.odd_bet365,
        stake_poly_usd: op.stake_poly_usd, odd_poly: op.odd_poly,
        exchange_rate: op.exchange_rate, result: op.result,
        profit: op.profit, notes: op.notes,
        uses_freebet: op.uses_freebet, freebet_account_id: op.freebet_account_id,
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
