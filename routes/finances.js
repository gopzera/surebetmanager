const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const V = require('../utils/validate');

const router = express.Router();
router.use(auth);

// ===== HELPERS =====

const BR_TZ_OFFSET_MS = -3 * 60 * 60 * 1000;
function brtToday() {
  return new Date(Date.now() + BR_TZ_OFFSET_MS).toISOString().split('T')[0];
}
function brtTodayDate() {
  return new Date(Date.now() + BR_TZ_OFFSET_MS);
}

function monthKey(dateStr) { return dateStr.slice(0, 7); } // YYYY-MM

function weekStartMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().split('T')[0];
}

function clampDayOfMonth(year, month /*1..12*/, day) {
  const last = new Date(year, month, 0).getDate(); // last day of month
  return Math.max(1, Math.min(last, day));
}

// Returns the current period string + computed due_date for an operator.
function currentPeriodFor(op, today /*YYYY-MM-DD*/, defaultPayDay) {
  if (op.payment_type === 'monthly') {
    const period = monthKey(today);
    const [yy, mm] = period.split('-').map(Number);
    const day = clampDayOfMonth(yy, mm, op.custom_payment_day || defaultPayDay || 5);
    const due_date = `${period}-${String(day).padStart(2, '0')}`;
    return { period, due_date };
  }
  if (op.payment_type === 'weekly') {
    const weekStart = weekStartMonday(today); // Monday YYYY-MM-DD
    // custom_payment_day: 0=Sun..6=Sat; offset from Monday (Monday=1 default)
    const dow = (op.custom_payment_day == null) ? 1 : Number(op.custom_payment_day);
    const d = new Date(weekStart + 'T00:00:00');
    // Monday is dow=1. Shift so d = weekStart + (dow - 1) days, with Sunday=+6
    const offset = dow === 0 ? 6 : (dow - 1);
    d.setDate(d.getDate() + offset);
    return { period: weekStart, due_date: d.toISOString().split('T')[0] };
  }
  // one_time — no auto-period; user creates a one-off payment with explicit date
  return { period: null, due_date: null };
}

async function getDefaultPayDay(userId) {
  const u = await db.get('SELECT default_payment_day FROM users WHERE id = ?', userId);
  return Number(u?.default_payment_day) || 5;
}

async function attachOperatorData(op, userId, defaultPayDay, today) {
  // Linked accounts
  const accounts = await db.all(
    `SELECT a.id, a.name, COALESCE(a.hidden,0) as hidden
     FROM operator_accounts oa
     JOIN accounts a ON a.id = oa.account_id
     WHERE oa.operator_id = ?
     ORDER BY a.name`,
    op.id
  );
  op.accounts = accounts;

  // Current-period payment status (monthly/weekly) or upcoming one_time.
  const cur = currentPeriodFor(op, today, defaultPayDay);
  if (cur.period) {
    const pay = await db.get(
      `SELECT * FROM operator_payments WHERE operator_id = ? AND period = ?`,
      op.id, cur.period
    );
    op.current_payment = pay || {
      operator_id: op.id,
      period: cur.period,
      due_date: cur.due_date,
      amount: op.payment_value,
      tip: 0,
      status: 'pending',
    };
  } else {
    // One-time: pick the most recent pending or latest payment
    const pay = await db.get(
      `SELECT * FROM operator_payments
       WHERE operator_id = ?
       ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, due_date DESC, created_at DESC
       LIMIT 1`,
      op.id
    );
    op.current_payment = pay || null;
  }
  return op;
}

function sanitizeReceipt(data, name) {
  if (data == null) return { data: null, name: null };
  if (typeof data !== 'string') return { data: null, name: null };
  // Must be a small data URL. Hard cap ~700KB string (~520KB binary).
  if (data.length > 700000) {
    throw new V.ValidationError('Comprovante muito grande (máx. 500KB)');
  }
  if (!/^data:(image\/|application\/pdf)/i.test(data)) {
    throw new V.ValidationError('Comprovante deve ser imagem ou PDF');
  }
  const safeName = typeof name === 'string' ? name.trim().slice(0, 120) : null;
  return { data, name: safeName || null };
}

// ===== SETTINGS =====

router.get('/settings', async (req, res) => {
  try {
    const u = await db.get(
      'SELECT default_payment_day, notify_operator_payment FROM users WHERE id = ?',
      req.user.id
    );
    res.json({
      default_payment_day: Number(u?.default_payment_day) || 5,
      notify_operator_payment: !!(u && u.notify_operator_payment),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.put('/settings', V.handle(async (req, res) => {
  const day = V.int(req.body.default_payment_day, { min: 1, max: 31, name: 'Dia padrão' });
  const notify = req.body.notify_operator_payment ? 1 : 0;
  await db.run(
    'UPDATE users SET default_payment_day = ?, notify_operator_payment = ? WHERE id = ?',
    day, notify, req.user.id
  );
  res.json({ ok: true });
}));

// ===== OPERATORS =====

router.get('/operators', async (req, res) => {
  try {
    const today = brtToday();
    const defaultPayDay = await getDefaultPayDay(req.user.id);
    const ops = await db.all(
      'SELECT * FROM operators WHERE user_id = ? ORDER BY active DESC, name',
      req.user.id
    );
    for (const op of ops) await attachOperatorData(op, req.user.id, defaultPayDay, today);
    res.json(ops);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.get('/operators/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const op = await db.get('SELECT * FROM operators WHERE id = ? AND user_id = ?', id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operador não encontrado' });
    const defaultPayDay = await getDefaultPayDay(req.user.id);
    await attachOperatorData(op, req.user.id, defaultPayDay, brtToday());
    res.json(op);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.post('/operators', V.handle(async (req, res) => {
  const name = V.str(req.body.name, { min: 1, max: 120, name: 'Nome' });
  const payment_type = V.oneOf(req.body.payment_type || 'monthly', ['monthly', 'weekly', 'one_time'], { name: 'Tipo de pagamento' });
  const payment_value = V.num(req.body.payment_value ?? 0, { min: 0, max: 1_000_000, name: 'Valor' });
  const notes = req.body.notes != null ? V.str(req.body.notes, { max: 2000, name: 'Notas' }) : null;
  const pix_key = req.body.pix_key != null ? V.str(req.body.pix_key, { max: 140, name: 'Chave PIX' }) : null;

  let customDay = null;
  if (req.body.custom_payment_day !== undefined && req.body.custom_payment_day !== null && req.body.custom_payment_day !== '') {
    const maxDay = payment_type === 'weekly' ? 6 : 31;
    const minDay = payment_type === 'weekly' ? 0 : 1;
    customDay = V.int(req.body.custom_payment_day, { min: minDay, max: maxDay, name: 'Dia de pagamento' });
  }

  const accountIds = Array.isArray(req.body.account_ids) ? req.body.account_ids.map(Number).filter(n => Number.isFinite(n)) : [];

  // Check: none of the accounts is already linked to another operator
  if (accountIds.length) {
    // Must belong to this user
    const userAccIds = (await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id)).map(r => r.id);
    for (const accId of accountIds) {
      if (!userAccIds.includes(accId)) {
        return res.status(400).json({ error: `Conta ${accId} não pertence ao usuário` });
      }
      const taken = await db.get(
        `SELECT o.name as op_name FROM operator_accounts oa
         JOIN operators o ON o.id = oa.operator_id
         WHERE oa.account_id = ?`,
        accId
      );
      if (taken) return res.status(400).json({ error: `Conta já linkada ao operador "${taken.op_name}"` });
    }
  }

  const id = await db.transaction(async (tx) => {
    const r = await tx.run(
      `INSERT INTO operators (user_id, name, notes, payment_type, payment_value, custom_payment_day, pix_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, name, notes, payment_type, payment_value, customDay, pix_key
    );
    const newId = r.lastInsertRowid;
    for (const accId of accountIds) {
      await tx.run(
        'INSERT INTO operator_accounts (operator_id, account_id) VALUES (?, ?)',
        newId, accId
      );
    }
    return newId;
  });
  res.json({ id });
}));

router.put('/operators/:id', V.handle(async (req, res) => {
  const id = Number(req.params.id);
  const op = await db.get('SELECT * FROM operators WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!op) return res.status(404).json({ error: 'Operador não encontrado' });

  const name = req.body.name !== undefined ? V.str(req.body.name, { min: 1, max: 120, name: 'Nome' }) : op.name;
  const payment_type = req.body.payment_type !== undefined
    ? V.oneOf(req.body.payment_type, ['monthly', 'weekly', 'one_time'], { name: 'Tipo de pagamento' })
    : op.payment_type;
  const payment_value = req.body.payment_value !== undefined
    ? V.num(req.body.payment_value, { min: 0, max: 1_000_000, name: 'Valor' })
    : op.payment_value;
  const notes = req.body.notes !== undefined
    ? (req.body.notes ? V.str(req.body.notes, { max: 2000, name: 'Notas' }) : null)
    : op.notes;
  const pix_key = req.body.pix_key !== undefined
    ? (req.body.pix_key ? V.str(req.body.pix_key, { max: 140, name: 'Chave PIX' }) : null)
    : op.pix_key;
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : op.active;

  let customDay = op.custom_payment_day;
  if (req.body.custom_payment_day !== undefined) {
    if (req.body.custom_payment_day === null || req.body.custom_payment_day === '') {
      customDay = null;
    } else {
      const maxDay = payment_type === 'weekly' ? 6 : 31;
      const minDay = payment_type === 'weekly' ? 0 : 1;
      customDay = V.int(req.body.custom_payment_day, { min: minDay, max: maxDay, name: 'Dia de pagamento' });
    }
  }

  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE operators SET name=?, notes=?, payment_type=?, payment_value=?, custom_payment_day=?, pix_key=?, active=? WHERE id = ?`,
      name, notes, payment_type, payment_value, customDay, pix_key, active, id
    );

    if (Array.isArray(req.body.account_ids)) {
      const userAccIds = (await tx.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id)).map(r => r.id);
      const cleaned = req.body.account_ids.map(Number).filter(n => Number.isFinite(n) && userAccIds.includes(n));
      // Check uniqueness against OTHER operators
      for (const accId of cleaned) {
        const taken = await tx.get(
          `SELECT o.name as op_name FROM operator_accounts oa
           JOIN operators o ON o.id = oa.operator_id
           WHERE oa.account_id = ? AND oa.operator_id != ?`,
          accId, id
        );
        if (taken) throw new V.ValidationError(`Conta já linkada ao operador "${taken.op_name}"`);
      }
      await tx.run('DELETE FROM operator_accounts WHERE operator_id = ?', id);
      for (const accId of cleaned) {
        await tx.run('INSERT INTO operator_accounts (operator_id, account_id) VALUES (?, ?)', id, accId);
      }
    }
  });
  res.json({ ok: true });
}));

router.delete('/operators/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const op = await db.get('SELECT id FROM operators WHERE id = ? AND user_id = ?', id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operador não encontrado' });
    // Hard delete — payments + account links cascade via FK.
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM operator_payments WHERE operator_id = ?', id);
      await tx.run('DELETE FROM operator_accounts WHERE operator_id = ?', id);
      await tx.run('DELETE FROM operators WHERE id = ?', id);
    });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== AVAILABLE ACCOUNTS =====
// Accounts the user owns that are not linked to any operator (plus accounts
// currently linked to the given operator, so edit modal can keep them).
router.get('/available-accounts', async (req, res) => {
  try {
    const excludeOp = req.query.for_operator ? Number(req.query.for_operator) : null;
    const rows = await db.all(
      `SELECT a.id, a.name, COALESCE(a.hidden, 0) as hidden,
         (SELECT o.name FROM operator_accounts oa
          JOIN operators o ON o.id = oa.operator_id
          WHERE oa.account_id = a.id LIMIT 1) as linked_operator_name,
         (SELECT oa.operator_id FROM operator_accounts oa WHERE oa.account_id = a.id LIMIT 1) as linked_operator_id
       FROM accounts a
       WHERE a.user_id = ? AND a.hidden = 0
       ORDER BY a.name`,
      req.user.id
    );
    const available = rows.map(r => ({
      id: r.id,
      name: r.name,
      linked_operator_name: r.linked_operator_name || null,
      linked_operator_id: r.linked_operator_id || null,
      // Assignable if free, or already linked to the operator we're editing.
      assignable: !r.linked_operator_id || (excludeOp && r.linked_operator_id === excludeOp),
    }));
    res.json(available);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== PAYMENTS =====

router.get('/payments', async (req, res) => {
  try {
    const { operator_id, from, to, status } = req.query;
    let where = 'WHERE p.user_id = ?';
    const params = [req.user.id];
    if (operator_id) { where += ' AND p.operator_id = ?'; params.push(Number(operator_id)); }
    if (from) { where += ' AND COALESCE(p.due_date, p.period) >= ?'; params.push(from); }
    if (to) { where += ' AND COALESCE(p.due_date, p.period) <= ?'; params.push(to); }
    if (status) { where += ' AND p.status = ?'; params.push(status); }
    const rows = await db.all(
      `SELECT p.*, o.name as operator_name, o.payment_type
       FROM operator_payments p
       JOIN operators o ON o.id = p.operator_id
       ${where}
       ORDER BY COALESCE(p.due_date, p.period) DESC, p.created_at DESC`,
      ...params
    );
    // Strip receipt_data in list view to keep payload small
    const light = rows.map(r => {
      const { receipt_data, ...rest } = r;
      return { ...rest, has_receipt: !!receipt_data };
    });
    res.json(light);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.get('/payments/:id', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT p.*, o.name as operator_name FROM operator_payments p
       JOIN operators o ON o.id = p.operator_id
       WHERE p.id = ? AND p.user_id = ?`,
      req.params.id, req.user.id
    );
    if (!row) return res.status(404).json({ error: 'Pagamento não encontrado' });
    res.json(row);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.get('/payments/:id/receipt', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT receipt_data, receipt_name FROM operator_payments WHERE id = ? AND user_id = ?`,
      req.params.id, req.user.id
    );
    if (!row || !row.receipt_data) return res.status(404).json({ error: 'Comprovante não encontrado' });
    res.json({ receipt_data: row.receipt_data, receipt_name: row.receipt_name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// Upsert payment for (operator, period). If id is provided, updates that row.
router.post('/payments', V.handle(async (req, res) => {
  const operator_id = V.int(req.body.operator_id, { min: 1, name: 'Operador' });
  const op = await db.get('SELECT * FROM operators WHERE id = ? AND user_id = ?', operator_id, req.user.id);
  if (!op) return res.status(404).json({ error: 'Operador não encontrado' });

  const period = V.str(req.body.period, { min: 7, max: 10, name: 'Período' });
  const amount = V.num(req.body.amount ?? op.payment_value, { min: 0, max: 1_000_000, name: 'Valor' });
  const tip = V.num(req.body.tip ?? 0, { min: 0, max: 1_000_000, name: 'Gorjeta' });
  const status = V.oneOf(req.body.status || 'pending', ['pending', 'paid', 'skipped'], { name: 'Status' });
  const paid_at = status === 'paid'
    ? (req.body.paid_at ? String(req.body.paid_at).slice(0, 19) : new Date().toISOString().replace('T', ' ').slice(0, 19))
    : null;
  const due_date = req.body.due_date ? String(req.body.due_date).slice(0, 10) : null;
  const notes = req.body.notes ? V.str(req.body.notes, { max: 2000, name: 'Notas' }) : null;
  const { data: receiptData, name: receiptName } = sanitizeReceipt(req.body.receipt_data, req.body.receipt_name);

  // Upsert on (operator_id, period).
  const existing = await db.get(
    'SELECT id, receipt_data, receipt_name FROM operator_payments WHERE operator_id = ? AND period = ?',
    operator_id, period
  );
  if (existing) {
    // Only overwrite receipt if caller sent one; explicit null clears it.
    const clearReceipt = req.body.receipt_data === null;
    const nextReceiptData = receiptData ?? (clearReceipt ? null : existing.receipt_data);
    const nextReceiptName = receiptName ?? (clearReceipt ? null : existing.receipt_name);
    await db.run(
      `UPDATE operator_payments
       SET amount=?, tip=?, status=?, paid_at=?, due_date=?, notes=?, receipt_data=?, receipt_name=?, updated_at=CURRENT_TIMESTAMP
       WHERE id = ?`,
      amount, tip, status, paid_at, due_date, notes, nextReceiptData, nextReceiptName, existing.id
    );
    res.json({ id: existing.id });
  } else {
    const r = await db.run(
      `INSERT INTO operator_payments (user_id, operator_id, period, due_date, amount, tip, status, paid_at, notes, receipt_data, receipt_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, operator_id, period, due_date, amount, tip, status, paid_at, notes, receiptData, receiptName
    );
    res.json({ id: r.lastInsertRowid });
  }
}));

router.put('/payments/:id', V.handle(async (req, res) => {
  const row = await db.get(
    'SELECT * FROM operator_payments WHERE id = ? AND user_id = ?',
    req.params.id, req.user.id
  );
  if (!row) return res.status(404).json({ error: 'Pagamento não encontrado' });

  const amount = req.body.amount !== undefined ? V.num(req.body.amount, { min: 0, max: 1_000_000, name: 'Valor' }) : row.amount;
  const tip = req.body.tip !== undefined ? V.num(req.body.tip, { min: 0, max: 1_000_000, name: 'Gorjeta' }) : row.tip;
  const status = req.body.status !== undefined ? V.oneOf(req.body.status, ['pending', 'paid', 'skipped'], { name: 'Status' }) : row.status;
  const paid_at = req.body.paid_at !== undefined
    ? (req.body.paid_at ? String(req.body.paid_at).slice(0, 19) : null)
    : (status === 'paid' ? (row.paid_at || new Date().toISOString().replace('T', ' ').slice(0, 19)) : null);
  const due_date = req.body.due_date !== undefined ? (req.body.due_date ? String(req.body.due_date).slice(0, 10) : null) : row.due_date;
  const notes = req.body.notes !== undefined ? (req.body.notes ? V.str(req.body.notes, { max: 2000, name: 'Notas' }) : null) : row.notes;

  let receiptData = row.receipt_data;
  let receiptName = row.receipt_name;
  if (req.body.receipt_data === null) {
    receiptData = null; receiptName = null;
  } else if (req.body.receipt_data !== undefined) {
    const s = sanitizeReceipt(req.body.receipt_data, req.body.receipt_name);
    receiptData = s.data; receiptName = s.name;
  }

  await db.run(
    `UPDATE operator_payments SET amount=?, tip=?, status=?, paid_at=?, due_date=?, notes=?, receipt_data=?, receipt_name=?, updated_at=CURRENT_TIMESTAMP
     WHERE id = ?`,
    amount, tip, status, paid_at, due_date, notes, receiptData, receiptName, row.id
  );
  res.json({ ok: true });
}));

router.delete('/payments/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT id FROM operator_payments WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Pagamento não encontrado' });
    await db.run('DELETE FROM operator_payments WHERE id = ?', row.id);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== SUMMARY =====
// Month is YYYY-MM (defaults to current).
router.get('/summary', async (req, res) => {
  try {
    const today = brtToday();
    const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : today.slice(0, 7);
    const monthStart = month + '-01';
    const [yy, mm] = month.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

    const ops = await db.all('SELECT * FROM operators WHERE user_id = ?', req.user.id);
    const active = ops.filter(o => o.active);

    // Estimated average monthly cost = sum(monthly) + sum(weekly × 4.33)
    let avgMonthly = 0;
    for (const o of active) {
      const v = Number(o.payment_value) || 0;
      if (o.payment_type === 'monthly') avgMonthly += v;
      else if (o.payment_type === 'weekly') avgMonthly += v * 4.33;
    }

    // Paid to operators in month (using paid_at when paid, else due_date/period).
    const paidRows = await db.all(
      `SELECT p.amount, p.tip, p.status, p.paid_at, p.due_date, p.period, o.payment_type
       FROM operator_payments p JOIN operators o ON o.id = p.operator_id
       WHERE p.user_id = ? AND (
         (p.status = 'paid' AND substr(p.paid_at, 1, 7) = ?)
         OR (p.status != 'paid' AND COALESCE(p.due_date, p.period) BETWEEN ? AND ?)
       )`,
      req.user.id, month, monthStart, monthEnd
    );
    let paidInMonth = 0;
    let pendingInMonth = 0;
    let tipsInMonth = 0;
    for (const p of paidRows) {
      const total = Number(p.amount || 0) + Number(p.tip || 0);
      if (p.status === 'paid') { paidInMonth += total; tipsInMonth += Number(p.tip || 0); }
      else if (p.status === 'pending') { pendingInMonth += total; }
    }

    // Operations profit in month (uses event_date when set, else BRT-shifted created_at)
    const opsProfit = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as total FROM operations
       WHERE user_id = ? AND COALESCE(event_date, DATE(created_at, '-3 hours')) BETWEEN ? AND ?`,
      req.user.id, monthStart, monthEnd
    );

    // Giros profit in month
    const girosProfit = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as total FROM giros
       WHERE user_id = ? AND DATE(created_at, '-3 hours') BETWEEN ? AND ?`,
      req.user.id, monthStart, monthEnd
    );

    const operationsProfit = Number(opsProfit?.total || 0);
    const girosProfitVal = Number(girosProfit?.total || 0);
    const netProfit = operationsProfit + girosProfitVal - paidInMonth;

    // Pending (overdue) count — due before today, still pending, any operator
    const overdue = await db.get(
      `SELECT COUNT(*) as n FROM operator_payments
       WHERE user_id = ? AND status = 'pending' AND COALESCE(due_date, period) < ?`,
      req.user.id, today
    );

    res.json({
      month,
      operators_total: ops.length,
      operators_active: active.length,
      avg_monthly_cost: avgMonthly,
      paid_in_month: paidInMonth,
      pending_in_month: pendingInMonth,
      tips_in_month: tipsInMonth,
      operations_profit: operationsProfit,
      giros_profit: girosProfitVal,
      net_profit: netProfit,
      overdue_count: Number(overdue?.n || 0),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== CSV EXPORT =====
router.get('/export.csv', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT p.id, p.period, p.due_date, p.amount, p.tip, p.status, p.paid_at, p.notes, p.receipt_data,
              o.name as operator_name, o.payment_type, o.payment_value as operator_payment_value,
              (SELECT GROUP_CONCAT(a.name, ', ')
               FROM operator_accounts oa JOIN accounts a ON a.id = oa.account_id
               WHERE oa.operator_id = o.id) as accounts
       FROM operator_payments p
       JOIN operators o ON o.id = p.operator_id
       WHERE p.user_id = ?
       ORDER BY COALESCE(p.due_date, p.period) DESC`,
      req.user.id
    );
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const header = ['id', 'operador', 'contas', 'tipo_pagamento', 'periodo', 'data_vencimento', 'valor', 'gorjeta', 'total', 'status', 'pago_em', 'tem_comprovante', 'notas'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const total = Number(r.amount || 0) + Number(r.tip || 0);
      lines.push([
        r.id,
        r.operator_name,
        r.accounts || '',
        r.payment_type,
        r.period,
        r.due_date || '',
        Number(r.amount || 0).toFixed(2),
        Number(r.tip || 0).toFixed(2),
        total.toFixed(2),
        r.status,
        r.paid_at || '',
        r.receipt_data ? 'sim' : 'não',
        r.notes || '',
      ].map(esc).join(','));
    }
    const csv = '\uFEFF' + lines.join('\n'); // BOM for Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="financas.csv"');
    res.send(csv);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== CRON: payment reminders =====
// Inserts a notification for each operator whose payment is due today
// (monthly/weekly), if one hasn't already been posted this period.
router.get('/cron-remind', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const users = await db.all(
      'SELECT id, default_payment_day, notify_operator_payment FROM users WHERE notify_operator_payment = 1'
    );
    let inserted = 0;
    const today = brtToday();
    for (const u of users) {
      const ops = await db.all(
        'SELECT * FROM operators WHERE user_id = ? AND active = 1',
        u.id
      );
      for (const op of ops) {
        if (op.payment_type === 'one_time') continue;
        const { period, due_date } = currentPeriodFor(op, today, u.default_payment_day || 5);
        if (!due_date || due_date > today) continue;
        // Skip if already paid/skipped
        const existing = await db.get(
          'SELECT status FROM operator_payments WHERE operator_id = ? AND period = ?',
          op.id, period
        );
        if (existing && existing.status !== 'pending') continue;
        // Skip if we already posted a notification this period
        const existingNotif = await db.get(
          `SELECT id FROM notifications
           WHERE user_id = ? AND type = 'operator_payment_due'
             AND json_extract(data, '$.operator_id') = ?
             AND json_extract(data, '$.period') = ?`,
          u.id, op.id, period
        );
        if (existingNotif) continue;

        const amount = Number(op.payment_value) || 0;
        await db.run(
          `INSERT INTO notifications (user_id, category, type, title, body, data)
           VALUES (?, 'general', 'operator_payment_due', ?, ?, ?)`,
          u.id,
          `Pagamento do operador: ${op.name}`,
          `Pagamento de R$ ${amount.toFixed(2)} venceu em ${due_date}`,
          JSON.stringify({ operator_id: op.id, period, due_date, amount })
        );
        inserted++;
      }
    }
    res.json({ ok: true, inserted });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

module.exports = router;
