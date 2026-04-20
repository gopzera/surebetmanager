// Alert evaluators. Each runs user-scoped queries and returns zero or more
// triggered alert entries for the dashboard widget. Pure read-only.

const db = require('../db/database');

// Shape of every available alert. Keeping this here (not in the DB) lets the
// UI render labels and default params for rules the user has never touched.
const ALERT_DEFS = {
  inactivity: {
    title: 'Sem operações recentes',
    description: 'Avisa quando você fica N dias sem registrar nenhuma operação.',
    defaults: { days: 3 },
    severity: 'warning',
  },
  stale_pending: {
    title: 'Operações pendentes antigas',
    description: 'Avisa quando operações pendentes passam de N dias sem resultado.',
    defaults: { days: 7 },
    severity: 'warning',
  },
  low_volume_midweek: {
    title: 'Volume semanal em risco',
    description: 'Avisa se alguma conta está abaixo de X% da meta até um dia da semana.',
    defaults: { day_of_week: 4, percent: 50 }, // 4 = Thursday
    severity: 'info',
  },
  monthly_profit_target: {
    title: 'Meta mensal',
    description: 'Avisa se o lucro do mês atual está abaixo da meta configurada.',
    defaults: { target: 5000 },
    severity: 'info',
  },
};

function getAlertKeys() {
  return Object.keys(ALERT_DEFS);
}

function parseParams(row, key) {
  const def = ALERT_DEFS[key]?.defaults || {};
  if (!row?.params) return def;
  try {
    const p = JSON.parse(row.params);
    return { ...def, ...(p || {}) };
  } catch { return def; }
}

// Fetch user's config rows plus synthetic defaults for any alert type that
// hasn't been touched yet. Callers get a uniform list to render.
async function getConfigs(userId) {
  const rows = await db.all(
    'SELECT alert_key, enabled, params FROM alert_configs WHERE user_id = ?',
    userId
  );
  const byKey = new Map(rows.map(r => [r.alert_key, r]));
  return getAlertKeys().map(key => {
    const row = byKey.get(key);
    return {
      alert_key: key,
      enabled: row ? !!row.enabled : false,
      params: parseParams(row, key),
      def: {
        title: ALERT_DEFS[key].title,
        description: ALERT_DEFS[key].description,
        severity: ALERT_DEFS[key].severity,
        defaults: ALERT_DEFS[key].defaults,
      },
    };
  });
}

// --- Evaluators ---

async function evalInactivity(userId, params) {
  const days = Math.max(1, Number(params.days) || 3);
  const row = await db.get(
    'SELECT MAX(created_at) as last FROM operations WHERE user_id = ?',
    userId
  );
  if (!row?.last) {
    return { title: ALERT_DEFS.inactivity.title, message: 'Nenhuma operação registrada ainda.' };
  }
  const last = new Date(row.last);
  const diffDays = Math.floor((Date.now() - last.getTime()) / 86400000);
  if (diffDays >= days) {
    return {
      title: ALERT_DEFS.inactivity.title,
      message: `Última operação há ${diffDays} dia(s) (limite: ${days}).`,
      data: { last_at: row.last, diff_days: diffDays },
    };
  }
  return null;
}

async function evalStalePending(userId, params) {
  const days = Math.max(1, Number(params.days) || 7);
  const cutoffMs = Date.now() - days * 86400000;
  const cutoffIso = new Date(cutoffMs).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.all(
    `SELECT COUNT(*) as n FROM operations
     WHERE user_id = ? AND result = 'pending' AND created_at < ?`,
    userId, cutoffIso
  );
  const n = rows[0]?.n || 0;
  if (n > 0) {
    return {
      title: ALERT_DEFS.stale_pending.title,
      message: `${n} operação(ões) pendente(s) há mais de ${days} dia(s).`,
      data: { count: n, cutoff: cutoffIso },
    };
  }
  return null;
}

// Week-based check: if today is on/after configured day_of_week (0=Sun..6=Sat),
// any non-hidden account whose freebet-eligible volume is below percent% of the
// 1500 goal triggers.
async function evalLowVolumeMidweek(userId, params) {
  const targetDow = Math.max(0, Math.min(6, Number(params.day_of_week) ?? 4));
  const threshold = Math.max(1, Math.min(100, Number(params.percent) || 50));
  const today = new Date();
  if (today.getDay() < targetDow) return null; // too early in the week to flag

  // Week starts Monday (match dashboard conventions).
  const d = new Date(today);
  const dow = d.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + mondayOffset);
  d.setHours(0, 0, 0, 0);
  const weekStart = d.toISOString().slice(0, 10);
  const goal = 1500;
  const floor = goal * threshold / 100;

  const rows = await db.all(
    `SELECT a.id, a.name,
       COALESCE(SUM(CASE
         WHEN o.odd_bet365 >= 2.0 AND COALESCE(o.uses_freebet,0)=0
           AND COALESCE(o.event_date, DATE(o.created_at,'-3 hours')) >= ?
         THEN COALESCE(oa.stake_bet365, o.stake_bet365 * 1.0 / (
           SELECT COUNT(*) FROM operation_accounts oa2 WHERE oa2.operation_id = o.id
         )) ELSE 0 END), 0) as volume
     FROM accounts a
     LEFT JOIN operation_accounts oa ON oa.account_id = a.id
     LEFT JOIN operations o ON o.id = oa.operation_id AND o.user_id = a.user_id
     WHERE a.user_id = ? AND a.hidden = 0
     GROUP BY a.id, a.name`,
    weekStart, userId
  );
  const below = rows.filter(r => r.volume < floor);
  if (below.length === 0) return null;
  return {
    title: ALERT_DEFS.low_volume_midweek.title,
    message: `${below.length} conta(s) abaixo de ${threshold}% da meta semanal.`,
    data: { accounts: below.map(b => ({ name: b.name, volume: b.volume, goal })) },
  };
}

async function evalMonthlyProfitTarget(userId, params) {
  const target = Number(params.target) || 0;
  if (target <= 0) return null;
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const row = await db.get(
    `SELECT COALESCE(SUM(profit), 0) as p FROM operations
     WHERE user_id = ?
       AND result != 'pending'
       AND COALESCE(event_date, DATE(created_at, '-3 hours')) >= ?`,
    userId, monthStart
  );
  const profit = Number(row?.p) || 0;
  if (profit >= target) return null;
  return {
    title: ALERT_DEFS.monthly_profit_target.title,
    message: `Lucro do mês: R$ ${profit.toFixed(2)} / Meta: R$ ${target.toFixed(2)}`,
    data: { profit, target },
  };
}

const EVALUATORS = {
  inactivity: evalInactivity,
  stale_pending: evalStalePending,
  low_volume_midweek: evalLowVolumeMidweek,
  monthly_profit_target: evalMonthlyProfitTarget,
};

async function evaluateAll(userId) {
  const configs = await getConfigs(userId);
  const triggered = [];
  for (const c of configs) {
    if (!c.enabled) continue;
    const fn = EVALUATORS[c.alert_key];
    if (!fn) continue;
    try {
      const r = await fn(userId, c.params);
      if (r) {
        triggered.push({
          key: c.alert_key,
          severity: c.def.severity,
          ...r,
        });
      }
    } catch (err) {
      console.error('alert eval failed', c.alert_key, err);
    }
  }
  return triggered;
}

module.exports = { ALERT_DEFS, getConfigs, evaluateAll, getAlertKeys };
