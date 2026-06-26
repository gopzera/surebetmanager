const express = require('express');
const auth = require('../middleware/auth');
const db = require('../db/database');
const { computeAccess, parseUtc } = require('../middleware/requireAccess');

const router = express.Router();

// Mercado Pago. Two ways to license:
//  - oneoff       → Checkout Pro preference (pay once, get N days).
//  - subscription → Preapproval (recurring auto-charge every period; auto-renews).
// Access is granted by TWO independent paths so a missed/blocked webhook never
// strands a paid user: (1) the webhook, and (2) active reconciliation (POST
// /reconcile) which pulls the authoritative status straight from MP when the user
// returns from checkout. Both funnel through the same idempotent apply* helpers.
const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const PLANS = {
  monthly: { days: 30, months: 1, price: Number(process.env.MONTHLY_PRICE) || 30, title: 'Surebet Manager — Mensal' },
  annual: { days: 365, months: 12, price: Number(process.env.ANNUAL_PRICE) || 300, title: 'Surebet Manager — Anual' },
};

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function mpGet(path) {
  const r = await fetch(`https://api.mercadopago.com${path}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
  const data = await r.json();
  return { ok: r.ok, data };
}

// Add `days` to a user's license, stacking from max(now, current expiry).
async function extendLicense(tx, userId, plan, planDays) {
  const user = await tx.get('SELECT license_expires_at FROM users WHERE id=?', userId);
  const cur = parseUtc(user && user.license_expires_at);
  const base = cur && cur.getTime() > Date.now() ? cur.getTime() : Date.now();
  const newExp = new Date(base + planDays * 86400000).toISOString();
  await tx.run("UPDATE users SET access_status='active', license_expires_at=?, license_plan=? WHERE id=?", newExp, plan, userId);
}

// Apply an approved one-off Checkout Pro payment. Idempotent: a row already marked
// approved with the same MP payment id is a no-op. Returns true if it credited.
async function applyOneoff(row, mpPaymentId) {
  if (row.status === 'approved' && row.mp_payment_id === String(mpPaymentId)) return false;
  const plan = PLANS[row.plan];
  if (!plan) return false;
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE payments SET status='approved', mp_payment_id=?, approved_at=CURRENT_TIMESTAMP WHERE id=?",
      String(mpPaymentId), row.id
    );
    await extendLicense(tx, row.user_id, row.plan, plan.days);
  });
  console.log('[payments] one-off approved → license extended for user', row.user_id, 'plan', row.plan);
  return true;
}

// Drive a subscription's license off the preapproval's authoritative paid-through
// date (next_payment_date). This grants access the moment the subscription becomes
// 'authorized' — without waiting for the first charge to finish processing (which
// can lag past the return-to-site polling window) — and naturally advances on each
// renewal. Idempotent: it only ever moves the expiry forward. A few days of grace
// are added so renewal processing never momentarily locks the user out.
const SUB_GRACE_DAYS = 3;
async function syncSubscriptionAccess(sub, pre) {
  if (!pre || !pre.status) return false;
  if (pre.status !== 'authorized') {
    await db.run("UPDATE subscriptions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", pre.status, sub.id);
    return false;
  }
  const plan = PLANS[sub.plan];
  if (!plan) return false;
  const np = parseUtc(pre.next_payment_date);
  const target = (np ? np.getTime() : Date.now() + plan.days * 86400000) + SUB_GRACE_DAYS * 86400000;
  let changed = false;
  await db.transaction(async (tx) => {
    await tx.run("UPDATE subscriptions SET status='authorized', updated_at=CURRENT_TIMESTAMP WHERE id=?", sub.id);
    const u = await tx.get('SELECT access_status, license_expires_at FROM users WHERE id=?', sub.user_id);
    const cur = parseUtc(u && u.license_expires_at);
    const newExp = Math.max(cur ? cur.getTime() : 0, target);
    if (!u || u.access_status !== 'active' || !cur || newExp > cur.getTime()) {
      await tx.run("UPDATE users SET access_status='active', license_expires_at=?, license_plan=? WHERE id=?", new Date(newExp).toISOString(), sub.plan, sub.user_id);
      changed = true;
    }
  });
  if (changed) console.log('[payments] subscription authorized → access until', new Date(target).toISOString(), 'user', sub.user_id);
  return changed;
}

// Record a processed recurring charge for history/audit (license itself is driven by
// syncSubscriptionAccess). Idempotent via UNIQUE mp_payment_id.
async function recordAuthorizedPayment(sub, ap) {
  const plan = PLANS[sub.plan];
  const payKey = String((ap.payment && ap.payment.id) || ap.id);
  await db.run(
    "INSERT OR IGNORE INTO payments (user_id, plan, amount, currency, status, mp_payment_id, external_reference, approved_at) VALUES (?, ?, ?, 'BRL', 'approved', ?, ?, CURRENT_TIMESTAMP)",
    sub.user_id, sub.plan, plan ? plan.price : 0, payKey, 'sub_' + sub.id
  );
}

// Plans + whether payments are enabled (reachable by blocked users — auth only).
router.get('/plans', auth, (req, res) => {
  res.json({
    enabled: !!MP_TOKEN,
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, days: p.days, price: p.price, title: p.title })),
  });
});

// Start a payment for the chosen plan. `mode`: 'oneoff' (Checkout Pro, default) or
// 'subscription' (recurring preapproval — requires payer email). Auth only (NOT
// requireAccess) — blocked users must be able to start a payment.
router.post('/checkout', auth, async (req, res) => {
  try {
    if (!MP_TOKEN) return res.status(503).json({ error: 'Pagamentos não configurados.' });
    const planId = PLANS[req.body.plan] ? req.body.plan : null;
    if (!planId) return res.status(400).json({ error: 'Plano inválido' });
    const plan = PLANS[planId];
    const mode = req.body.mode === 'subscription' ? 'subscription' : 'oneoff';
    const base = baseUrl(req);

    if (mode === 'subscription') {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Informe o e-mail da sua conta Mercado Pago.' });

      const sub = await db.run(
        "INSERT INTO subscriptions (user_id, plan, payer_email, status) VALUES (?, ?, ?, 'pending')",
        req.user.id, planId, email
      );
      const subId = Number(sub.lastInsertRowid);

      const mpRes = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: plan.title,
          external_reference: 'sub_' + subId,
          payer_email: email,
          back_url: `${base}/?paid=1`,
          notification_url: `${base}/api/payments/webhook`,
          auto_recurring: {
            frequency: plan.months,
            frequency_type: 'months',
            transaction_amount: plan.price,
            currency_id: 'BRL',
          },
          // NOTE: do NOT send status:'pending' — MP returns HTTP 500 when it's set
          // explicitly on a checkout-flow preapproval. Omitting it defaults to
          // pending and returns the init_point for the subscriber to authorize.
        }),
      });
      const mpData = await mpRes.json();
      if (!mpRes.ok) { console.error('[payments] MP preapproval error', mpData); return res.status(502).json({ error: 'Erro ao criar assinatura' }); }

      await db.run('UPDATE subscriptions SET mp_preapproval_id = ? WHERE id = ?', mpData.id, subId);
      return res.json({ init_point: mpData.init_point, preapproval_id: mpData.id, mode });
    }

    // oneoff → Checkout Pro preference
    const r = await db.run(
      "INSERT INTO payments (user_id, plan, amount, currency, status) VALUES (?, ?, ?, 'BRL', 'pending')",
      req.user.id, planId, plan.price
    );
    const paymentId = Number(r.lastInsertRowid);
    const ref = 'pay_' + paymentId;

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ title: plan.title, quantity: 1, unit_price: plan.price, currency_id: 'BRL' }],
        external_reference: ref,
        metadata: { user_id: req.user.id, plan: planId, payment_id: paymentId },
        notification_url: `${base}/api/payments/webhook`,
        back_urls: { success: `${base}/?paid=1`, failure: `${base}/?paid=0`, pending: `${base}/?paid=pending` },
        auto_return: 'approved',
      }),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok) { console.error('[payments] MP preference error', mpData); return res.status(502).json({ error: 'Erro ao criar pagamento' }); }

    await db.run('UPDATE payments SET mp_preference_id = ?, external_reference = ? WHERE id = ?', mpData.id, ref, paymentId);
    const initPoint = process.env.NODE_ENV === 'production'
      ? mpData.init_point
      : (mpData.sandbox_init_point || mpData.init_point);
    res.json({ init_point: initPoint, preference_id: mpData.id, mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Active reconciliation: pull the authoritative status from MP for THIS user's
// pending payments/subscriptions and grant access if approved. Webhook-independent
// (works even when the deployment is behind auth and MP can't reach the webhook).
// Auth only — reachable by blocked users returning from checkout.
router.post('/reconcile', auth, async (req, res) => {
  try {
    if (!MP_TOKEN) return res.json({ changed: false, ...computeAccess({}) });
    let changed = false;

    const pend = await db.all("SELECT * FROM payments WHERE user_id=? AND status='pending'", req.user.id);
    for (const row of pend) {
      const s = await mpGet(`/v1/payments/search?external_reference=${encodeURIComponent('pay_' + row.id)}`);
      const results = (s.ok && s.data && s.data.results) || [];
      const approved = results.find(r => r.status === 'approved');
      if (approved && await applyOneoff(row, approved.id)) changed = true;
    }

    const subs = await db.all("SELECT * FROM subscriptions WHERE user_id=? AND mp_preapproval_id IS NOT NULL AND status != 'cancelled'", req.user.id);
    for (const sub of subs) {
      const pre = await mpGet(`/preapproval/${sub.mp_preapproval_id}`);
      if (!pre.ok || !pre.data || !pre.data.status) continue;
      if (await syncSubscriptionAccess(sub, pre.data)) changed = true;
      if (pre.data.status === 'authorized') {
        const ap = await mpGet(`/authorized_payments/search?preapproval_id=${sub.mp_preapproval_id}`);
        const results = (ap.ok && ap.data && ap.data.results) || [];
        for (const r of results) {
          if (r.status === 'processed' || (r.payment && r.payment.status === 'approved')) await recordAuthorizedPayment(sub, r);
        }
      }
    }

    const user = await db.get('SELECT is_admin, access_status, license_expires_at, license_plan FROM users WHERE id = ?', req.user.id);
    res.json({ changed, ...computeAccess(user || {}) });
  } catch (err) {
    console.error('[payments reconcile]', err && err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Current access state + last payment + active subscription (auth only).
router.get('/status', auth, async (req, res) => {
  try {
    const user = await db.get('SELECT is_admin, access_status, license_expires_at, license_plan FROM users WHERE id = ?', req.user.id);
    const last = await db.get('SELECT plan, amount, status, created_at, approved_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', req.user.id);
    const sub = await db.get("SELECT plan, status, mp_preapproval_id, created_at FROM subscriptions WHERE user_id = ? AND status = 'authorized' ORDER BY created_at DESC LIMIT 1", req.user.id);
    res.json({ ...computeAccess(user || {}), last_payment: last || null, subscription: sub || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Mercado Pago webhook (public + CSRF-exempt — see middleware/csrf.js). Acks fast,
// then fetches the resource from MP (authoritative — never trusts the body) and acts:
//  - payment                         → one-off Checkout Pro (external_reference pay_*).
//  - subscription_authorized_payment → a recurring charge cleared.
//  - subscription_preapproval        → subscription created/updated: sync its status.
async function webhookHandler(req, res) {
  res.json({ received: true });
  try {
    if (!MP_TOKEN) return;
    const topic = req.query.type || req.query.topic || (req.body && req.body.type) || (req.body && req.body.action && String(req.body.action).split('.')[0]);
    const resourceId = req.query['data.id'] || (req.body && req.body.data && req.body.data.id) || req.query.id || (req.body && req.body.id);
    if (!resourceId) return;

    if (topic === 'subscription_preapproval' || topic === 'preapproval') return syncPreapproval(resourceId);
    if (topic === 'subscription_authorized_payment') return creditAuthorizedPayment(resourceId);
    if (topic === 'payment') return creditOneoffPayment(resourceId);
  } catch (e) {
    console.error('[payments webhook]', e && e.message);
  }
}

// One-off Checkout Pro payment → find our payments row by external_reference (pay_*).
async function creditOneoffPayment(paymentMpId) {
  const { ok, data: pay } = await mpGet(`/v1/payments/${paymentMpId}`);
  if (!ok || pay.status !== 'approved') return;
  const ref = String(pay.external_reference || '');
  if (!ref.startsWith('pay_')) return; // a subscription's recurring payment — handled via authorized_payment
  const row = await db.get('SELECT * FROM payments WHERE id = ?', Number(ref.slice(4)));
  if (row) await applyOneoff(row, paymentMpId);
}

// Recurring charge cleared → record it and re-sync the subscription's paid-through date.
async function creditAuthorizedPayment(authorizedPaymentId) {
  const { ok, data: ap } = await mpGet(`/authorized_payments/${authorizedPaymentId}`);
  if (!ok || !ap.preapproval_id) return;
  const sub = await db.get('SELECT * FROM subscriptions WHERE mp_preapproval_id = ?', String(ap.preapproval_id));
  if (!sub) return;
  if (ap.status === 'processed' || (ap.payment && ap.payment.status === 'approved')) await recordAuthorizedPayment(sub, ap);
  const pre = await mpGet(`/preapproval/${ap.preapproval_id}`);
  if (pre.ok) await syncSubscriptionAccess(sub, pre.data);
}

// Subscription lifecycle (authorized/paused/cancelled) → sync status + access.
async function syncPreapproval(preapprovalId) {
  const { ok, data: pre } = await mpGet(`/preapproval/${preapprovalId}`);
  if (!ok || !pre.status) return;
  const sub = await db.get('SELECT * FROM subscriptions WHERE mp_preapproval_id = ?', String(preapprovalId));
  if (sub) await syncSubscriptionAccess(sub, pre);
  else await db.run("UPDATE subscriptions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE mp_preapproval_id=?", pre.status, String(preapprovalId));
  console.log('[payments] preapproval', preapprovalId, '→ status', pre.status);
}

router.post('/webhook', webhookHandler);

module.exports = router;
module.exports.webhookHandler = webhookHandler;
module.exports.PLANS = PLANS;
