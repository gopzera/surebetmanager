const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

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

    // Attach accounts and tags for each operation
    for (const op of operations) {
      op.accounts = await db.all(
        `SELECT a.id, a.name, oa.stake_bet365 as stake FROM operation_accounts oa
         JOIN accounts a ON a.id = oa.account_id
         WHERE oa.operation_id = ?`,
        op.id
      );
      const tagRows = await db.all(
        'SELECT tag FROM operation_tags WHERE operation_id = ?', op.id
      );
      op.tags = tagRows.map(r => r.tag);
    }

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
    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids, account_stakes, tags } = req.body;

    if (!type || !game) {
      return res.status(400).json({ error: 'Tipo e jogo são obrigatórios' });
    }

    // Resolve account entries: prefer account_stakes (custom per-account stake),
    // fall back to account_ids (equal split, stake = NULL).
    const userAccountsList = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
    const userAccountIds = userAccountsList.map(a => a.id);
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
        `INSERT INTO operations (user_id, type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        req.user.id, type, game, event_date || null,
        stake_bet365 || 0, odd_bet365 || 0,
        stake_poly_usd || 0, odd_poly || 0,
        exchange_rate || 5.0,
        result || 'pending', profit || 0, notes || null
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

    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids, account_stakes, tags } = req.body;

    const userAccounts = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
    const userAccountIds = userAccounts.map(a => a.id);

    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE operations SET type=?, game=?, event_date=?, stake_bet365=?, odd_bet365=?,
          stake_poly_usd=?, odd_poly=?, exchange_rate=?, result=?, profit=?, notes=?
        WHERE id = ?`,
        type ?? op.type, game ?? op.game, event_date ?? op.event_date,
        stake_bet365 ?? op.stake_bet365, odd_bet365 ?? op.odd_bet365,
        stake_poly_usd ?? op.stake_poly_usd, odd_poly ?? op.odd_poly,
        exchange_rate ?? op.exchange_rate,
        result ?? op.result, profit ?? op.profit, notes ?? op.notes,
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

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Delete operation
router.delete('/:id', async (req, res) => {
  try {
    // Verify ownership BEFORE deleting linked records
    const op = await db.get('SELECT id FROM operations WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operação não encontrada' });

    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM operation_accounts WHERE operation_id = ?', op.id);
      await tx.run('DELETE FROM operation_tags WHERE operation_id = ?', op.id);
      await tx.run('DELETE FROM operations WHERE id = ?', op.id);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir operação' });
  }
});

module.exports = router;
