const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();
router.use(auth);
router.use(require("../middleware/requireAccess").requireAccess);

const CURRENCIES = ['BRL', 'USD'];

// Built-in houses every user has. Bet365 keeps its own "accounts" system for
// freebet/volume; here it's just a house so rankings can include it later.
// Polymarket is the USD second leg of standard arbs.
const BUILTINS = [
  { name: 'Bet365', currency: 'BRL' },
  { name: 'Polymarket', currency: 'USD' },
];

// Idempotently ensure the built-in houses exist for this user. Relies on the
// UNIQUE(user_id, name) constraint so repeated calls are no-ops.
async function ensureBuiltins(userId) {
  for (const b of BUILTINS) {
    await db.run(
      `INSERT OR IGNORE INTO bookmakers (user_id, name, currency, is_builtin)
       VALUES (?, ?, ?, 1)`,
      userId, b.name, b.currency
    );
  }
}

function isUniqueErr(err) {
  return /UNIQUE constraint failed/i.test(err && err.message || '');
}

// ===== PERIOD BUCKETING (BRT / UTC-3, matches dashboard & ranking) =====
const BR_TZ_OFFSET_MS = -3 * 60 * 60 * 1000;
const OP_DATE_EXPR = `COALESCE(o.event_date, DATE(o.created_at, '-3 hours'))`;
const PERIODS = new Set(['daily', 'weekly', 'monthly', 'allTime']);

function brtDateStr(d) {
  return new Date((d ? d.getTime() : Date.now()) + BR_TZ_OFFSET_MS)
    .toISOString().split('T')[0];
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function periodWhere(period, today = brtDateStr()) {
  const p = PERIODS.has(period) ? period : 'monthly';
  if (p === 'allTime') return { period: p, clause: '1=1', params: [] };
  if (p === 'daily') return { period: p, clause: `${OP_DATE_EXPR} = ?`, params: [today] };
  const start = p === 'weekly' ? addDays(today, -6) : addDays(today, -29);
  return { period: p, clause: `${OP_DATE_EXPR} >= ?`, params: [start] };
}

function parseLegs(extraBets) {
  if (extraBets == null) return [];
  if (Array.isArray(extraBets)) return extraBets;
  try { return JSON.parse(extraBets) || []; } catch { return []; }
}

// Per-house performance: volume (BRL), nº de operações e lucro por casa no
// período. Atribuição (decidida com o usuário): toda op em que a casa participou
// soma o lucro inteiro da op àquela casa — a mesma op conta para cada casa
// envolvida (não dá pra fatiar lucro por ponta sem registrar resultado por ponta).
// Volume é a soma dos stakes daquela casa (já em BRL). Pontas Bet365/Poly das ops
// padrão mapeiam para as casas built-in; pontas de extra_bets usam bookmaker_id
// (ou o nome legado, agrupado à parte se não estiver no cadastro).
router.get('/performance', async (req, res) => {
  try {
    const userId = req.user.id;
    const period = periodWhere(String(req.query.period || 'monthly'));

    await ensureBuiltins(userId);
    // v2: read the canonical relational legs (house-object based) — no more
    // bet365/poly column + extra_bets parsing. Include pending ops so freshly
    // registered bets still show in volume/count (profit is 0 for pending/void).
    const legRows = await db.all(
      `SELECT l.operation_id, l.bookmaker_id, b.name AS bm_name,
              COALESCE(b.currency, l.currency) AS currency, l.stake, l.raw_bookmaker, o.profit
       FROM operation_legs l
       JOIN operations o ON o.id = l.operation_id
       LEFT JOIN bookmakers b ON b.id = l.bookmaker_id
       WHERE o.user_id = ? AND ${period.clause}`,
      userId, ...period.params
    );

    // Group legs per operation so each distinct house is counted once per op for
    // op_count/profit (volume sums all of that house's legs).
    const byOp = new Map();
    for (const r of legRows) {
      const key = r.bookmaker_id ? `id:${r.bookmaker_id}` : `name:${String(r.raw_bookmaker || '—').toLowerCase()}`;
      let entry = byOp.get(r.operation_id);
      if (!entry) { entry = { profit: Number(r.profit) || 0, houses: new Map() }; byOp.set(r.operation_id, entry); }
      const h = entry.houses.get(key)
        || { bookmaker_id: r.bookmaker_id || null, name: r.bm_name || r.raw_bookmaker || '—', currency: r.currency || 'BRL', volume: 0 };
      h.volume += Number(r.stake) || 0;
      entry.houses.set(key, h);
    }

    const agg = new Map();
    const combos = new Map(); // sorted house-name set → { combo, count, profit }
    for (const entry of byOp.values()) {
      for (const [key, h] of entry.houses) {
        const g = agg.get(key) || { bookmaker_id: h.bookmaker_id, name: h.name, currency: h.currency, volume: 0, op_count: 0, profit: 0 };
        g.volume += h.volume;
        g.op_count += 1;
        g.profit += entry.profit;
        agg.set(key, g);
      }
      const names = [...entry.houses.values()].map(h => h.name).sort((a, b) => a.localeCompare(b));
      if (names.length >= 2) {
        const ck = names.join(' + ');
        const c = combos.get(ck) || { combo: ck, count: 0, profit: 0 };
        c.count += 1;
        c.profit += entry.profit;
        combos.set(ck, c);
      }
    }

    const bookmakers = [...agg.values()]
      .map(g => ({ ...g, roi_pct: g.volume > 0 ? (g.profit / g.volume) * 100 : 0 }))
      .sort((a, b) => b.volume - a.volume);

    const comboList = [...combos.values()]
      .sort((a, b) => b.count - a.count || b.profit - a.profit)
      .slice(0, 10);

    // Temporal buckets (BRT). Hour uses registration time (created_at) — "when do
    // I register"; weekday uses the effective op date — for both activity and P&L.
    const hourRows = await db.all(
      `SELECT CAST(strftime('%H', o.created_at, '-3 hours') AS INTEGER) AS h,
              COUNT(*) AS c, COALESCE(SUM(o.profit), 0) AS p
       FROM operations o
       WHERE o.user_id = ? AND ${period.clause}
       GROUP BY h`,
      userId, ...period.params
    );
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, profit: 0 }));
    for (const r of hourRows) {
      const h = Number(r.h);
      if (h >= 0 && h < 24) byHour[h] = { hour: h, count: Number(r.c) || 0, profit: Number(r.p) || 0 };
    }

    const wdRows = await db.all(
      `SELECT CAST(strftime('%w', ${OP_DATE_EXPR}) AS INTEGER) AS w,
              COUNT(*) AS c, COALESCE(SUM(o.profit), 0) AS p
       FROM operations o
       WHERE o.user_id = ? AND ${period.clause}
       GROUP BY w`,
      userId, ...period.params
    );
    const byWeekday = Array.from({ length: 7 }, (_, w) => ({ weekday: w, count: 0, profit: 0 }));
    for (const r of wdRows) {
      const w = Number(r.w);
      if (w >= 0 && w < 7) byWeekday[w] = { weekday: w, count: Number(r.c) || 0, profit: Number(r.p) || 0 };
    }

    res.json({ period: period.period, bookmakers, combos: comboList, byHour, byWeekday });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== CURATION: map legacy free-text house names to house objects =====
// Legs backfilled from legacy free-text names have bookmaker_id NULL and
// raw_bookmaker set. List the distinct pending names so the user can map them
// (fixes miss-spelling inconsistencies in analytics).
router.get('/curation', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT l.raw_bookmaker AS name, COUNT(*) AS legs
       FROM operation_legs l
       JOIN operations o ON o.id = l.operation_id
       WHERE o.user_id = ? AND l.bookmaker_id IS NULL AND l.raw_bookmaker IS NOT NULL
       GROUP BY l.raw_bookmaker
       ORDER BY legs DESC, name`,
      req.user.id
    );
    res.json(rows.map(r => ({ name: r.name, legs: Number(r.legs) || 0 })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Map a pending name to a house: an existing bookmaker_id, or create one from
// { new_name, currency }. Updates every leg of the user that has that raw name.
router.post('/curation', async (req, res) => {
  try {
    const raw = String(req.body.raw_bookmaker || '').trim();
    if (!raw) return res.status(400).json({ error: 'Nome pendente obrigatório' });

    let bmId = null;
    if (req.body.bookmaker_id != null) {
      const bm = await db.get('SELECT id FROM bookmakers WHERE id = ? AND user_id = ?', req.body.bookmaker_id, req.user.id);
      if (!bm) return res.status(400).json({ error: 'Casa inválida' });
      bmId = bm.id;
    } else {
      const newName = String(req.body.new_name || raw).trim();
      const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : 'BRL';
      try {
        const r = await db.run('INSERT INTO bookmakers (user_id, name, currency) VALUES (?, ?, ?)', req.user.id, newName, currency);
        bmId = Number(r.lastInsertRowid);
      } catch (err) {
        if (isUniqueErr(err)) {
          const existing = await db.get('SELECT id FROM bookmakers WHERE user_id = ? AND name = ?', req.user.id, newName);
          bmId = existing ? existing.id : null;
        } else throw err;
      }
    }
    if (!bmId) return res.status(400).json({ error: 'Não foi possível resolver a casa' });

    const r = await db.run(
      `UPDATE operation_legs SET bookmaker_id = ?, raw_bookmaker = NULL
       WHERE raw_bookmaker = ? AND operation_id IN (SELECT id FROM operations WHERE user_id = ?)`,
      bmId, raw, req.user.id
    );
    await audit(req, 'bookmaker_curation', bmId, 'mapped', { raw, legs: r.changes });
    res.json({ ok: true, bookmaker_id: bmId, updated: r.changes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// List user's houses (excludes hidden/soft-deleted). Built-ins first, then A→Z.
router.get('/', async (req, res) => {
  try {
    await ensureBuiltins(req.user.id);
    const bookmakers = await db.all(
      'SELECT * FROM bookmakers WHERE user_id = ? AND hidden = 0 ORDER BY is_builtin DESC, name',
      req.user.id
    );
    res.json(bookmakers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Create house
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : 'BRL';
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome da casa é obrigatório' });
    }
    const r = await db.run(
      'INSERT INTO bookmakers (user_id, name, currency) VALUES (?, ?, ?)',
      req.user.id, name.trim(), currency
    );
    await audit(req, 'bookmaker', r.lastInsertRowid, 'created', { name: name.trim(), currency });
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    if (isUniqueErr(err)) return res.status(400).json({ error: 'Já existe uma casa com esse nome' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Update house. Built-ins can't be renamed, have currency changed, or be deactivated.
router.put('/:id', async (req, res) => {
  try {
    const bm = await db.get('SELECT * FROM bookmakers WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!bm) return res.status(404).json({ error: 'Casa não encontrada' });
    if (bm.is_builtin) return res.status(400).json({ error: 'Casas padrão não podem ser editadas' });

    const { name, active } = req.body;
    const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : bm.currency;
    await db.run(
      'UPDATE bookmakers SET name=?, currency=?, active=? WHERE id = ?',
      name ?? bm.name,
      currency,
      active !== undefined ? (active ? 1 : 0) : bm.active,
      req.params.id
    );
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueErr(err)) return res.status(400).json({ error: 'Já existe uma casa com esse nome' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// "Delete" — soft-hide to preserve historical operations that reference the name.
// Built-ins can't be removed.
router.delete('/:id', async (req, res) => {
  try {
    const bm = await db.get('SELECT id, name, is_builtin FROM bookmakers WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!bm) return res.status(404).json({ error: 'Casa não encontrada' });
    if (bm.is_builtin) return res.status(400).json({ error: 'Casas padrão não podem ser removidas' });
    await db.run('UPDATE bookmakers SET hidden = 1, active = 0 WHERE id = ?', bm.id);
    await audit(req, 'bookmaker', bm.id, 'hidden', { name: bm.name });
    res.json({ ok: true, hidden: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
