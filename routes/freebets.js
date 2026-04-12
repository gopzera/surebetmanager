const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  try {
    const freebets = await db.all(
      'SELECT * FROM freebets WHERE user_id = ? ORDER BY week_start DESC LIMIT 50',
      req.user.id
    );
    res.json(freebets);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { account_id, week_start, volume_accumulated, freebet_earned, freebet_used, freebet_profit, notes } = req.body;
    if (!week_start) return res.status(400).json({ error: 'Data de início da semana é obrigatória' });

    const existing = await db.get(
      'SELECT id FROM freebets WHERE user_id = ? AND account_id = ? AND week_start = ?',
      req.user.id, account_id || null, week_start
    );

    if (existing) {
      await db.run(
        `UPDATE freebets SET volume_accumulated=?, freebet_earned=?, freebet_used=?, freebet_profit=?, notes=?
         WHERE id = ?`,
        volume_accumulated || 0, freebet_earned ? 1 : 0, freebet_used ? 1 : 0,
        freebet_profit || 0, notes || null, existing.id
      );
      return res.json({ id: existing.id, updated: true });
    }

    const r = await db.run(
      `INSERT INTO freebets (user_id, account_id, week_start, volume_accumulated, freebet_earned, freebet_used, freebet_profit, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, account_id || null, week_start,
      volume_accumulated || 0, freebet_earned ? 1 : 0, freebet_used ? 1 : 0,
      freebet_profit || 0, notes || null
    );
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await db.run('DELETE FROM freebets WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Freebet não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
