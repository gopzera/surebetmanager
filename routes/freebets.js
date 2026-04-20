const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const V = require('../utils/validate');

const router = express.Router();
router.use(auth);

const WEEKLY_VOLUME_GOAL = 1500; // R$ per account per week
const FREEBET_VALUE = 100;       // R$ awarded when threshold is crossed
const HISTORY_WEEKS = 12;

// Same BRT-shift logic used elsewhere: users are in UTC-3; created_at stored as UTC.
const OP_DATE_EXPR = `COALESCE(o.event_date, DATE(o.created_at, '-3 hours'))`;
const BR_TZ_OFFSET_MS = -3 * 60 * 60 * 1000;
function brtToday() {
  return new Date(Date.now() + BR_TZ_OFFSET_MS).toISOString().split('T')[0];
}
function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().split('T')[0];
}

// Availability is derived from operation volume — this table only records
// exceptions (user didn't actually receive the freebet) and partial usage.
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const today = brtToday();
    const currentWeekStart = getWeekStart(today);

    const oldestMonday = new Date(currentWeekStart + 'T00:00:00');
    oldestMonday.setDate(oldestMonday.getDate() - (HISTORY_WEEKS - 1) * 7);
    const oldestStr = oldestMonday.toISOString().split('T')[0];

    // One row per (operation × account) with stake share + effective date.
    const rows = await db.all(
      `SELECT
         oa.account_id,
         a.name as account_name,
         COALESCE(a.hidden, 0) as hidden,
         ${OP_DATE_EXPR} as eff_date,
         o.odd_bet365,
         COALESCE(o.uses_freebet, 0) as uses_freebet,
         COALESCE(
           oa.stake_bet365,
           o.stake_bet365 * 1.0 / NULLIF(
             (SELECT COUNT(*) FROM operation_accounts oa2 WHERE oa2.operation_id = o.id), 0
           )
         ) as stake_share
       FROM operation_accounts oa
       JOIN operations o ON o.id = oa.operation_id
       JOIN accounts a ON a.id = oa.account_id
       WHERE a.user_id = ? AND ${OP_DATE_EXPR} >= ?`,
      userId, oldestStr
    );

    const volumeByKey = {};
    const accountMeta = {};
    for (const r of rows) {
      accountMeta[r.account_id] = { name: r.account_name, hidden: !!r.hidden };
      // Freebet-funded bets don't count toward the volume goal.
      if (Number(r.odd_bet365) < 2.0 || r.uses_freebet) continue;
      const ws = getWeekStart(r.eff_date);
      const key = `${r.account_id}|${ws}`;
      volumeByKey[key] = (volumeByKey[key] || 0) + Number(r.stake_share || 0);
    }

    // Derive freebet usage from operations.
    // Main bet: uses_freebet=1 + freebet_account_id → charge stake_bet365 to that account.
    // Extra bets: JSON entries with uses_freebet=1 + account_id → charge entry.stake.
    // Attribution goes to the EARNING week = op's week − 1 (freebet earned in W, used in W+1).
    const fbOps = await db.all(
      `SELECT
         o.stake_bet365,
         o.freebet_account_id,
         COALESCE(o.uses_freebet, 0) as uses_freebet,
         o.extra_bets,
         ${OP_DATE_EXPR} as eff_date
       FROM operations o
       WHERE o.user_id = ? AND ${OP_DATE_EXPR} >= ?
         AND (o.uses_freebet = 1 OR o.extra_bets IS NOT NULL)`,
      userId, oldestStr
    );
    const derivedUsedByKey = {};
    function addUsed(accId, earningWeek, amount) {
      if (!accId || !earningWeek || !amount) return;
      const key = `${accId}|${earningWeek}`;
      derivedUsedByKey[key] = (derivedUsedByKey[key] || 0) + amount;
    }
    for (const fbOp of fbOps) {
      const spendWeek = getWeekStart(fbOp.eff_date);
      // Earning week = the Monday before the spending week.
      const spendDate = new Date(spendWeek + 'T00:00:00');
      spendDate.setDate(spendDate.getDate() - 7);
      const earningWeek = spendDate.toISOString().split('T')[0];

      if (fbOp.uses_freebet && fbOp.freebet_account_id) {
        addUsed(fbOp.freebet_account_id, earningWeek, Number(fbOp.stake_bet365) || 0);
      }
      if (fbOp.extra_bets) {
        let extras = [];
        try { extras = JSON.parse(fbOp.extra_bets) || []; } catch {}
        for (const eb of extras) {
          if (eb.uses_freebet && eb.account_id) {
            addUsed(eb.account_id, earningWeek, Number(eb.stake) || 0);
          }
        }
      }
    }

    const adjRows = await db.all(
      `SELECT account_id, week_start, dismissed, used_amount
       FROM freebet_adjustments
       WHERE user_id = ? AND week_start >= ?`,
      userId, oldestStr
    );
    const adjByKey = {};
    for (const a of adjRows) adjByKey[`${a.account_id}|${a.week_start}`] = a;

    const allAccounts = await db.all(
      'SELECT id, name, COALESCE(hidden,0) as hidden FROM accounts WHERE user_id = ? AND active = 1',
      userId
    );
    for (const a of allAccounts) {
      if (!accountMeta[a.id]) accountMeta[a.id] = { name: a.name, hidden: !!a.hidden };
    }

    const weekStarts = [];
    for (let i = 0; i < HISTORY_WEEKS; i++) {
      const d = new Date(currentWeekStart + 'T00:00:00');
      d.setDate(d.getDate() - i * 7);
      weekStarts.push(d.toISOString().split('T')[0]);
    }

    const weeks = weekStarts.map(week_start => {
      const isCurrent = week_start === currentWeekStart;
      const accIds = new Set();
      // Past weeks: only show accounts with activity. Current week: all active accounts
      // so user can see progress toward next freebet.
      if (isCurrent) {
        for (const a of allAccounts) if (!a.hidden) accIds.add(a.id);
      }
      for (const key of Object.keys(volumeByKey)) {
        const [accId, ws] = key.split('|');
        if (ws === week_start) accIds.add(Number(accId));
      }
      // Include accounts with adjustments (dismissed/partial-use) even if volume
      // row vanished (e.g. op deleted).
      for (const a of adjRows) {
        if (a.week_start === week_start) accIds.add(a.account_id);
      }
      // Include accounts with derived freebet usage.
      for (const key of Object.keys(derivedUsedByKey)) {
        const [accId, ws] = key.split('|');
        if (ws === week_start) accIds.add(Number(accId));
      }

      const accounts = [...accIds].map(accId => {
        const meta = accountMeta[accId] || { name: 'Conta', hidden: false };
        const volume = volumeByKey[`${accId}|${week_start}`] || 0;
        const earned = volume >= WEEKLY_VOLUME_GOAL;
        const adj = adjByKey[`${accId}|${week_start}`];
        const dismissed = !!(adj?.dismissed);
        // Manual override (used_amount > 0 in adjustments) takes precedence;
        // otherwise derive from operations that flagged freebet usage.
        const derived = derivedUsedByKey[`${accId}|${week_start}`] || 0;
        const used_amount = (adj && Number(adj.used_amount) > 0)
          ? Number(adj.used_amount)
          : derived;
        return {
          account_id: accId,
          account_name: meta.name,
          hidden: meta.hidden,
          volume,
          earned,
          // Freebet only becomes spendable on the Monday following the earning week.
          available: earned && !dismissed && !isCurrent,
          dismissed,
          used_amount,
          remaining: earned && !dismissed ? Math.max(0, FREEBET_VALUE - used_amount) : 0,
        };
      }).sort((a, b) => a.account_name.localeCompare(b.account_name));

      return { week_start, is_current: isCurrent, accounts };
    });

    res.json({
      weekly_goal: WEEKLY_VOLUME_GOAL,
      freebet_value: FREEBET_VALUE,
      current_week_start: currentWeekStart,
      weeks,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Upsert dismiss / partial-use for a (account, week). Only provided fields change.
router.post('/adjust', V.handle(async (req, res) => {
  const account_id = V.int(req.body.account_id, { min: 1, name: 'Conta' });
  const week_start = V.str(req.body.week_start, { min: 10, max: 10, name: 'Semana' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start)) {
    return res.status(400).json({ error: 'Formato de semana inválido' });
  }

  const acc = await db.get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', account_id, req.user.id);
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });

  const existing = await db.get(
    `SELECT id, dismissed, used_amount FROM freebet_adjustments
     WHERE user_id = ? AND account_id = ? AND week_start = ?`,
    req.user.id, account_id, week_start
  );

  let dismissed = existing?.dismissed || 0;
  if (req.body.dismissed !== undefined) dismissed = req.body.dismissed ? 1 : 0;

  let used_amount = Number(existing?.used_amount || 0);
  if (req.body.used_amount !== undefined) {
    used_amount = V.num(req.body.used_amount, { min: 0, max: FREEBET_VALUE, name: 'Valor usado' });
  }

  if (existing) {
    await db.run(
      `UPDATE freebet_adjustments
       SET dismissed = ?, used_amount = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      dismissed, used_amount, existing.id
    );
  } else {
    await db.run(
      `INSERT INTO freebet_adjustments (user_id, account_id, week_start, dismissed, used_amount)
       VALUES (?, ?, ?, ?, ?)`,
      req.user.id, account_id, week_start, dismissed, used_amount
    );
  }
  res.json({ ok: true });
}));

module.exports = router;
