const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// List operations with filters
router.get('/', async (req, res) => {
  try {
    const { type, from, to, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT * FROM operations WHERE user_id = ?';
    const params = [req.user.id];

    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (from) { sql += ' AND created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND created_at <= ?'; params.push(to + ' 23:59:59'); }

    const countSql = sql.replace(/SELECT \*/, 'SELECT COUNT(*) as total');
    const { total } = await db.get(countSql, ...params);

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    const operations = await db.all(sql, ...params);

    // Attach accounts for each operation
    for (const op of operations) {
      op.accounts = await db.all(
        `SELECT a.id, a.name FROM operation_accounts oa
         JOIN accounts a ON a.id = oa.account_id
         WHERE oa.operation_id = ?`,
        op.id
      );
    }

    res.json({ operations, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create operation
router.post('/', async (req, res) => {
  try {
    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids } = req.body;

    if (!type || !game) {
      return res.status(400).json({ error: 'Tipo e jogo são obrigatórios' });
    }

    // Validate account_ids belong to this user
    const validAccountIds = [];
    if (account_ids && account_ids.length > 0) {
      const userAccounts = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
      const userAccountIds = userAccounts.map(a => a.id);
      for (const accId of account_ids) {
        if (userAccountIds.includes(Number(accId))) {
          validAccountIds.push(Number(accId));
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

      for (const accId of validAccountIds) {
        await tx.run(
          'INSERT INTO operation_accounts (operation_id, account_id) VALUES (?, ?)',
          r.lastInsertRowid, accId
        );
      }

      return r.lastInsertRowid;
    });

    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update operation
router.put('/:id', async (req, res) => {
  try {
    const op = await db.get('SELECT * FROM operations WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operação não encontrada' });

    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd, odd_poly, exchange_rate, result, profit, notes, account_ids } = req.body;

    const userAccounts = await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id);
    const userAccountIds = userAccounts.map(a => a.id);

    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE operations SET type=?, game=?, event_date=?, stake_bet365=?, odd_bet365=?,
          stake_poly_usd=?, odd_poly=?, exchange_rate=?, result=?, profit=?, notes=?
        WHERE id = ? AND user_id = ?`,
        type ?? op.type, game ?? op.game, event_date ?? op.event_date,
        stake_bet365 ?? op.stake_bet365, odd_bet365 ?? op.odd_bet365,
        stake_poly_usd ?? op.stake_poly_usd, odd_poly ?? op.odd_poly,
        exchange_rate ?? op.exchange_rate,
        result ?? op.result, profit ?? op.profit, notes ?? op.notes,
        req.params.id, req.user.id
      );

      if (account_ids !== undefined) {
        await tx.run('DELETE FROM operation_accounts WHERE operation_id = ?', req.params.id);
        for (const accId of (account_ids || [])) {
          if (userAccountIds.includes(Number(accId))) {
            await tx.run(
              'INSERT INTO operation_accounts (operation_id, account_id) VALUES (?, ?)',
              req.params.id, Number(accId)
            );
          }
        }
      }
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete operation
router.delete('/:id', async (req, res) => {
  try {
    const changes = await db.transaction(async (tx) => {
      await tx.run('DELETE FROM operation_accounts WHERE operation_id = ?', req.params.id);
      const r = await tx.run('DELETE FROM operations WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
      return r.changes;
    });
    if (changes === 0) return res.status(404).json({ error: 'Operação não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
