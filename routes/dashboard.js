const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { attachMany, attachScalars } = require('../utils/batch');

const router = express.Router();
router.use(auth);
router.use(require("../middleware/requireAccess").requireAccess);

// Users are in BRT (UTC-3). Server (Vercel / local) stores created_at as UTC,
// so shifting -3h before DATE() buckets by the user's calendar day.
const BR_TZ_OFFSET_MS = -3 * 60 * 60 * 1000;
function brtDateStr(d) {
  return new Date((d ? d.getTime() : Date.now()) + BR_TZ_OFFSET_MS)
    .toISOString().split('T')[0];
}

// Effective date for an operation: user-set event_date takes priority, otherwise
// the BRT calendar day of created_at. Used for every period bucket below.
const OP_DATE_EXPR = `COALESCE(o.event_date, DATE(o.created_at, '-3 hours'))`;

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay();
  d.setDate(d.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  return d.toISOString().split('T')[0];
}

function getPrevMonthRange(todayStr) {
  const d = new Date(todayStr + 'T00:00:00');
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const last = new Date(d.getFullYear(), d.getMonth(), 0);
  return {
    start: first.toISOString().split('T')[0],
    end: last.toISOString().split('T')[0],
  };
}

router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;
    const today = brtDateStr();
    const weekStart = getWeekStart(today);
    const monthStart = today.substring(0, 7) + '-01';

    // Previous periods for comparison
    const yesterdayStr = brtDateStr(new Date(Date.now() - 86400000));

    const prevWeekMonday = new Date(weekStart + 'T00:00:00');
    prevWeekMonday.setDate(prevWeekMonday.getDate() - 7);
    const prevWeekStart = prevWeekMonday.toISOString().split('T')[0];
    const prevWeekEnd = new Date(weekStart + 'T00:00:00');
    prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
    const prevWeekEndStr = prevWeekEnd.toISOString().split('T')[0];

    const prevMonth = getPrevMonthRange(today);

    const todayStats = await db.get(
      `SELECT COALESCE(SUM(o.profit), 0) as profit, COUNT(*) as count
       FROM operations o WHERE o.user_id = ? AND ${OP_DATE_EXPR} = ?`,
      userId, today
    );

    const yesterdayStats = await db.get(
      `SELECT COALESCE(SUM(o.profit), 0) as profit, COUNT(*) as count
       FROM operations o WHERE o.user_id = ? AND ${OP_DATE_EXPR} = ?`,
      userId, yesterdayStr
    );

    const weekStats = await db.get(
      `SELECT COALESCE(SUM(o.profit), 0) as profit, COUNT(*) as count
       FROM operations o WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= ?`,
      userId, weekStart
    );

    const prevWeekStats = await db.get(
      `SELECT COALESCE(SUM(o.profit), 0) as profit, COUNT(*) as count
       FROM operations o WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= ? AND ${OP_DATE_EXPR} <= ?`,
      userId, prevWeekStart, prevWeekEndStr
    );

    const monthStats = await db.get(
      `SELECT COALESCE(SUM(o.profit), 0) as profit, COUNT(*) as count
       FROM operations o WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= ?`,
      userId, monthStart
    );

    const prevMonthStats = await db.get(
      `SELECT COALESCE(SUM(o.profit), 0) as profit, COUNT(*) as count
       FROM operations o WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= ? AND ${OP_DATE_EXPR} <= ?`,
      userId, prevMonth.start, prevMonth.end
    );

    const allTimeStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ?`,
      userId
    );

    // FX exposure — over the USD legs of SETTLED operations, sum the realized USD
    // P&L (winner: stake*(odd-1); loser: -stake) and the BRL it was booked at (using
    // each leg's recorded rate). The frontend combines this with the live rate to
    // show how the dollar's move revalued that realized dollar P&L, plus the
    // volume-weighted average operating rate. Void/pending excluded.
    const fxAgg = await db.get(
      `SELECT
         COALESCE(SUM(l.stake_orig), 0) AS usd_staked,
         COALESCE(SUM(l.stake_orig * l.rate), 0) AS brl_staked,
         COALESCE(SUM(CASE WHEN l.won = 1 THEN l.stake_orig * (l.odd - 1) ELSE -l.stake_orig END), 0) AS usd_pnl,
         COALESCE(SUM((CASE WHEN l.won = 1 THEN l.stake_orig * (l.odd - 1) ELSE -l.stake_orig END) * l.rate), 0) AS brl_pnl,
         COUNT(*) AS legs
       FROM operation_legs l
       JOIN operations o ON o.id = l.operation_id
       WHERE o.user_id = ? AND l.currency = 'USD' AND l.stake_orig > 0
         AND o.result IS NOT NULL AND o.result NOT IN ('pending', 'void')`,
      userId
    );

    // Giros profit (all-time + per period) — kept separate so the frontend can toggle inclusion
    const girosTodayRow = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM giros WHERE user_id = ? AND DATE(created_at, '-3 hours') = ?`,
      userId, today
    );
    const girosWeekRow = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM giros WHERE user_id = ? AND DATE(created_at, '-3 hours') >= ?`,
      userId, weekStart
    );
    const girosMonthRow = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM giros WHERE user_id = ? AND DATE(created_at, '-3 hours') >= ?`,
      userId, monthStart
    );
    const girosAllRow = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM giros WHERE user_id = ?`,
      userId
    );

    // Average daily profit (for all-time comparison)
    const firstOp = await db.get(
      `SELECT ${OP_DATE_EXPR} as first_date FROM operations o WHERE o.user_id = ?
       ORDER BY first_date ASC LIMIT 1`,
      userId
    );
    let avgDailyProfit = 0;
    if (firstOp && firstOp.first_date) {
      const daysSinceFirst = Math.max(1, Math.ceil((new Date(today) - new Date(firstOp.first_date)) / 86400000));
      avgDailyProfit = allTimeStats.profit / daysSinceFirst;
    }

    // Weekly volume per account (freebet rule: Bet365 odd >= 2.0 counts; freebet-funded
    // bets do not, since the user isn't wagering their own money).
    const accountVolumes = await db.all(
      `SELECT
        a.id as account_id,
        a.name as account_name,
        a.max_stake_aumentada,
        COALESCE(SUM(
          CASE
            WHEN o.odd_bet365 >= 2.0
              AND COALESCE(o.uses_freebet, 0) = 0
              AND ${OP_DATE_EXPR} >= ?
            THEN COALESCE(
              oa.stake_bet365,
              o.stake_bet365 * 1.0 / (
                SELECT COUNT(*) FROM operation_accounts oa2 WHERE oa2.operation_id = o.id
              )
            )
            ELSE 0
          END
        ), 0) as volume
      FROM accounts a
      LEFT JOIN operation_accounts oa ON oa.account_id = a.id
      LEFT JOIN operations o ON o.id = oa.operation_id AND o.user_id = ?
      WHERE a.user_id = ? AND a.active = 1 AND COALESCE(a.hidden, 0) = 0
      GROUP BY a.id
      ORDER BY a.name`,
      weekStart, userId, userId
    );

    const profitByType = await db.all(
      `SELECT type, COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ?
       GROUP BY type`,
      userId
    );

    // Per-side win breakdown across periods. For each bucket we count ops that
    // settled as bet365_won / poly_won and aggregate their profit. Pending, void
    // and generic 'won' (arb BR) are ignored since they don't have a "side".
    const yearStart = today.substring(0, 4) + '-01-01';
    const winsPeriods = {
      today:   { clause: `${OP_DATE_EXPR} = ?`,      args: [today] },
      week:    { clause: `${OP_DATE_EXPR} >= ?`,     args: [weekStart] },
      month:   { clause: `${OP_DATE_EXPR} >= ?`,     args: [monthStart] },
      year:    { clause: `${OP_DATE_EXPR} >= ?`,     args: [yearStart] },
      allTime: { clause: '1=1',                      args: [] },
    };
    const emptySide = () => ({ bet365_won: { count: 0, profit: 0 }, poly_won: { count: 0, profit: 0 } });
    const winsBySide = {};
    for (const [period, spec] of Object.entries(winsPeriods)) {
      const rows = await db.all(
        `SELECT o.result, COUNT(*) as count, COALESCE(SUM(o.profit), 0) as profit
         FROM operations o
         WHERE o.user_id = ? AND o.result IN ('bet365_won','poly_won') AND ${spec.clause}
         GROUP BY o.result`,
        userId, ...spec.args
      );
      const bucket = emptySide();
      for (const r of rows) {
        if (bucket[r.result]) bucket[r.result] = { count: r.count, profit: Number(r.profit) || 0 };
      }
      winsBySide[period] = bucket;
    }

    const dailyProfits = await db.all(
      `SELECT ${OP_DATE_EXPR} as date, SUM(o.profit) as profit, COUNT(*) as count
       FROM operations o
       WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= DATE('now', '-3 hours', '-30 days')
       GROUP BY date
       ORDER BY date`,
      userId
    );

    const recentOps = await db.all(
      'SELECT * FROM operations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
      userId
    );

    await attachMany(recentOps, {
      sql: `SELECT oa.operation_id, a.id, a.name, oa.stake_bet365 as stake
            FROM operation_accounts oa
            JOIN accounts a ON a.id = oa.account_id
            WHERE oa.operation_id IN ({{IN}})`,
      foreignKey: 'operation_id',
      attachAs: 'accounts',
      map: r => ({ id: r.id, name: r.name, stake: r.stake }),
    });
    await attachScalars(recentOps, {
      sql: `SELECT operation_id, tag FROM operation_tags
            WHERE operation_id IN ({{IN}}) ORDER BY tag`,
      foreignKey: 'operation_id',
      valueKey: 'tag',
      attachAs: 'tags',
    });
    // v2: attach relational legs for the "Stake"/"Proteção" recent-ops columns.
    await attachMany(recentOps, {
      sql: `SELECT l.operation_id, b.name AS bookmaker, l.role, l.stake, l.raw_bookmaker, l.position
            FROM operation_legs l
            LEFT JOIN bookmakers b ON b.id = l.bookmaker_id
            WHERE l.operation_id IN ({{IN}})
            ORDER BY l.position`,
      foreignKey: 'operation_id',
      attachAs: 'legs',
      map: r => ({ bookmaker: r.bookmaker || r.raw_bookmaker, role: r.role, stake: r.stake, raw_bookmaker: r.raw_bookmaker }),
    });

    // Operator cost card — only when user enabled it in settings.
    let operators = null;
    const u = await db.get('SELECT dash_include_operators FROM users WHERE id = ?', userId);
    if (u && u.dash_include_operators) {
      const opsList = await db.all(
        `SELECT payment_type, payment_value FROM operators
         WHERE user_id = ? AND active = 1`,
        userId
      );
      // Normalize recurring costs to month-equivalent for a single "monthly cost" headline.
      let monthlyCost = 0;
      for (const o of opsList) {
        const v = Number(o.payment_value) || 0;
        if (o.payment_type === 'monthly') monthlyCost += v;
        else if (o.payment_type === 'weekly') monthlyCost += v * 4.3333;
      }
      const paidMonth = await db.get(
        `SELECT COALESCE(SUM(amount + COALESCE(tip,0)), 0) as total, COUNT(*) as count
         FROM operator_payments WHERE user_id = ? AND status = 'paid'
         AND DATE(COALESCE(paid_at, created_at), '-3 hours') >= ?`,
        userId, monthStart
      );
      const pending = await db.get(
        `SELECT COALESCE(SUM(amount + COALESCE(tip,0)), 0) as total, COUNT(*) as count
         FROM operator_payments WHERE user_id = ? AND status = 'pending'`,
        userId
      );
      const overdue = await db.get(
        `SELECT COUNT(*) as count FROM operator_payments
         WHERE user_id = ? AND status = 'pending' AND due_date IS NOT NULL AND due_date < ?`,
        userId, today
      );
      operators = {
        activeCount: opsList.length,
        monthlyCost,
        paidMonth,
        pending,
        overdueCount: overdue?.count || 0,
      };
    }

    res.json({
      today: todayStats,
      yesterday: yesterdayStats,
      week: weekStats,
      prevWeek: prevWeekStats,
      month: monthStats,
      prevMonth: prevMonthStats,
      allTime: allTimeStats,
      avgDailyProfit,
      accountVolumes,
      weeklyVolumeGoal: 1500,
      profitByType,
      dailyProfits,
      recentOps,
      weekStart,
      giros: {
        today: girosTodayRow,
        week: girosWeekRow,
        month: girosMonthRow,
        allTime: girosAllRow,
      },
      operators,
      winsBySide,
      fx: fxAgg,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});


// Retrospectiva (Spotify-Wrapped style) for an arbitrary date range — same numbers
// as the stats/estatísticas, scoped to [start, end]. Powers the monthly recap and
// the World Cup recap.
router.get('/recap', async (req, res) => {
  try {
    const userId = req.user.id;
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : null;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : null;
    if (!start || !end) return res.status(400).json({ error: 'Período inválido' });
    const range = `${OP_DATE_EXPR} >= ? AND ${OP_DATE_EXPR} <= ?`;

    const summary = await db.get(
      `SELECT COUNT(*) AS ops, COALESCE(SUM(o.profit), 0) AS profit,
              COUNT(DISTINCT ${OP_DATE_EXPR}) AS active_days
       FROM operations o WHERE o.user_id = ? AND ${range}`,
      userId, start, end
    );
    const byType = await db.all(
      `SELECT o.type, COUNT(*) AS count, COALESCE(SUM(o.profit), 0) AS profit
       FROM operations o WHERE o.user_id = ? AND ${range} GROUP BY o.type ORDER BY count DESC`,
      userId, start, end
    );
    const biggest = await db.get(
      `SELECT o.game, o.profit, ${OP_DATE_EXPR} AS date, o.type
       FROM operations o WHERE o.user_id = ? AND ${range} ORDER BY o.profit DESC LIMIT 1`,
      userId, start, end
    );
    const bestDay = await db.get(
      `SELECT ${OP_DATE_EXPR} AS date, COALESCE(SUM(o.profit), 0) AS profit, COUNT(*) AS ops
       FROM operations o WHERE o.user_id = ? AND ${range} GROUP BY date ORDER BY profit DESC LIMIT 1`,
      userId, start, end
    );
    const girosRow = await db.get(
      `SELECT COUNT(*) AS count, COALESCE(SUM(profit), 0) AS profit
       FROM giros WHERE user_id = ? AND DATE(created_at, '-3 hours') >= ? AND DATE(created_at, '-3 hours') <= ?`,
      userId, start, end
    );

    // Houses + combos + total volume (BRL) from the relational legs.
    const legRows = await db.all(
      `SELECT l.operation_id, l.bookmaker_id, b.name AS bm_name, l.stake, l.raw_bookmaker
       FROM operation_legs l JOIN operations o ON o.id = l.operation_id
       LEFT JOIN bookmakers b ON b.id = l.bookmaker_id
       WHERE o.user_id = ? AND ${range}`,
      userId, start, end
    );
    const byOp = new Map();
    let volume = 0;
    for (const r of legRows) {
      volume += Number(r.stake) || 0;
      const key = r.bookmaker_id ? `id:${r.bookmaker_id}` : `name:${String(r.raw_bookmaker || '—').toLowerCase()}`;
      let e = byOp.get(r.operation_id);
      if (!e) { e = new Map(); byOp.set(r.operation_id, e); }
      e.set(key, r.bm_name || r.raw_bookmaker || '—');
    }
    const houseCount = new Map();
    const comboCount = new Map();
    for (const houses of byOp.values()) {
      for (const name of houses.values()) houseCount.set(name, (houseCount.get(name) || 0) + 1);
      const names = [...houses.values()].sort((a, b) => a.localeCompare(b));
      if (names.length >= 2) { const ck = names.join(' + '); comboCount.set(ck, (comboCount.get(ck) || 0) + 1); }
    }
    const topHouse = [...houseCount.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    const topCombo = [...comboCount.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    res.json({
      start, end,
      summary: { ...summary, volume },
      byType, biggest, bestDay,
      giros: girosRow,
      topHouse: topHouse ? { name: topHouse[0], count: topHouse[1] } : null,
      topCombo: topCombo ? { combo: topCombo[0], count: topCombo[1] } : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Data export / backup
router.get('/export', async (req, res) => {
  try {
    const userId = req.user.id;
    const operations = await db.all('SELECT * FROM operations WHERE user_id = ? ORDER BY created_at DESC', userId);
    for (const op of operations) {
      op.accounts = await db.all(
        `SELECT a.id, a.name FROM operation_accounts oa
         JOIN accounts a ON a.id = oa.account_id WHERE oa.operation_id = ?`, op.id
      );
    }
    const accounts = await db.all('SELECT * FROM accounts WHERE user_id = ?', userId);
    const freebetAdjustments = await db.all(
      'SELECT * FROM freebet_adjustments WHERE user_id = ? ORDER BY week_start DESC',
      userId
    );

    res.setHeader('Content-Disposition', `attachment; filename=surebet-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.json({
      exported_at: new Date().toISOString(),
      user: { id: userId, display_name: req.user.display_name },
      accounts,
      operations,
      freebet_adjustments: freebetAdjustments,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
