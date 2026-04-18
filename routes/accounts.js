const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();
router.use(auth);

// List user's accounts (excludes hidden/soft-deleted)
router.get('/', async (req, res) => {
  try {
    const accounts = await db.all(
      'SELECT * FROM accounts WHERE user_id = ? AND hidden = 0 ORDER BY name',
      req.user.id
    );
    res.json(accounts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Create account
router.post('/', async (req, res) => {
  try {
    const { name, max_stake_aumentada } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome da conta é obrigatório' });
    }
    const r = await db.run(
      'INSERT INTO accounts (user_id, name, max_stake_aumentada) VALUES (?, ?, ?)',
      req.user.id, name.trim(), max_stake_aumentada || 250
    );
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Update account
router.put('/:id', async (req, res) => {
  try {
    const acc = await db.get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });

    const { name, max_stake_aumentada, active } = req.body;
    await db.run(
      'UPDATE accounts SET name=?, max_stake_aumentada=?, active=? WHERE id = ?',
      name ?? acc.name,
      max_stake_aumentada ?? acc.max_stake_aumentada,
      active !== undefined ? (active ? 1 : 0) : acc.active,
      req.params.id
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Per-account performance: volume, attributed profit and ROI over an optional
// date range. Profit is split equally across participating accounts per op
// (same convention /api/finances/roi uses for operator attribution). Volume
// uses operation_accounts.stake_bet365 when present, otherwise splits the
// operation-level stake_bet365 equally. Pending operations are excluded.
router.get('/performance', async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : '1900-01-01';
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : '9999-12-31';

    const rows = await db.all(
      `SELECT
         a.id                            AS account_id,
         a.name                          AS account_name,
         a.hidden                        AS hidden,
         COUNT(DISTINCT o.id)            AS op_count,
         COALESCE(SUM(COALESCE(oa.stake_bet365, o.stake_bet365 * 1.0 / part.cnt)), 0) AS volume,
         COALESCE(SUM(o.profit * 1.0 / part.cnt), 0)                                   AS attributed_profit
       FROM accounts a
       LEFT JOIN operation_accounts oa ON oa.account_id = a.id
       LEFT JOIN operations o
              ON o.id = oa.operation_id
             AND o.user_id = ?
             AND o.result != 'pending'
             AND COALESCE(o.event_date, DATE(o.created_at, '-3 hours')) BETWEEN ? AND ?
       LEFT JOIN (
         SELECT operation_id, COUNT(*) AS cnt
         FROM operation_accounts
         GROUP BY operation_id
       ) part ON part.operation_id = o.id
       WHERE a.user_id = ?
       GROUP BY a.id, a.name, a.hidden
       ORDER BY attributed_profit DESC, a.name`,
      req.user.id, from, to, req.user.id
    );

    const result = rows.map(r => {
      const volume = Number(r.volume || 0);
      const profit = Number(r.attributed_profit || 0);
      return {
        account_id: r.account_id,
        account_name: r.account_name,
        hidden: !!r.hidden,
        op_count: Number(r.op_count || 0),
        volume,
        attributed_profit: profit,
        roi_pct: volume > 0 ? (profit / volume) * 100 : 0,
      };
    });
    res.json({ from, to, accounts: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// "Delete" account — always soft-hide to preserve FK integrity with historical operations.
// Returns hidden=true so the UI can remove the row immediately.
router.delete('/:id', async (req, res) => {
  try {
    const acc = await db.get('SELECT id, name FROM accounts WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
    await db.run('UPDATE accounts SET hidden = 1, active = 0 WHERE id = ?', acc.id);
    await audit(req, 'account', acc.id, 'hidden', { name: acc.name });
    res.json({ ok: true, hidden: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
