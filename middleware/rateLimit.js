// Generic fixed-window rate limiter.
// In-memory per-process — good enough to slow down brute-force and abuse.
// Won't survive restarts or multi-instance scale, but raises the bar meaningfully.

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

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .toString().split(',')[0].trim() || 'unknown';
}

/**
 * Build a rate-limit middleware.
 * @param {object} opts
 * @param {number} opts.windowMs - Window size in ms.
 * @param {number} opts.max - Max requests per window per key.
 * @param {string} opts.name - Namespace to isolate buckets per limiter.
 * @param {'ip'|'user'|'ip+route'} [opts.keyBy='ip'] - Key strategy.
 * @param {string} [opts.message] - Custom error message.
 */
function rateLimit({ windowMs, max, name, keyBy = 'ip', message }) {
  return function rateLimitMw(req, res, next) {
    let keyPart;
    if (keyBy === 'user') {
      keyPart = req.user?.id ? `u:${req.user.id}` : `ip:${getIp(req)}`;
    } else if (keyBy === 'ip+route') {
      keyPart = `${getIp(req)}|${req.method} ${req.path}`;
    } else {
      keyPart = `ip:${getIp(req)}`;
    }
    const key = `${name}|${keyPart}`;

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
