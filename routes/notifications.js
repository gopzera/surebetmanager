const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();

const POLY_DATA_API = 'https://data-api.polymarket.com';

// ===== LIST / SEEN / CLEAR (auth required) =====

router.get('/', auth, async (req, res) => {
  try {
    const { category, unseen, limit = 50, offset = 0 } = req.query;
    let where = 'WHERE user_id = ?';
    const params = [req.user.id];
    if (category) { where += ' AND category = ?'; params.push(category); }
    if (unseen === '1') { where += ' AND seen = 0'; }

    const countRow = await db.get(`SELECT COUNT(*) as total FROM notifications ${where}`, ...params);
    const total = countRow ? countRow.total : 0;

    const unseenRow = await db.get(
      `SELECT
         SUM(CASE WHEN category='general' AND seen=0 THEN 1 ELSE 0 END) as general_unseen,
         SUM(CASE WHEN category='system' AND seen=0 THEN 1 ELSE 0 END) as system_unseen
       FROM notifications WHERE user_id = ?`,
      req.user.id
    );

    const rows = await db.all(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params, Number(limit), Number(offset)
    );
    // Parse data JSON
    for (const r of rows) {
      if (r.data) { try { r.data = JSON.parse(r.data); } catch { r.data = null; } }
    }
    res.json({
      notifications: rows,
      total,
      general_unseen: Number(unseenRow?.general_unseen || 0),
      system_unseen: Number(unseenRow?.system_unseen || 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.post('/seen', auth, async (req, res) => {
  try {
    const { ids, category } = req.body;
    if (ids === 'all') {
      let sql = 'UPDATE notifications SET seen = 1 WHERE user_id = ?';
      const params = [req.user.id];
      if (category) { sql += ' AND category = ?'; params.push(category); }
      await db.run(sql, ...params);
    } else if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      await db.run(
        `UPDATE notifications SET seen = 1 WHERE user_id = ? AND id IN (${placeholders})`,
        req.user.id, ...ids.map(Number)
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.delete('/', auth, async (req, res) => {
  try {
    const { category } = req.query;
    let sql = 'DELETE FROM notifications WHERE user_id = ?';
    const params = [req.user.id];
    if (category) { sql += ' AND category = ?'; params.push(category); }
    await db.run(sql, ...params);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== POLY ACTIVITY POLLER =====

// Polls the given user's Polymarket wallet for new trades/redeems and
// inserts notifications respecting the user's prefs. Returns the count of
// new notifications inserted.
async function pollUserPolyActivity(user) {
  if (!user.poly_wallet_address) return 0;
  if (!user.notify_fill_order && !user.notify_fill_limit_order && !user.notify_redeem) return 0;

  const sinceTs = Number(user.poly_last_activity_ts || 0);
  const url = `${POLY_DATA_API}/activity?user=${user.poly_wallet_address}&limit=100&offset=0`;
  let events;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return 0;
    events = await resp.json();
    if (!Array.isArray(events)) return 0;
  } catch (_) {
    return 0;
  }

  const fresh = events.filter(e => Number(e.timestamp || 0) > sinceTs);
  if (!fresh.length) return 0;

  let inserted = 0;
  let maxTs = sinceTs;

  for (const ev of fresh) {
    const ts = Number(ev.timestamp || 0);
    if (ts > maxTs) maxTs = ts;

    const evType = String(ev.type || '').toUpperCase();
    const orderType = String(ev.orderType || ev.order_type || '').toUpperCase();

    let notif = null;
    if (evType === 'TRADE') {
      const isLimit = orderType === 'GTC' || orderType === 'LIMIT';
      const wantsLimit = isLimit && user.notify_fill_limit_order;
      const wantsMarket = !isLimit && user.notify_fill_order;
      if (!wantsLimit && !wantsMarket) continue;
      const side = String(ev.side || '').toUpperCase();
      const sizeStr = ev.size != null ? Number(ev.size).toFixed(2) : '?';
      const priceStr = ev.price != null ? Number(ev.price).toFixed(3) : '?';
      const outcome = ev.outcome || '';
      const title = ev.title || 'Mercado desconhecido';
      notif = {
        type: isLimit ? 'fill_limit_order' : 'fill_order',
        title: `${side === 'BUY' ? 'Compra' : 'Venda'} ${isLimit ? 'limit' : ''} executada`.trim(),
        body: `${title}${outcome ? ` (${outcome})` : ''}: ${sizeStr} shares @ $${priceStr}`,
        data: { event: ev },
      };
    } else if (evType === 'REDEEM') {
      if (!user.notify_redeem) continue;
      const payout = Number(ev.size || ev.usdcSize || ev.payout || 0);
      if (payout <= 0) continue;
      const title = ev.title || 'Mercado desconhecido';
      const outcome = ev.outcome || '';
      notif = {
        type: 'redeem',
        title: 'Redeem disponível',
        body: `${title}${outcome ? ` (${outcome})` : ''}: $${payout.toFixed(2)}`,
        data: { event: ev },
      };
    }

    if (notif) {
      await db.run(
        `INSERT INTO notifications (user_id, category, type, title, body, data)
         VALUES (?, 'general', ?, ?, ?, ?)`,
        user.id, notif.type, notif.title, notif.body, JSON.stringify(notif.data)
      );
      inserted++;
    }
  }

  if (maxTs > sinceTs) {
    await db.run('UPDATE users SET poly_last_activity_ts = ? WHERE id = ?', maxTs, user.id);
  }
  return inserted;
}

// User-triggered poll (auth)
router.post('/poly-poll', auth, async (req, res) => {
  try {
    const user = await db.get(
      `SELECT id, poly_wallet_address, notify_fill_order, notify_fill_limit_order,
              notify_redeem, poly_last_activity_ts
       FROM users WHERE id = ?`,
      req.user.id
    );
    const inserted = await pollUserPolyActivity(user);
    res.json({ inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Cron poll — all users with a wallet configured
router.get('/cron-poly-poll', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const users = await db.all(
      `SELECT id, poly_wallet_address, notify_fill_order, notify_fill_limit_order,
              notify_redeem, poly_last_activity_ts
       FROM users WHERE poly_wallet_address IS NOT NULL AND poly_wallet_address != ''`
    );
    let total = 0;
    for (const user of users) {
      try { total += await pollUserPolyActivity(user); }
      catch (err) { console.error(`Poly poll error for user ${user.id}:`, err.message); }
    }
    res.json({ ok: true, usersPolled: users.length, inserted: total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
