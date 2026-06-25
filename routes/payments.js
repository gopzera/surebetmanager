const express = require('express');
const auth = require('../middleware/auth');
const db = require('../db/database');
const { computeAccess, parseUtc } = require('../middleware/requireAccess');

const router = express.Router();

// Mercado Pago Checkout Pro. Access token via env (sandbox works). Prices/durations
// are env-configurable (MONTHLY_PRICE/ANNUAL_PRICE) and default to R$30 / R$300.
const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const PLANS = {
  monthly: { days: 30, price: Number(process.env.MONTHLY_PRICE) || 30, title: 'Surebet Manager — Mensal' },
  annual: { days: 365, price: Number(process.env.ANNUAL_PRICE) || 300, title: 'Surebet Manager — Anual' },
};

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// Plans + whether payments are enabled (reachable by blocked users — auth only).
router.get('/plans', auth, (req, res) => {
  res.json({
    enabled: !!MP_TOKEN,
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, days: p.days, price: p.price, title: p.title })),
  });
});

// Create a Checkout Pro preference for the chosen plan and return the redirect URL.
// Auth only (NOT requireAccess) — blocked users must be able to start a payment.
router.post('/checkout', auth, async (req, res) => {
  try {
    if (!MP_TOKEN) return res.status(503).json({ error: 'Pagamentos não configurados.' });
    const planId = PLANS[req.body.plan] ? req.body.plan : null;
    if (!planId) return res.status(400).json({ error: 'Plano inválido' });
    const plan = PLANS[planId];

    const r = await db.run(
      "INSERT INTO payments (user_id, plan, amount, currency, status) VALUES (?, ?, ?, 'BRL', 'pending')",
      req.user.id, planId, plan.price
    );
    const paymentId = Number(r.lastInsertRowid);
    const base = baseUrl(req);

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ title: plan.title, quantity: 1, unit_price: plan.price, currency_id: 'BRL' }],
        external_reference: String(paymentId),
        metadata: { user_id: req.user.id, plan: planId, payment_id: paymentId },
        notification_url: `${base}/api/payments/webhook`,
        back_urls: { success: `${base}/?paid=1`, failure: `${base}/?paid=0`, pending: `${base}/?paid=pending` },
        auto_return: 'approved',
      }),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok) { console.error('[payments] MP preference error', mpData); return res.status(502).json({ error: 'Erro ao criar pagamento' }); }

    await db.run('UPDATE payments SET mp_preference_id = ?, external_reference = ? WHERE id = ?', mpData.id, String(paymentId), paymentId);
    const initPoint = process.env.NODE_ENV === 'production'
      ? mpData.init_point
      : (mpData.sandbox_init_point || mpData.init_point);
    res.json({ init_point: initPoint, preference_id: mpData.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Current access state + last payment (auth only).
router.get('/status', auth, async (req, res) => {
  try {
    const user = await db.get('SELECT is_admin, access_status, license_expires_at, license_plan FROM users WHERE id = ?', req.user.id);
    const last = await db.get('SELECT plan, amount, status, created_at, approved_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', req.user.id);
    res.json({ ...computeAccess(user || {}), last_payment: last || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Mercado Pago webhook (public + CSRF-exempt — see middleware/csrf.js). Acks fast,
// then fetches the payment from MP (authoritative) and, if approved, extends the
// user's license. Idempotent: re-delivery of the same approved payment is a no-op.
async function webhookHandler(req, res) {
  res.json({ received: true });
  try {
    if (!MP_TOKEN) return;
    const paymentMpId = req.query['data.id'] || (req.body && req.body.data && req.body.data.id) || req.query.id || (req.body && req.body.id);
    const topic = req.query.type || req.query.topic || (req.body && req.body.type);
    if (!paymentMpId || (topic && topic !== 'payment')) return;

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentMpId}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    const pay = await mpRes.json();
    if (!mpRes.ok || pay.status !== 'approved') return;

    const row = await db.get('SELECT * FROM payments WHERE id = ?', Number(pay.external_reference));
    if (!row) return;
    if (row.status === 'approved' && row.mp_payment_id === String(paymentMpId)) return; // already processed
    const plan = PLANS[row.plan];
    if (!plan) return;

    await db.transaction(async (tx) => {
      await tx.run(
        "UPDATE payments SET status='approved', mp_payment_id=?, approved_at=CURRENT_TIMESTAMP WHERE id=?",
        String(paymentMpId), row.id
      );
      const user = await tx.get('SELECT license_expires_at FROM users WHERE id=?', row.user_id);
      const cur = parseUtc(user && user.license_expires_at);
      const base = cur && cur.getTime() > Date.now() ? cur.getTime() : Date.now();
      const newExp = new Date(base + plan.days * 86400000).toISOString();
      await tx.run("UPDATE users SET access_status='active', license_expires_at=?, license_plan=? WHERE id=?", newExp, row.plan, row.user_id);
    });
    console.log('[payments] approved → license extended for user', row.user_id, 'plan', row.plan);
  } catch (e) {
    console.error('[payments webhook]', e && e.message);
  }
}

router.post('/webhook', webhookHandler);

module.exports = router;
module.exports.webhookHandler = webhookHandler;
module.exports.PLANS = PLANS;
