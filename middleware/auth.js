const jwt = require('jsonwebtoken');
const db = require('../db/database');

// Small in-process cache to avoid a DB roundtrip on every authenticated
// request. Revocation lag is bounded by CACHE_TTL_MS — acceptable for
// "logout" semantics; immediate propagation would require a shared cache.
const CACHE_TTL_MS = 30 * 1000;
const revokedCache = new Map(); // jti -> { revoked: bool, expiresAt: number }

function cacheGet(jti) {
  const e = revokedCache.get(jti);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { revokedCache.delete(jti); return null; }
  return e;
}

function cacheSet(jti, revoked) {
  revokedCache.set(jti, { revoked, expiresAt: Date.now() + CACHE_TTL_MS });
  // Opportunistic pruning so the map doesn't grow unbounded in long-lived
  // processes (local dev; Vercel cold-starts handle this for us).
  if (revokedCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of revokedCache) if (now > v.expiresAt) revokedCache.delete(k);
  }
}

async function authMiddleware(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Legacy tokens without jti predate the sessions table — accept them so
  // existing logins don't force a mass logout. New tokens (with jti) check
  // the revocation list.
  if (decoded.jti) {
    const cached = cacheGet(decoded.jti);
    let revoked;
    if (cached) {
      revoked = cached.revoked;
    } else {
      try {
        const row = await db.get(
          'SELECT revoked FROM sessions WHERE jti = ?', decoded.jti
        );
        revoked = !row || row.revoked === 1;
        cacheSet(decoded.jti, revoked);
      } catch {
        // DB unreachable — fail open on JWT alone rather than locking
        // everyone out. Cache nothing so we retry next request.
        revoked = false;
      }
    }
    if (revoked) {
      return res.status(401).json({ error: 'Sessão encerrada' });
    }
  }

  req.user = decoded;
  next();
}

// Exposed so /auth/logout can purge the cache immediately after revoking.
function invalidateSession(jti) {
  if (jti) revokedCache.delete(jti);
}

module.exports = authMiddleware;
module.exports.invalidateSession = invalidateSession;
