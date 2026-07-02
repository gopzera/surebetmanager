const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);
router.use(require("../middleware/requireAccess").requireAccess);

// Users are in BRT (UTC-3). Match dashboard/freebets period bucketing.
const BR_TZ_OFFSET_MS = -3 * 60 * 60 * 1000;
const OP_DATE_EXPR = `COALESCE(o.event_date, DATE(o.created_at, '-3 hours'))`;
const RANKING_PERIODS = new Set(['daily', 'weekly', 'monthly', 'allTime']);

function brtDateStr(d) {
  return new Date((d ? d.getTime() : Date.now()) + BR_TZ_OFFSET_MS)
    .toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function rankingPeriodWhere(period, alias, today = brtDateStr()) {
  const p = RANKING_PERIODS.has(period) ? period : 'monthly';
  const dateExpr = alias === 'g'
    ? `DATE(g.created_at, '-3 hours')`
    : OP_DATE_EXPR;
  if (p === 'allTime') return { period: p, clause: '1=1', params: [] };
  if (p === 'daily') return { period: p, clause: `${dateExpr} = ?`, params: [today] };
  const start = p === 'weekly' ? addDays(today, -6) : addDays(today, -29);
  return { period: p, clause: `${dateExpr} >= ?`, params: [start] };
}

// Get ranking by selected period (only users who opted in)
router.get('/', async (req, res) => {
  try {
    const period = rankingPeriodWhere(String(req.query.period || 'monthly'), 'o');
    const rows = await db.all(
      `SELECT
        u.id,
        u.display_name,
        u.discord_id,
        u.discord_username,
        u.discord_avatar,
        u.avatar_source,
        (SELECT COUNT(*) FROM user_avatars av WHERE av.user_id = u.id) AS has_avatar,
        COALESCE(SUM(o.profit), 0) as total_profit,
        COUNT(o.id) as total_ops
      FROM users u
      LEFT JOIN operations o ON o.user_id = u.id AND ${period.clause}
      WHERE u.show_in_ranking = 1
      GROUP BY u.id
      ORDER BY total_profit DESC`,
      ...period.params
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
    const period = rankingPeriodWhere(String(req.query.period || 'monthly'), 'g');
    const rows = await db.all(
      `SELECT
        u.id,
        u.display_name,
        u.discord_id,
        u.discord_username,
        u.discord_avatar,
        u.avatar_source,
        (SELECT COUNT(*) FROM user_avatars av WHERE av.user_id = u.id) AS has_avatar,
        COALESCE(SUM(g.profit), 0) as total_profit,
        COUNT(g.id) as total_giros,
        COALESCE(SUM(g.quantity), 0) as total_quantity
      FROM users u
      LEFT JOIN giros g ON g.user_id = u.id AND ${period.clause}
      WHERE u.show_in_giros_ranking = 1
      GROUP BY u.id
      HAVING total_giros > 0
      ORDER BY total_profit DESC`,
      ...period.params
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
    const user = await db.get(
      'SELECT show_in_ranking, show_in_giros_ranking FROM users WHERE id = ?',
      req.user.id
    );
    res.json({
      show_in_ranking: user ? user.show_in_ranking : 1,
      show_in_giros_ranking: user ? user.show_in_giros_ranking : 1,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.put('/me', async (req, res) => {
  try {
    const { show_in_ranking, show_in_giros_ranking } = req.body;
    const sets = [];
    const params = [];
    if (show_in_ranking !== undefined) {
      sets.push('show_in_ranking = ?');
      params.push(show_in_ranking ? 1 : 0);
    }
    if (show_in_giros_ranking !== undefined) {
      sets.push('show_in_giros_ranking = ?');
      params.push(show_in_giros_ranking ? 1 : 0);
    }
    if (sets.length) {
      params.push(req.user.id);
      await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Public mini-profile for a ranking member: identity + bio + a small dashboard
// (month/all-time profit, last-30-days daily profit, profit by type). Only exposed
// for users who opted into the ranking (show_in_ranking = 1) — same visibility as
// the ranking itself.
router.get('/user/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
    const u = await db.get(
      `SELECT id, display_name, discord_id, discord_username, discord_avatar, avatar_source, bio, show_in_ranking,
              (SELECT COUNT(*) FROM user_avatars av WHERE av.user_id = users.id) AS has_avatar
       FROM users WHERE id = ?`,
      id
    );
    if (!u || !u.show_in_ranking) return res.status(404).json({ error: 'Perfil indisponível' });

    const today = brtDateStr();
    const monthStart = today.substring(0, 7) + '-01';

    const month = await db.get(
      `SELECT COALESCE(SUM(o.profit), 0) AS profit, COUNT(*) AS count
       FROM operations o WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= ?`,
      id, monthStart
    );
    const allTime = await db.get(
      `SELECT COALESCE(SUM(profit), 0) AS profit, COUNT(*) AS count FROM operations WHERE user_id = ?`,
      id
    );
    const dailyProfits = await db.all(
      `SELECT ${OP_DATE_EXPR} AS date, SUM(o.profit) AS profit, COUNT(*) AS count
       FROM operations o
       WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= DATE('now', '-3 hours', '-30 days')
       GROUP BY date ORDER BY date`,
      id
    );
    const profitByType = await db.all(
      `SELECT type, COALESCE(SUM(profit), 0) AS profit, COUNT(*) AS count
       FROM operations WHERE user_id = ? GROUP BY type`,
      id
    );

    res.json({
      profile: {
        id: u.id, display_name: u.display_name, discord_id: u.discord_id,
        discord_username: u.discord_username, discord_avatar: u.discord_avatar,
        avatar_source: u.avatar_source, has_avatar: !!u.has_avatar, bio: u.bio || '',
      },
      stats: { month, allTime, dailyProfits, profitByType },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
