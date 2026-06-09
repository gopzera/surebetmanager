const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();
router.use(auth);

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
    const bms = await db.all(
      'SELECT id, name, currency, is_builtin FROM bookmakers WHERE user_id = ? AND hidden = 0',
      userId
    );
    const byId = new Map(bms.map(b => [b.id, b]));
    const byNameLower = new Map(bms.map(b => [b.name.toLowerCase(), b]));
    const bet365 = bms.find(b => b.is_builtin && b.name === 'Bet365') || null;
    const poly = bms.find(b => b.is_builtin && b.name === 'Polymarket') || null;

    const ops = await db.all(
      `SELECT o.id, o.type, o.stake_bet365, o.stake_poly_usd, o.exchange_rate, o.profit, o.extra_bets
       FROM operations o
       WHERE o.user_id = ? AND o.result != 'pending' AND ${period.clause}`,
      userId, ...period.params
    );

    // key → aggregate. key prefers bookmaker id; legacy free-text names fall back
    // to their lowercased name so unmapped houses still surface as their own row.
    const agg = new Map();
    const combos = new Map(); // sorted house-name set → { combo, count, profit }
    const keyFor = (bm, name) => bm ? `id:${bm.id}` : `name:${(name || '—').toLowerCase()}`;

    for (const op of ops) {
      const profit = Number(op.profit) || 0;
      // Accumulate per-house volume within this op, so each distinct house is
      // counted once for op_count/profit even with multiple legs at it.
      const housesInOp = new Map();
      const addVol = (bm, name, currency, vol) => {
        const key = keyFor(bm, name);
        const cur = housesInOp.get(key)
          || { bookmaker_id: bm ? bm.id : null, name: bm ? bm.name : (name || '—'), currency: bm ? bm.currency : (currency || 'BRL'), volume: 0 };
        cur.volume += Number(vol) || 0;
        housesInOp.set(key, cur);
      };

      if (Number(op.stake_bet365) > 0) addVol(bet365, 'Bet365', 'BRL', Number(op.stake_bet365));
      if (Number(op.stake_poly_usd) > 0) {
        addVol(poly, 'Polymarket', 'USD', Number(op.stake_poly_usd) * (Number(op.exchange_rate) || 1));
      }
      for (const leg of parseLegs(op.extra_bets)) {
        if (leg && (leg.bookmaker_id || leg.bookmaker)) {
          const bm = leg.bookmaker_id ? byId.get(Number(leg.bookmaker_id))
                   : byNameLower.get(String(leg.bookmaker || '').toLowerCase());
          addVol(bm || null, leg.bookmaker, leg.currency, Number(leg.stake) || 0);
        } else if (leg) {
          // aumentada secondary legs carry no bookmaker — they're extra Bet365 bets.
          addVol(bet365, 'Bet365', 'BRL', Number(leg.stake) || 0);
        }
      }

      for (const [key, h] of housesInOp) {
        const g = agg.get(key) || { bookmaker_id: h.bookmaker_id, name: h.name, currency: h.currency, volume: 0, op_count: 0, profit: 0 };
        g.volume += h.volume;
        g.op_count += 1;
        g.profit += profit;
        agg.set(key, g);
      }

      // House combination for this op (only multi-house ops have a "combo").
      const names = [...housesInOp.values()].map(h => h.name).sort((a, b) => a.localeCompare(b));
      if (names.length >= 2) {
        const ck = names.join(' + ');
        const c = combos.get(ck) || { combo: ck, count: 0, profit: 0 };
        c.count += 1;
        c.profit += profit;
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
       WHERE o.user_id = ? AND o.result != 'pending' AND ${period.clause}
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
       WHERE o.user_id = ? AND o.result != 'pending' AND ${period.clause}
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
