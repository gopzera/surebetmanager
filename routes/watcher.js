const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();

const POLY_DATA_API = 'https://data-api.polymarket.com';

// ===== WATCHED WALLETS CRUD (auth required) =====

router.get('/wallets', auth, async (req, res) => {
  try {
    const wallets = await db.all(
      'SELECT * FROM watched_wallets WHERE user_id = ? ORDER BY created_at DESC',
      req.user.id
    );
    res.json(wallets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/wallets', auth, async (req, res) => {
  try {
    const { label, address } = req.body;
    if (!label || !address) {
      return res.status(400).json({ error: 'Label e endereço são obrigatórios' });
    }
    const addr = address.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/i.test(addr)) {
      return res.status(400).json({ error: 'Endereço inválido (deve ser 0x... com 42 caracteres)' });
    }
    const existing = await db.get(
      'SELECT id FROM watched_wallets WHERE user_id = ? AND address = ?',
      req.user.id, addr
    );
    if (existing) {
      return res.status(400).json({ error: 'Essa wallet já está sendo monitorada' });
    }
    const r = await db.run(
      'INSERT INTO watched_wallets (user_id, label, address) VALUES (?, ?, ?)',
      req.user.id, label.trim(), addr
    );
    res.json({ id: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== WALLET IMPORT/EXPORT =====

// Export wallets as JSON
router.get('/wallets/export', auth, async (req, res) => {
  try {
    const wallets = await db.all(
      'SELECT label, address FROM watched_wallets WHERE user_id = ? AND active = 1 ORDER BY label',
      req.user.id
    );
    res.setHeader('Content-Disposition', 'attachment; filename=wallets.json');
    res.json(wallets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Import wallets from JSON array of {label, address}
router.post('/wallets/import', auth, async (req, res) => {
  try {
    const { wallets } = req.body;
    if (!Array.isArray(wallets) || !wallets.length) {
      return res.status(400).json({ error: 'Envie um array de wallets com label e address' });
    }
    let added = 0;
    let skipped = 0;
    for (const w of wallets) {
      const label = (w.label || '').trim();
      const address = (w.address || '').trim().toLowerCase();
      if (!label || !address || !/^0x[a-f0-9]{40}$/i.test(address)) {
        skipped++;
        continue;
      }
      const existing = await db.get(
        'SELECT id FROM watched_wallets WHERE user_id = ? AND address = ?',
        req.user.id, address
      );
      if (existing) {
        skipped++;
        continue;
      }
      await db.run(
        'INSERT INTO watched_wallets (user_id, label, address) VALUES (?, ?, ?)',
        req.user.id, label, address
      );
      added++;
    }
    res.json({ added, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/wallets/:id', auth, async (req, res) => {
  try {
    const wallet = await db.get(
      'SELECT * FROM watched_wallets WHERE id = ? AND user_id = ?',
      req.params.id, req.user.id
    );
    if (!wallet) return res.status(404).json({ error: 'Wallet não encontrada' });
    const { label, active } = req.body;
    await db.run(
      'UPDATE watched_wallets SET label = ?, active = ? WHERE id = ?',
      label ?? wallet.label, active ?? wallet.active, wallet.id
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/wallets/:id', auth, async (req, res) => {
  try {
    const changes = await db.transaction(async (tx) => {
      await tx.run('DELETE FROM wallet_alerts WHERE wallet_id = ?', req.params.id);
      await tx.run('DELETE FROM wallet_positions WHERE wallet_id = ?', req.params.id);
      const r = await tx.run(
        'DELETE FROM watched_wallets WHERE id = ? AND user_id = ?',
        req.params.id, req.user.id
      );
      return r.changes;
    });
    if (changes === 0) return res.status(404).json({ error: 'Wallet não encontrada' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CORE POLL LOGIC =====

// Build a unique key per position: conditionId + outcome (Yes/No can coexist)
function posKey(conditionId, outcome) {
  return `${conditionId}/${outcome || ''}`;
}

async function pollWallet(wallet) {
  const newAlerts = [];
  const url = `${POLY_DATA_API}/positions?user=${wallet.address}&sizeThreshold=0.01&limit=500`;
  const resp = await fetch(url);
  if (!resp.ok) return newAlerts;
  const positions = await resp.json();

  // Filter out resolved positions (each share = $1, or value < $1)
  const livePositions = positions.filter(p => {
    const size = p.size || 0;
    const val = p.currentValue || 0;
    if (val < 1) return false;
    if (Math.abs(size - val) < 0.01) return false;
    return true;
  });

  const stored = await db.all('SELECT * FROM wallet_positions WHERE wallet_id = ?', wallet.id);
  const storedMap = new Map(stored.map(p => [p.condition_id, p]));
  const seenKeys = new Set();

  await db.transaction(async (tx) => {
    for (const pos of livePositions) {
      const key = posKey(pos.conditionId, pos.outcome);
      seenKeys.add(key);

      await tx.run(
        `INSERT INTO wallet_positions (wallet_id, condition_id, title, outcome, size, avg_price, current_value)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet_id, condition_id) DO UPDATE SET
           size = excluded.size, avg_price = excluded.avg_price,
           current_value = excluded.current_value, title = excluded.title,
           outcome = excluded.outcome, last_seen = CURRENT_TIMESTAMP`,
        wallet.id, key, pos.title || '', pos.outcome || '',
        pos.size || 0, pos.avgPrice || 0, pos.currentValue || 0
      );

      if (!storedMap.has(key)) {
        const alert = {
          wallet_id: wallet.id, type: 'new_position', condition_id: key,
          title: pos.title || 'Mercado desconhecido', outcome: pos.outcome || '',
          side: 'BUY', size: pos.size || 0, price: pos.avgPrice || 0,
          usdc_size: pos.currentValue || 0, walletLabel: wallet.label,
        };
        await tx.run(
          `INSERT INTO wallet_alerts (wallet_id, type, condition_id, title, outcome, side, size, price, usdc_size, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          wallet.id, 'new_position', key, alert.title, alert.outcome,
          'BUY', alert.size, alert.price, alert.usdc_size, new Date().toISOString()
        );
        newAlerts.push(alert);
      } else {
        const old = storedMap.get(key);
        if (pos.size > old.size * 1.05 + 0.5) {
          const alert = {
            wallet_id: wallet.id, type: 'trade_buy', condition_id: key,
            title: pos.title || old.title, outcome: pos.outcome || old.outcome,
            side: 'BUY', size: pos.size - old.size, price: pos.avgPrice || 0,
            usdc_size: Math.abs((pos.currentValue || 0) - (old.current_value || 0)),
            walletLabel: wallet.label,
          };
          await tx.run(
            `INSERT INTO wallet_alerts (wallet_id, type, condition_id, title, outcome, side, size, price, usdc_size, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            wallet.id, 'trade_buy', key, alert.title, alert.outcome,
            'BUY', alert.size, alert.price, alert.usdc_size, new Date().toISOString()
          );
          newAlerts.push(alert);
        }
      }
    }

    // Detect closed positions
    for (const [key, old] of storedMap) {
      if (!seenKeys.has(key)) {
        const alert = {
          wallet_id: wallet.id, type: 'position_closed', condition_id: key,
          title: old.title || 'Mercado desconhecido', outcome: old.outcome || '',
          side: 'SELL', size: old.size, price: 0,
          usdc_size: old.current_value || 0, walletLabel: wallet.label,
        };
        await tx.run(
          `INSERT INTO wallet_alerts (wallet_id, type, condition_id, title, outcome, side, size, price, usdc_size, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          wallet.id, 'position_closed', key, alert.title, alert.outcome,
          'SELL', alert.size, 0, alert.usdc_size, new Date().toISOString()
        );
        newAlerts.push(alert);
        await tx.run('DELETE FROM wallet_positions WHERE wallet_id = ? AND condition_id = ?', wallet.id, key);
      }
    }
  });

  return newAlerts;
}

// ===== POLL ENDPOINTS =====

// User-triggered poll (auth required)
router.post('/poll', auth, async (req, res) => {
  try {
    const wallets = await db.all(
      'SELECT * FROM watched_wallets WHERE user_id = ? AND active = 1',
      req.user.id
    );
    if (!wallets.length) return res.json({ alerts: [] });

    const newAlerts = [];
    for (const wallet of wallets) {
      try {
        const alerts = await pollWallet(wallet);
        newAlerts.push(...alerts);
      } catch (err) {
        console.error(`Error polling wallet ${wallet.label}:`, err.message);
      }
    }
    res.json({ alerts: newAlerts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cron poll — polls ALL users' wallets (secured by CRON_SECRET)
router.get('/cron-poll', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const wallets = await db.all('SELECT * FROM watched_wallets WHERE active = 1');
    let totalAlerts = 0;
    for (const wallet of wallets) {
      try {
        const alerts = await pollWallet(wallet);
        totalAlerts += alerts.length;
      } catch (err) {
        console.error(`Cron poll error for wallet ${wallet.label}:`, err.message);
      }
    }
    res.json({ ok: true, walletsPolled: wallets.length, newAlerts: totalAlerts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== ALERTS =====

router.get('/alerts', auth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, unseen, wallet_id, type, from, to } = req.query;
    let where = 'WHERE ww.user_id = ?';
    const params = [req.user.id];
    if (unseen === '1') { where += ' AND wa.seen = 0'; }
    if (wallet_id) { where += ' AND wa.wallet_id = ?'; params.push(Number(wallet_id)); }
    if (type) { where += ' AND wa.type = ?'; params.push(type); }
    if (from) { where += ' AND wa.created_at >= ?'; params.push(from); }
    if (to) { where += ' AND wa.created_at <= ?'; params.push(to + ' 23:59:59'); }

    const countRow = await db.get(
      `SELECT COUNT(*) as total FROM wallet_alerts wa
       JOIN watched_wallets ww ON ww.id = wa.wallet_id ${where}`,
      ...params
    );
    const total = countRow ? countRow.total : 0;

    const alerts = await db.all(
      `SELECT wa.*, ww.label as wallet_label
       FROM wallet_alerts wa
       JOIN watched_wallets ww ON ww.id = wa.wallet_id
       ${where} ORDER BY wa.created_at DESC LIMIT ? OFFSET ?`,
      ...params, Number(limit), Number(offset)
    );

    res.json({ alerts, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/alerts/seen', auth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (ids === 'all') {
      await db.run(
        `UPDATE wallet_alerts SET seen = 1
         WHERE wallet_id IN (SELECT id FROM watched_wallets WHERE user_id = ?)`,
        req.user.id
      );
    } else if (Array.isArray(ids)) {
      for (const id of ids) {
        await db.run('UPDATE wallet_alerts SET seen = 1 WHERE id = ?', id);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete all alerts for user
router.delete('/alerts', auth, async (req, res) => {
  try {
    await db.run(
      `DELETE FROM wallet_alerts
       WHERE wallet_id IN (SELECT id FROM watched_wallets WHERE user_id = ?)`,
      req.user.id
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Current positions for all watched wallets
router.get('/positions', auth, async (req, res) => {
  try {
    const positions = await db.all(
      `SELECT wp.*, ww.label as wallet_label, ww.address as wallet_address
       FROM wallet_positions wp
       JOIN watched_wallets ww ON ww.id = wp.wallet_id
       WHERE ww.user_id = ? AND ww.active = 1
       ORDER BY wp.last_seen DESC`,
      req.user.id
    );
    // Filter out resolved positions (not yet redeemed):
    // shares == currentValue means each share = $1 (market resolved)
    // currentValue < 1 means dust/negligible
    const active = positions.filter(p => {
      if (p.current_value < 1) return false;
      if (Math.abs(p.size - p.current_value) < 0.01) return false;
      return true;
    });
    res.json(active);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
