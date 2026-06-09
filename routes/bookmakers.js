const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();
router.use(auth);

const CURRENCIES = ['BRL', 'USD'];

// Built-in houses every user has. Bet365 keeps its own "accounts" system for
// freebet/volume; here it's just a house so rankings can include it later.
// Polymarket is the USD second leg of standard arbs.
const BUILTINS = [
  { name: 'Bet365', currency: 'BRL' },
  { name: 'Polymarket', currency: 'USD' },
];

// Idempotently ensure the built-in houses exist for this user. Relies on the
// UNIQUE(user_id, name) constraint so repeated calls are no-ops.
async function ensureBuiltins(userId) {
  for (const b of BUILTINS) {
    await db.run(
      `INSERT OR IGNORE INTO bookmakers (user_id, name, currency, is_builtin)
       VALUES (?, ?, ?, 1)`,
      userId, b.name, b.currency
    );
  }
}

function isUniqueErr(err) {
  return /UNIQUE constraint failed/i.test(err && err.message || '');
}

// List user's houses (excludes hidden/soft-deleted). Built-ins first, then A→Z.
router.get('/', async (req, res) => {
  try {
    await ensureBuiltins(req.user.id);
    const bookmakers = await db.all(
      'SELECT * FROM bookmakers WHERE user_id = ? AND hidden = 0 ORDER BY is_builtin DESC, name',
      req.user.id
    );
    res.json(bookmakers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Create house
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : 'BRL';
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome da casa é obrigatório' });
    }
    const r = await db.run(
      'INSERT INTO bookmakers (user_id, name, currency) VALUES (?, ?, ?)',
      req.user.id, name.trim(), currency
    );
    await audit(req, 'bookmaker', r.lastInsertRowid, 'created', { name: name.trim(), currency });
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    if (isUniqueErr(err)) return res.status(400).json({ error: 'Já existe uma casa com esse nome' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Update house. Built-ins can't be renamed, have currency changed, or be deactivated.
router.put('/:id', async (req, res) => {
  try {
    const bm = await db.get('SELECT * FROM bookmakers WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!bm) return res.status(404).json({ error: 'Casa não encontrada' });
    if (bm.is_builtin) return res.status(400).json({ error: 'Casas padrão não podem ser editadas' });

    const { name, active } = req.body;
    const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : bm.currency;
    await db.run(
      'UPDATE bookmakers SET name=?, currency=?, active=? WHERE id = ?',
      name ?? bm.name,
      currency,
      active !== undefined ? (active ? 1 : 0) : bm.active,
      req.params.id
    );
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueErr(err)) return res.status(400).json({ error: 'Já existe uma casa com esse nome' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// "Delete" — soft-hide to preserve historical operations that reference the name.
// Built-ins can't be removed.
router.delete('/:id', async (req, res) => {
  try {
    const bm = await db.get('SELECT id, name, is_builtin FROM bookmakers WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!bm) return res.status(404).json({ error: 'Casa não encontrada' });
    if (bm.is_builtin) return res.status(400).json({ error: 'Casas padrão não podem ser removidas' });
    await db.run('UPDATE bookmakers SET hidden = 1, active = 0 WHERE id = ?', bm.id);
    await audit(req, 'bookmaker', bm.id, 'hidden', { name: bm.name });
    res.json({ ok: true, hidden: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
