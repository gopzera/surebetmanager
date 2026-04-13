const db = require('../db/database');

// Rate limit (per IP) for admin endpoints.
// Simple fixed-window in-memory bucket — good enough to slow down abuse.
// Won't survive restarts or multi-instance, but raises the bar for scripted attacks.
const buckets = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 60;

function rateLimit(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.start > WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    return true;
  }
  b.count++;
  return b.count <= MAX_PER_WINDOW;
}

// Periodically prune old buckets to keep memory bounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (now - b.start > WINDOW_MS * 2) buckets.delete(ip);
  }
}, WINDOW_MS).unref?.();

async function requireAdmin(req, res, next) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    if (!rateLimit(ip || 'unknown')) {
      return res.status(429).json({ error: 'Muitas requisições. Tente novamente em instantes.' });
    }
    if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado' });
    const row = await db.get('SELECT is_admin FROM users WHERE id = ?', req.user.id);
    if (!row || !row.is_admin) {
      return res.status(403).json({ error: 'Acesso restrito' });
    }
    req.adminIp = ip;
    next();
  } catch (err) {
    console.error('requireAdmin error:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}

async function logAdminAction(adminId, ip, action, { targetUserId = null, targetOperationId = null, details = null } = {}) {
  try {
    await db.run(
      `INSERT INTO admin_actions (admin_id, action, target_user_id, target_operation_id, details, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      adminId, action, targetUserId, targetOperationId,
      details ? JSON.stringify(details) : null, ip || null
    );
  } catch (err) {
    console.error('logAdminAction error:', err);
  }
}

module.exports = { requireAdmin, logAdminAction };
