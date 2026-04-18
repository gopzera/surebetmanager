const db = require('../db/database');

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .toString().split(',')[0].trim() || null;
}

// Fire-and-forget audit write. Never blocks the mutation — if the audit insert
// fails, we log and move on. Keep `details` small (JSON, ideally <2KB): pass
// a before/after diff or a minimal snapshot, not the whole row.
async function audit(req, entity, entityId, action, details) {
  try {
    await db.run(
      `INSERT INTO audit_log (user_id, entity, entity_id, action, details, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      req.user.id,
      entity,
      entityId || null,
      action,
      details ? JSON.stringify(details) : null,
      getIp(req),
      ((req.headers['user-agent'] || '') + '').slice(0, 200) || null
    );
  } catch (err) {
    console.error('[audit] write failed', err?.message);
  }
}

// Compute a shallow before/after diff for an update. Only includes keys whose
// values actually changed. Avoids logging unchanged fields — keeps the row small
// and the history readable.
function diff(before, after) {
  const b = {}, a = {};
  for (const k of Object.keys(after)) {
    const bv = before?.[k];
    const av = after[k];
    const same = bv === av || (bv == null && av == null);
    if (!same) { b[k] = bv ?? null; a[k] = av ?? null; }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

module.exports = { audit, diff };
