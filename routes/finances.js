const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const V = require('../utils/validate');
const { attachMany, attachScalars } = require('../utils/batch');

const router = express.Router();
router.use(auth);

// ===== HELPERS =====

const BR_TZ_OFFSET_MS = -3 * 60 * 60 * 1000;
function brtToday() {
  return new Date(Date.now() + BR_TZ_OFFSET_MS).toISOString().split('T')[0];
}

function monthKey(dateStr) { return dateStr.slice(0, 7); } // YYYY-MM

function weekStartMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().split('T')[0];
}

function clampDayOfMonth(year, month /*1..12*/, day) {
  const last = new Date(year, month, 0).getDate();
  return Math.max(1, Math.min(last, day));
}

// Returns the current period string + computed due_date for an operator.
function currentPeriodFor(op, today, defaultPayDay) {
  if (op.payment_type === 'monthly') {
    const period = monthKey(today);
    const [yy, mm] = period.split('-').map(Number);
    const day = clampDayOfMonth(yy, mm, op.custom_payment_day || defaultPayDay || 5);
    const due_date = `${period}-${String(day).padStart(2, '0')}`;
    return { period, due_date };
  }
  if (op.payment_type === 'weekly') {
    const weekStart = weekStartMonday(today);
    const dow = (op.custom_payment_day == null) ? 1 : Number(op.custom_payment_day);
    const d = new Date(weekStart + 'T00:00:00');
    const offset = dow === 0 ? 6 : (dow - 1);
    d.setDate(d.getDate() + offset);
    return { period: weekStart, due_date: d.toISOString().split('T')[0] };
  }
  return { period: null, due_date: null };
}

async function getDefaultPayDay(userId) {
  const u = await db.get('SELECT default_payment_day FROM users WHERE id = ?', userId);
  return Number(u?.default_payment_day) || 5;
}

// Auto-insert pending payment row for the operator's current period if none exists.
// Called on GET /operators so the UI always has a tangible row to act on.
async function ensurePendingPayment(op, userId, defaultPayDay, today) {
  if (!op.active || op.payment_type === 'one_time') return null;
  const cur = currentPeriodFor(op, today, defaultPayDay);
  if (!cur.period) return null;
  const existing = await db.get(
    'SELECT * FROM operator_payments WHERE operator_id = ? AND period = ?',
    op.id, cur.period
  );
  if (existing) return existing;
  // Create pending row so it's visible in history/filters even before user acts.
  const r = await db.run(
    `INSERT INTO operator_payments (user_id, operator_id, period, due_date, amount, tip, status)
     VALUES (?, ?, ?, ?, ?, 0, 'pending')`,
    userId, op.id, cur.period, cur.due_date, Number(op.payment_value) || 0
  );
  await auditLog(userId, op.id, r.lastInsertRowid, 'payment', 'auto_created', {
    period: cur.period, due_date: cur.due_date, amount: op.payment_value,
  });
  return await db.get('SELECT * FROM operator_payments WHERE id = ?', r.lastInsertRowid);
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = new Set();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase().slice(0, 32);
    if (t && /^[a-z0-9áéíóúâêîôûãõçà_\- ]+$/i.test(t)) out.add(t);
  }
  return [...out].slice(0, 20);
}

// Batch-attach accounts + tags for a list of operators in two queries (was N+1).
async function attachOperatorAccountsAndTags(operators) {
  await attachMany(operators, {
    sql: `SELECT oa.operator_id, a.id, a.name, COALESCE(a.hidden,0) as hidden
          FROM operator_accounts oa
          JOIN accounts a ON a.id = oa.account_id
          WHERE oa.operator_id IN ({{IN}})
          ORDER BY a.name`,
    foreignKey: 'operator_id',
    attachAs: 'accounts',
    map: r => ({ id: r.id, name: r.name, hidden: r.hidden }),
  });
  await attachScalars(operators, {
    sql: `SELECT operator_id, tag FROM operator_tags
          WHERE operator_id IN ({{IN}}) ORDER BY tag`,
    foreignKey: 'operator_id',
    valueKey: 'tag',
    attachAs: 'tags',
  });
}

// Per-operator: auto-create pending row + resolve current_payment.
// ensurePendingPayment writes, so it has to run per-operator sequentially.
async function attachOperatorData(op, userId, defaultPayDay, today) {
  await ensurePendingPayment(op, userId, defaultPayDay, today);
  const cur = currentPeriodFor(op, today, defaultPayDay);
  if (cur.period) {
    op.current_payment = await db.get(
      `SELECT * FROM operator_payments WHERE operator_id = ? AND period = ?`,
      op.id, cur.period
    );
  } else {
    op.current_payment = await db.get(
      `SELECT * FROM operator_payments
       WHERE operator_id = ?
       ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, due_date DESC, created_at DESC
       LIMIT 1`,
      op.id
    );
  }
  if (op.current_payment) {
    op.current_payment.has_receipt = !!(op.current_payment.receipt_data || op.current_payment.receipt_blob_id);
    delete op.current_payment.receipt_data;
  }
  return op;
}

// ===== AUDIT =====

async function auditLog(userId, operatorId, paymentId, entity, action, details) {
  try {
    await db.run(
      `INSERT INTO operator_audit (user_id, operator_id, payment_id, entity, action, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId, operatorId || null, paymentId || null, entity, action,
      details ? JSON.stringify(details) : null
    );
  } catch (e) { /* never block the main op on audit failure */ }
}

// ===== RECEIPT BLOB HELPERS =====

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.*)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!/^image\//.test(mime) && mime !== 'application/pdf') return null;
  const buffer = Buffer.from(m[2], 'base64');
  return { mime, buffer, size: buffer.length };
}

// Up to 5 MB binary (≈6.7 MB base64 over the wire — app.js raises /api/finances limit).
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

async function storeReceiptBlob(userId, dataUrl, fileName) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new V.ValidationError('Comprovante deve ser imagem ou PDF em formato data URL');
  if (parsed.size > MAX_RECEIPT_BYTES) throw new V.ValidationError('Comprovante muito grande (máx. 5MB)');
  const safeName = (typeof fileName === 'string' ? fileName.trim().slice(0, 120) : '') || null;
  const r = await db.run(
    `INSERT INTO receipt_blobs (user_id, mime_type, file_name, size_bytes, data)
     VALUES (?, ?, ?, ?, ?)`,
    userId, parsed.mime, safeName, parsed.size, parsed.buffer
  );
  return { id: r.lastInsertRowid, mime_type: parsed.mime, file_name: safeName, size_bytes: parsed.size };
}

async function deleteReceiptBlob(blobId, userId) {
  if (!blobId) return;
  await db.run('DELETE FROM receipt_blobs WHERE id = ? AND user_id = ?', blobId, userId);
}

// ===== SETTINGS =====

router.get('/settings', async (req, res) => {
  try {
    const u = await db.get(
      'SELECT default_payment_day, notify_operator_payment, dash_include_operators FROM users WHERE id = ?',
      req.user.id
    );
    res.json({
      default_payment_day: Number(u?.default_payment_day) || 5,
      notify_operator_payment: !!(u && u.notify_operator_payment),
      dash_include_operators: !!(u && u.dash_include_operators),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.put('/settings', V.handle(async (req, res) => {
  const day = V.int(req.body.default_payment_day, { min: 1, max: 31, name: 'Dia padrão' });
  const notify = req.body.notify_operator_payment ? 1 : 0;
  const dashInclude = req.body.dash_include_operators ? 1 : 0;
  await db.run(
    'UPDATE users SET default_payment_day = ?, notify_operator_payment = ?, dash_include_operators = ? WHERE id = ?',
    day, notify, dashInclude, req.user.id
  );
  res.json({ ok: true });
}));

// ===== TAGS =====

router.get('/tags', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT DISTINCT ot.tag FROM operator_tags ot
       JOIN operators o ON o.id = ot.operator_id
       WHERE o.user_id = ? ORDER BY ot.tag`,
      req.user.id
    );
    res.json(rows.map(r => r.tag));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== OPERATORS =====

router.get('/operators', async (req, res) => {
  try {
    const today = brtToday();
    const defaultPayDay = await getDefaultPayDay(req.user.id);
    const tag = (req.query.tag || '').trim().toLowerCase();

    let sql = 'SELECT * FROM operators WHERE user_id = ?';
    const params = [req.user.id];
    if (tag) {
      sql += ` AND id IN (SELECT operator_id FROM operator_tags WHERE tag = ?)`;
      params.push(tag);
    }
    sql += ' ORDER BY active DESC, name';
    const ops = await db.all(sql, ...params);
    await attachOperatorAccountsAndTags(ops);
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
    await attachOperatorAccountsAndTags([op]);
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
  const tags = sanitizeTags(req.body.tags);

  let customDay = null;
  if (req.body.custom_payment_day !== undefined && req.body.custom_payment_day !== null && req.body.custom_payment_day !== '') {
    const maxDay = payment_type === 'weekly' ? 6 : 31;
    const minDay = payment_type === 'weekly' ? 0 : 1;
    customDay = V.int(req.body.custom_payment_day, { min: minDay, max: maxDay, name: 'Dia de pagamento' });
  }

  const accountIds = Array.isArray(req.body.account_ids) ? req.body.account_ids.map(Number).filter(n => Number.isFinite(n)) : [];

  if (accountIds.length) {
    const userAccIds = (await db.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id)).map(r => r.id);
    for (const accId of accountIds) {
      if (!userAccIds.includes(accId)) return res.status(400).json({ error: `Conta ${accId} não pertence ao usuário` });
      const taken = await db.get(
        `SELECT o.name as op_name FROM operator_accounts oa
         JOIN operators o ON o.id = oa.operator_id WHERE oa.account_id = ?`,
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
      await tx.run('INSERT INTO operator_accounts (operator_id, account_id) VALUES (?, ?)', newId, accId);
    }
    for (const t of tags) {
      await tx.run('INSERT OR IGNORE INTO operator_tags (operator_id, tag) VALUES (?, ?)', newId, t);
    }
    return newId;
  });
  await auditLog(req.user.id, id, null, 'operator', 'created', {
    name, payment_type, payment_value, account_ids: accountIds, tags,
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

  // Build a before/after diff for audit. Only record fields that actually changed.
  const before = {};
  const after = {};
  const fields = { name, payment_type, payment_value, notes, pix_key, active, custom_payment_day: customDay };
  for (const [k, v] of Object.entries(fields)) {
    if (op[k] !== v && !(op[k] == null && v == null)) { before[k] = op[k]; after[k] = v; }
  }

  let accountsChanged = null;
  let tagsChanged = null;

  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE operators SET name=?, notes=?, payment_type=?, payment_value=?, custom_payment_day=?, pix_key=?, active=? WHERE id = ?`,
      name, notes, payment_type, payment_value, customDay, pix_key, active, id
    );

    if (Array.isArray(req.body.account_ids)) {
      const userAccIds = (await tx.all('SELECT id FROM accounts WHERE user_id = ?', req.user.id)).map(r => r.id);
      const cleaned = req.body.account_ids.map(Number).filter(n => Number.isFinite(n) && userAccIds.includes(n));
      for (const accId of cleaned) {
        const taken = await tx.get(
          `SELECT o.name as op_name FROM operator_accounts oa
           JOIN operators o ON o.id = oa.operator_id
           WHERE oa.account_id = ? AND oa.operator_id != ?`,
          accId, id
        );
        if (taken) throw new V.ValidationError(`Conta já linkada ao operador "${taken.op_name}"`);
      }
      const prev = (await tx.all('SELECT account_id FROM operator_accounts WHERE operator_id = ?', id)).map(r => r.account_id);
      await tx.run('DELETE FROM operator_accounts WHERE operator_id = ?', id);
      for (const accId of cleaned) {
        await tx.run('INSERT INTO operator_accounts (operator_id, account_id) VALUES (?, ?)', id, accId);
      }
      accountsChanged = { before: prev, after: cleaned };
    }

    if (Array.isArray(req.body.tags)) {
      const nextTags = sanitizeTags(req.body.tags);
      const prevTags = (await tx.all('SELECT tag FROM operator_tags WHERE operator_id = ?', id)).map(r => r.tag);
      await tx.run('DELETE FROM operator_tags WHERE operator_id = ?', id);
      for (const t of nextTags) {
        await tx.run('INSERT OR IGNORE INTO operator_tags (operator_id, tag) VALUES (?, ?)', id, t);
      }
      tagsChanged = { before: prevTags, after: nextTags };
    }
  });

  if (Object.keys(before).length || accountsChanged || tagsChanged) {
    await auditLog(req.user.id, id, null, 'operator', 'updated', {
      ...(Object.keys(before).length ? { before, after } : {}),
      ...(accountsChanged ? { accounts: accountsChanged } : {}),
      ...(tagsChanged ? { tags: tagsChanged } : {}),
    });
  }
  res.json({ ok: true });
}));

router.delete('/operators/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const op = await db.get('SELECT * FROM operators WHERE id = ? AND user_id = ?', id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operador não encontrado' });
    // Clean up receipt blobs for this operator's payments before deleting the rows.
    const blobs = await db.all(
      'SELECT receipt_blob_id FROM operator_payments WHERE operator_id = ? AND receipt_blob_id IS NOT NULL',
      id
    );
    await db.transaction(async (tx) => {
      for (const b of blobs) {
        await tx.run('DELETE FROM receipt_blobs WHERE id = ? AND user_id = ?', b.receipt_blob_id, req.user.id);
      }
      await tx.run('DELETE FROM operator_payments WHERE operator_id = ?', id);
      await tx.run('DELETE FROM operator_accounts WHERE operator_id = ?', id);
      await tx.run('DELETE FROM operator_tags WHERE operator_id = ?', id);
      await tx.run('DELETE FROM operators WHERE id = ?', id);
    });
    await auditLog(req.user.id, null, null, 'operator', 'deleted', { id, name: op.name });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// Audit log for a specific operator (most recent first).
router.get('/operators/:id/audit', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const op = await db.get('SELECT id FROM operators WHERE id = ? AND user_id = ?', id, req.user.id);
    if (!op) return res.status(404).json({ error: 'Operador não encontrado' });
    const rows = await db.all(
      `SELECT * FROM operator_audit WHERE user_id = ? AND operator_id = ?
       ORDER BY created_at DESC LIMIT 200`,
      req.user.id, id
    );
    for (const r of rows) {
      if (r.details) { try { r.details = JSON.parse(r.details); } catch { /* keep as string */ } }
    }
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== AVAILABLE ACCOUNTS =====
router.get('/available-accounts', async (req, res) => {
  try {
    const excludeOp = req.query.for_operator ? Number(req.query.for_operator) : null;
    const rows = await db.all(
      `SELECT a.id, a.name, COALESCE(a.hidden, 0) as hidden,
         (SELECT o.name FROM operator_accounts oa
          JOIN operators o ON o.id = oa.operator_id WHERE oa.account_id = a.id LIMIT 1) as linked_operator_name,
         (SELECT oa.operator_id FROM operator_accounts oa WHERE oa.account_id = a.id LIMIT 1) as linked_operator_id
       FROM accounts a
       WHERE a.user_id = ? AND a.hidden = 0
       ORDER BY a.name`,
      req.user.id
    );
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      linked_operator_name: r.linked_operator_name || null,
      linked_operator_id: r.linked_operator_id || null,
      assignable: !r.linked_operator_id || (excludeOp && r.linked_operator_id === excludeOp),
    })));
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
      `SELECT p.id, p.user_id, p.operator_id, p.period, p.due_date, p.amount, p.tip,
              p.status, p.paid_at, p.receipt_blob_id, p.receipt_name, p.notes,
              p.created_at, p.updated_at,
              CASE WHEN p.receipt_blob_id IS NOT NULL OR p.receipt_data IS NOT NULL THEN 1 ELSE 0 END as has_receipt,
              o.name as operator_name, o.payment_type
       FROM operator_payments p
       JOIN operators o ON o.id = p.operator_id
       ${where}
       ORDER BY COALESCE(p.due_date, p.period) DESC, p.created_at DESC`,
      ...params
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.get('/payments/:id', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT p.*, o.name as operator_name,
              CASE WHEN p.receipt_blob_id IS NOT NULL OR p.receipt_data IS NOT NULL THEN 1 ELSE 0 END as has_receipt
       FROM operator_payments p
       JOIN operators o ON o.id = p.operator_id
       WHERE p.id = ? AND p.user_id = ?`,
      req.params.id, req.user.id
    );
    if (!row) return res.status(404).json({ error: 'Pagamento não encontrado' });
    // Don't leak the data URL — use /:id/receipt for that.
    delete row.receipt_data;
    res.json(row);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// Returns the comprovante as binary (blob-backed) or a data URL (legacy).
router.get('/payments/:id/receipt', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT receipt_blob_id, receipt_data, receipt_name FROM operator_payments
       WHERE id = ? AND user_id = ?`,
      req.params.id, req.user.id
    );
    if (!row) return res.status(404).json({ error: 'Pagamento não encontrado' });
    if (row.receipt_blob_id) {
      const blob = await db.get(
        'SELECT mime_type, file_name, data FROM receipt_blobs WHERE id = ? AND user_id = ?',
        row.receipt_blob_id, req.user.id
      );
      if (!blob) return res.status(404).json({ error: 'Comprovante não encontrado' });
      // libSQL returns BLOB as Uint8Array; convert to Buffer for res.send.
      const buf = Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data);
      res.setHeader('Content-Type', blob.mime_type);
      const name = row.receipt_name || blob.file_name || 'comprovante';
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.send(buf);
    }
    if (row.receipt_data) {
      return res.json({ receipt_data: row.receipt_data, receipt_name: row.receipt_name });
    }
    return res.status(404).json({ error: 'Comprovante não encontrado' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// Upsert payment for (operator, period). If `receipt_data` is a data URL, it's
// stored as a binary BLOB in receipt_blobs. `receipt_data: null` clears it.
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

  const existing = await db.get(
    'SELECT * FROM operator_payments WHERE operator_id = ? AND period = ?',
    operator_id, period
  );

  // Resolve receipt storage: uploading a new blob / clearing / keeping existing.
  let receiptBlobId = existing?.receipt_blob_id || null;
  let receiptName = existing?.receipt_name || null;
  let clearLegacyData = false;

  if (req.body.receipt_data === null) {
    if (existing?.receipt_blob_id) await deleteReceiptBlob(existing.receipt_blob_id, req.user.id);
    receiptBlobId = null; receiptName = null; clearLegacyData = true;
  } else if (typeof req.body.receipt_data === 'string' && req.body.receipt_data.startsWith('data:')) {
    const stored = await storeReceiptBlob(req.user.id, req.body.receipt_data, req.body.receipt_name);
    if (existing?.receipt_blob_id) await deleteReceiptBlob(existing.receipt_blob_id, req.user.id);
    receiptBlobId = stored.id; receiptName = stored.file_name; clearLegacyData = true;
  }

  let payId;
  const action = existing ? 'updated' : 'created';
  const statusChanged = existing && existing.status !== status;

  if (existing) {
    await db.run(
      `UPDATE operator_payments
       SET amount=?, tip=?, status=?, paid_at=?, due_date=?, notes=?,
           receipt_blob_id=?, receipt_name=?,
           receipt_data = CASE WHEN ? THEN NULL ELSE receipt_data END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id = ?`,
      amount, tip, status, paid_at, due_date, notes, receiptBlobId, receiptName,
      clearLegacyData ? 1 : 0, existing.id
    );
    payId = existing.id;
  } else {
    const r = await db.run(
      `INSERT INTO operator_payments
         (user_id, operator_id, period, due_date, amount, tip, status, paid_at, notes,
          receipt_blob_id, receipt_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, operator_id, period, due_date, amount, tip, status, paid_at, notes,
      receiptBlobId, receiptName
    );
    payId = r.lastInsertRowid;
  }
  await auditLog(req.user.id, operator_id, payId, 'payment', action, {
    period, amount, tip, status, paid_at, due_date,
    ...(statusChanged ? { status_from: existing.status, status_to: status } : {}),
    ...(receiptBlobId && receiptBlobId !== (existing?.receipt_blob_id || null) ? { receipt_uploaded: true } : {}),
    ...(req.body.receipt_data === null ? { receipt_cleared: true } : {}),
  });
  res.json({ id: payId });
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

  let receiptBlobId = row.receipt_blob_id;
  let receiptName = row.receipt_name;
  let clearLegacy = false;
  if (req.body.receipt_data === null) {
    if (row.receipt_blob_id) await deleteReceiptBlob(row.receipt_blob_id, req.user.id);
    receiptBlobId = null; receiptName = null; clearLegacy = true;
  } else if (typeof req.body.receipt_data === 'string' && req.body.receipt_data.startsWith('data:')) {
    const stored = await storeReceiptBlob(req.user.id, req.body.receipt_data, req.body.receipt_name);
    if (row.receipt_blob_id) await deleteReceiptBlob(row.receipt_blob_id, req.user.id);
    receiptBlobId = stored.id; receiptName = stored.file_name; clearLegacy = true;
  }

  await db.run(
    `UPDATE operator_payments
       SET amount=?, tip=?, status=?, paid_at=?, due_date=?, notes=?,
           receipt_blob_id=?, receipt_name=?,
           receipt_data = CASE WHEN ? THEN NULL ELSE receipt_data END,
           updated_at=CURRENT_TIMESTAMP
     WHERE id = ?`,
    amount, tip, status, paid_at, due_date, notes, receiptBlobId, receiptName,
    clearLegacy ? 1 : 0, row.id
  );
  await auditLog(req.user.id, row.operator_id, row.id, 'payment', 'updated', {
    amount, tip, status, paid_at, due_date,
    ...(row.status !== status ? { status_from: row.status, status_to: status } : {}),
  });
  res.json({ ok: true });
}));

router.delete('/payments/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM operator_payments WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Pagamento não encontrado' });
    if (row.receipt_blob_id) await deleteReceiptBlob(row.receipt_blob_id, req.user.id);
    await db.run('DELETE FROM operator_payments WHERE id = ?', row.id);
    await auditLog(req.user.id, row.operator_id, row.id, 'payment', 'deleted', {
      period: row.period, amount: row.amount, status: row.status,
    });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== SUMMARY =====
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

    let avgMonthly = 0;
    for (const o of active) {
      const v = Number(o.payment_value) || 0;
      if (o.payment_type === 'monthly') avgMonthly += v;
      else if (o.payment_type === 'weekly') avgMonthly += v * 4.33;
    }

    const paidRows = await db.all(
      `SELECT p.amount, p.tip, p.status, p.paid_at, p.due_date, p.period, o.payment_type
       FROM operator_payments p JOIN operators o ON o.id = p.operator_id
       WHERE p.user_id = ? AND (
         (p.status = 'paid' AND substr(p.paid_at, 1, 7) = ?)
         OR (p.status != 'paid' AND COALESCE(p.due_date, p.period) BETWEEN ? AND ?)
       )`,
      req.user.id, month, monthStart, monthEnd
    );
    let paidInMonth = 0, pendingInMonth = 0, tipsInMonth = 0;
    for (const p of paidRows) {
      const total = Number(p.amount || 0) + Number(p.tip || 0);
      if (p.status === 'paid') { paidInMonth += total; tipsInMonth += Number(p.tip || 0); }
      else if (p.status === 'pending') pendingInMonth += total;
    }

    const opsProfit = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as total FROM operations
       WHERE user_id = ? AND COALESCE(event_date, DATE(created_at, '-3 hours')) BETWEEN ? AND ?`,
      req.user.id, monthStart, monthEnd
    );
    const girosProfit = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as total FROM giros
       WHERE user_id = ? AND DATE(created_at, '-3 hours') BETWEEN ? AND ?`,
      req.user.id, monthStart, monthEnd
    );
    const operationsProfit = Number(opsProfit?.total || 0);
    const girosProfitVal = Number(girosProfit?.total || 0);
    const netProfit = operationsProfit + girosProfitVal - paidInMonth;

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

// ===== ROI =====
// Profit attribution: each operation's profit is split equally among the N
// accounts that participated in it (matches how the rest of the app uses
// operation_accounts as an equal-share join). For each operator, we sum the
// share of each op whose accounts they own, then subtract what they were paid
// in the same period.
router.get('/roi', async (req, res) => {
  try {
    const today = brtToday();
    const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : today.slice(0, 7);
    const monthStart = month + '-01';
    const [yy, mm] = month.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

    // Per-operator attributed profit (split equally across participating accounts).
    const profitRows = await db.all(
      `SELECT oa_op.operator_id,
              COUNT(DISTINCT o.id) as op_count,
              COALESCE(SUM(
                o.profit * 1.0 / (SELECT COUNT(*) FROM operation_accounts WHERE operation_id = o.id)
              ), 0) as attributed_profit
       FROM operators op
       JOIN operator_accounts oa_op ON oa_op.operator_id = op.id
       JOIN operation_accounts oa ON oa.account_id = oa_op.account_id
       JOIN operations o ON o.id = oa.operation_id
       WHERE op.user_id = ?
         AND COALESCE(o.event_date, DATE(o.created_at, '-3 hours')) BETWEEN ? AND ?
       GROUP BY oa_op.operator_id`,
      req.user.id, monthStart, monthEnd
    );
    const profitByOp = {};
    for (const r of profitRows) {
      profitByOp[r.operator_id] = {
        attributed_profit: Number(r.attributed_profit || 0),
        op_count: Number(r.op_count || 0),
      };
    }

    // Paid + pending per operator in month.
    const costRows = await db.all(
      `SELECT p.operator_id,
              SUM(CASE WHEN p.status='paid'
                         AND substr(p.paid_at,1,7) = ? THEN (p.amount + p.tip) ELSE 0 END) as paid,
              SUM(CASE WHEN p.status='pending'
                         AND COALESCE(p.due_date, p.period) BETWEEN ? AND ? THEN (p.amount + p.tip) ELSE 0 END) as pending
       FROM operator_payments p
       WHERE p.user_id = ?
       GROUP BY p.operator_id`,
      month, monthStart, monthEnd, req.user.id
    );
    const costByOp = {};
    for (const r of costRows) {
      costByOp[r.operator_id] = { paid: Number(r.paid || 0), pending: Number(r.pending || 0) };
    }

    const ops = await db.all('SELECT id, name, payment_type, payment_value FROM operators WHERE user_id = ?', req.user.id);
    const result = ops.map(op => {
      const prof = profitByOp[op.id] || { attributed_profit: 0, op_count: 0 };
      const cost = costByOp[op.id] || { paid: 0, pending: 0 };
      const totalCost = cost.paid + cost.pending;
      return {
        operator_id: op.id,
        operator_name: op.name,
        payment_type: op.payment_type,
        op_count: prof.op_count,
        attributed_profit: prof.attributed_profit,
        paid: cost.paid,
        pending: cost.pending,
        net: prof.attributed_profit - totalCost,
        roi_pct: totalCost > 0 ? (prof.attributed_profit - totalCost) / totalCost * 100 : null,
      };
    });
    result.sort((a, b) => b.net - a.net);
    res.json({ month, operators: result });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== CSV EXPORT =====
router.get('/export.csv', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT p.id, p.period, p.due_date, p.amount, p.tip, p.status, p.paid_at, p.notes,
              p.receipt_blob_id, p.receipt_data,
              o.name as operator_name, o.payment_type,
              (SELECT GROUP_CONCAT(a.name, ', ')
               FROM operator_accounts oa JOIN accounts a ON a.id = oa.account_id
               WHERE oa.operator_id = o.id) as accounts,
              (SELECT GROUP_CONCAT(tag, ', ')
               FROM operator_tags WHERE operator_id = o.id) as tags
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
    const header = ['id', 'operador', 'contas', 'tags', 'tipo_pagamento', 'periodo', 'data_vencimento', 'valor', 'gorjeta', 'total', 'status', 'pago_em', 'tem_comprovante', 'notas'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const total = Number(r.amount || 0) + Number(r.tip || 0);
      lines.push([
        r.id, r.operator_name, r.accounts || '', r.tags || '', r.payment_type,
        r.period, r.due_date || '',
        Number(r.amount || 0).toFixed(2),
        Number(r.tip || 0).toFixed(2),
        total.toFixed(2),
        r.status, r.paid_at || '',
        (r.receipt_blob_id || r.receipt_data) ? 'sim' : 'não',
        r.notes || '',
      ].map(esc).join(','));
    }
    const csv = '\uFEFF' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="financas.csv"');
    res.send(csv);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== CRON: payment reminders =====
router.get('/cron-remind', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const users = await db.all(
      'SELECT id, default_payment_day FROM users WHERE notify_operator_payment = 1'
    );
    let inserted = 0;
    const today = brtToday();
    for (const u of users) {
      const ops = await db.all('SELECT * FROM operators WHERE user_id = ? AND active = 1', u.id);
      for (const op of ops) {
        if (op.payment_type === 'one_time') continue;
        const { period, due_date } = currentPeriodFor(op, today, u.default_payment_day || 5);
        if (!due_date || due_date > today) continue;
        const existing = await db.get(
          'SELECT status FROM operator_payments WHERE operator_id = ? AND period = ?',
          op.id, period
        );
        if (existing && existing.status !== 'pending') continue;
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
