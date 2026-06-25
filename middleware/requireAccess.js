const db = require('../db/database');

// Parse a DB timestamp as UTC. Handles ISO ('...Z') and SQLite's
// 'YYYY-MM-DD HH:MM:SS' (which is UTC but timezone-less).
function parseUtc(v) {
  if (!v) return null;
  const s = /[tT]/.test(v)
    ? v
    : v.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Effective access from a user row. Admins always have access; otherwise the
// account must be 'active' and the license (if any) not expired. A NULL
// license_expires_at means no expiry (indefinite).
function computeAccess(userRow) {
  const isAdmin = !!userRow.is_admin;
  const status = userRow.access_status || 'blocked';
  const exp = parseUtc(userRow.license_expires_at);
  const notExpired = !exp || exp.getTime() > Date.now();
  const hasAccess = isAdmin || (status === 'active' && notExpired);
  const days_remaining = exp ? Math.max(0, Math.ceil((exp.getTime() - Date.now()) / 86400000)) : null;
  return {
    has_access: hasAccess,
    is_admin: isAdmin,
    access_status: status,
    license_expires_at: userRow.license_expires_at || null,
    license_plan: userRow.license_plan || null,
    days_remaining,
  };
}

// Gate feature routes behind an active license. Apply AFTER the auth middleware.
// Blocked users get 402 with code 'no_access' so the frontend can show the
// paywall. Do NOT apply to auth/admin/payments routes.
async function requireAccess(req, res, next) {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado' });
    const row = await db.get(
      'SELECT is_admin, access_status, license_expires_at, license_plan FROM users WHERE id = ?',
      req.user.id
    );
    if (!row) return res.status(401).json({ error: 'Usuário não encontrado' });
    const acc = computeAccess(row);
    if (!acc.has_access) {
      return res.status(402).json({
        error: 'Acesso bloqueado — assine para usar o site.',
        code: 'no_access',
        access_status: acc.access_status,
        license_expires_at: acc.license_expires_at,
      });
    }
    next();
  } catch (err) {
    console.error('requireAccess error:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}

module.exports = { requireAccess, computeAccess, parseUtc };
