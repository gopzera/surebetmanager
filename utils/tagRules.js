// Evaluates a user's tag rules against an operation payload and returns the
// extra tags that should be attached. Called from POST/PUT /api/operations so
// rules fire on both creation and edit.

const ALLOWED_FIELDS = new Set([
  'type', 'game', 'notes',
  'odd_bet365', 'odd_poly',
  'stake_bet365', 'stake_poly_usd',
  'profit',
  'result',
]);

const NUMERIC_OPS = new Set(['>', '>=', '<', '<=', '==', '!=']);
const STRING_OPS  = new Set(['==', '!=', 'contains', 'not_contains']);

function normalize(v) {
  if (v === undefined || v === null) return null;
  return v;
}

function evalCondition(op, cond) {
  const field = cond && cond.field;
  const operator = cond && cond.op;
  const value = cond && cond.value;
  if (!field || !operator || value === undefined) return false;
  if (!ALLOWED_FIELDS.has(field)) return false;

  const raw = normalize(op[field]);
  const numericField = !['type', 'game', 'notes', 'result'].includes(field);

  if (numericField && NUMERIC_OPS.has(operator)) {
    const a = Number(raw);
    const b = Number(value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    switch (operator) {
      case '>':  return a > b;
      case '>=': return a >= b;
      case '<':  return a < b;
      case '<=': return a <= b;
      case '==': return a === b;
      case '!=': return a !== b;
    }
  }
  if (!numericField && STRING_OPS.has(operator)) {
    const a = raw == null ? '' : String(raw).toLowerCase();
    const b = String(value).toLowerCase();
    switch (operator) {
      case '==':           return a === b;
      case '!=':           return a !== b;
      case 'contains':     return b !== '' && a.includes(b);
      case 'not_contains': return b === '' || !a.includes(b);
    }
  }
  return false;
}

// Returns array of tag strings (lowercased, trimmed, deduped) that should be
// applied to `op` based on the user's enabled rules.
async function evaluateRules(db, userId, op) {
  const rules = await db.all(
    `SELECT conditions, tag FROM tag_rules WHERE user_id = ? AND enabled = 1`,
    userId
  );
  const tags = new Set();
  for (const r of rules) {
    let conds;
    try { conds = JSON.parse(r.conditions); } catch { continue; }
    if (!Array.isArray(conds) || conds.length === 0) continue;
    const allMatch = conds.every(c => evalCondition(op, c));
    if (allMatch) {
      const t = String(r.tag || '').trim().toLowerCase();
      if (t) tags.add(t);
    }
  }
  return [...tags];
}

module.exports = { evaluateRules, ALLOWED_FIELDS, NUMERIC_OPS, STRING_OPS };
