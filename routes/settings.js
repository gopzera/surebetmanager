const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Get Polymarket wallet + notification preferences
router.get('/poly', async (req, res) => {
  try {
    const user = await db.get(
      `SELECT poly_wallet_address, notify_fill_order, notify_fill_limit_order, notify_redeem
       FROM users WHERE id = ?`,
      req.user.id
    );
    res.json({
      poly_wallet_address: user?.poly_wallet_address || '',
      notify_fill_order: !!(user && user.notify_fill_order),
      notify_fill_limit_order: !!(user && user.notify_fill_limit_order),
      notify_redeem: !!(user && user.notify_redeem),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.put('/poly', async (req, res) => {
  try {
    const { poly_wallet_address, notify_fill_order, notify_fill_limit_order, notify_redeem } = req.body;
    let addr = (poly_wallet_address || '').trim().toLowerCase();
    if (addr && !/^0x[a-f0-9]{40}$/i.test(addr)) {
      return res.status(400).json({ error: 'Endereço inválido (deve ser 0x... com 42 caracteres)' });
    }
    if (!addr) addr = null;
    await db.run(
      `UPDATE users SET
         poly_wallet_address = ?,
         notify_fill_order = ?,
         notify_fill_limit_order = ?,
         notify_redeem = ?
       WHERE id = ?`,
      addr,
      notify_fill_order ? 1 : 0,
      notify_fill_limit_order ? 1 : 0,
      notify_redeem ? 1 : 0,
      req.user.id
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
