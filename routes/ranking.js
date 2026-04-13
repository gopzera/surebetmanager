const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Get ranking — users ranked by all-time profit (only those who opted in)
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT
        u.id,
        u.display_name,
        u.discord_id,
        u.discord_username,
        u.discord_avatar,
        COALESCE(SUM(o.profit), 0) as total_profit,
        COUNT(o.id) as total_ops
      FROM users u
      LEFT JOIN operations o ON o.user_id = u.id
      WHERE u.show_in_ranking = 1
      GROUP BY u.id
      ORDER BY total_profit DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Sortudos — ranking based on giros profit only
router.get('/sortudos', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT
        u.id,
        u.display_name,
        u.discord_id,
        u.discord_username,
        u.discord_avatar,
        COALESCE(SUM(g.profit), 0) as total_profit,
        COUNT(g.id) as total_giros,
        COALESCE(SUM(g.quantity), 0) as total_quantity
      FROM users u
      LEFT JOIN giros g ON g.user_id = u.id
      WHERE u.show_in_ranking = 1
      GROUP BY u.id
      HAVING total_giros > 0
      ORDER BY total_profit DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Get/update current user's ranking preference
router.get('/me', async (req, res) => {
  try {
    const user = await db.get('SELECT show_in_ranking FROM users WHERE id = ?', req.user.id);
    res.json({ show_in_ranking: user ? user.show_in_ranking : 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.put('/me', async (req, res) => {
  try {
    const { show_in_ranking } = req.body;
    await db.run(
      'UPDATE users SET show_in_ranking = ? WHERE id = ?',
      show_in_ranking ? 1 : 0, req.user.id
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
