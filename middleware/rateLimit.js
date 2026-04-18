// Generic fixed-window rate limiter.
//
// Two modes:
//   persistent=false (default): in-memory Map, fast, resets on cold start.
//     Use for spam/noise protection where bypass isn't security-critical.
//   persistent=true: DB-backed, survives cold starts. Use for auth paths
//     (login/register/discord) where an attacker could otherwise just wait
//     out a restart to reset the counter.

const db = require('../db/database');

const buckets = new Map();

// Periodically prune old buckets to keep memory bounded (runs once per process).
if (!global.__rateLimitPruner) {
  global.__rateLimitPruner = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (now - b.start > b.windowMs * 2) buckets.delete(key);
    }
  }, 60 * 1000);
  global.__rateLimitPruner.unref?.();
}

// Best-effort DB cleanup — runs at most every 5 minutes per process.
let lastDbPrune = 0;
async function pruneDbIfDue(now) {
  if (now - lastDbPrune < 5 * 60 * 1000) return;
  lastDbPrune = now;
  try {
    await db.run(
      'DELETE FROM rate_limit_buckets WHERE window_start < ?',
      now - 60 * 60 * 1000
    );
  } catch (_) {}
}

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .toString().split(',')[0].trim() || 'unknown';
}

function buildKey(req, name, keyBy) {
  let keyPart;
  if (keyBy === 'user') {
    keyPart = req.user?.id ? `u:${req.user.id}` : `ip:${getIp(req)}`;
  } else if (keyBy === 'ip+route') {
    keyPart = `${getIp(req)}|${req.method} ${req.path}`;
  } else {
    keyPart = `ip:${getIp(req)}`;
  }
  return `${name}|${keyPart}`;
}

// Atomic upsert: insert a fresh bucket OR increment the current one OR reset
// if the stored window has expired. Returns the post-op {count, window_start}.
async function hitDbBucket(key, now, windowMs) {
  const cutoff = now - windowMs;
  // SQLite UPSERT with RETURNING (libSQL supports both).
  const r = await db.get(
    `INSERT INTO rate_limit_buckets (key, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limit_buckets.window_start < ? THEN 1
                    ELSE rate_limit_buckets.count + 1 END,
       window_start = CASE WHEN rate_limit_buckets.window_start < ? THEN ?
                           ELSE rate_limit_buckets.window_start END
     RETURNING count, window_start`,
    key, now, cutoff, cutoff, now
  );
  return r || { count: 1, window_start: now };
}

/**
 * Build a rate-limit middleware.
 * @param {object} opts
 * @param {number} opts.windowMs - Window size in ms.
 * @param {number} opts.max - Max requests per window per key.
 * @param {string} opts.name - Namespace to isolate buckets per limiter.
 * @param {'ip'|'user'|'ip+route'} [opts.keyBy='ip'] - Key strategy.
 * @param {string} [opts.message] - Custom error message.
 * @param {boolean} [opts.persistent=false] - Back buckets with DB (survives restarts).
 */
function rateLimit({ windowMs, max, name, keyBy = 'ip', message, persistent = false }) {
  if (persistent) {
    return async function rateLimitPersistentMw(req, res, next) {
      const now = Date.now();
      const key = buildKey(req, name, keyBy);
      try {
        const row = await hitDbBucket(key, now, windowMs);
        pruneDbIfDue(now); // fire-and-forget
        if (row.count > max) {
          const retrySec = Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000));
          res.setHeader('Retry-After', retrySec);
          return res.status(429).json({
            error: message || 'Muitas requisições. Tente novamente em instantes.',
            retry_after: retrySec,
          });
        }
        next();
      } catch (err) {
        // Fail-open: if the DB is down, don't block legitimate users.
        console.error('rateLimit DB error', err);
        next();
      }
    };
  }

  return function rateLimitMw(req, res, next) {
    const key = buildKey(req, name, keyBy);
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now - b.start > windowMs) {
      buckets.set(key, { start: now, count: 1, windowMs });
      return next();
    }
    b.count++;
    if (b.count > max) {
      const retrySec = Math.ceil((b.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({
        error: message || 'Muitas requisições. Tente novamente em instantes.',
        retry_after: retrySec,
      });
    }
    next();
  };
}

module.exports = { rateLimit };
