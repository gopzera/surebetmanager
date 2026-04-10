const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// List user's accounts
router.get('/', async (req, res) => {
  try {
    const accounts = await db.all(
      'SELECT * FROM accounts WHERE user_id = ? ORDER BY name',
      req.user.id
    );
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// Delete account
router.delete('/:id', async (req, res) => {
  try {
    const used = await db.get(
      'SELECT COUNT(*) as c FROM operation_accounts WHERE account_id = ?',
      req.params.id
    );
    if (used.c > 0) {
      await db.run('UPDATE accounts SET active = 0 WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
      return res.json({ ok: true, deactivated: true });
    }
    const r = await db.run('DELETE FROM accounts WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Conta não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
