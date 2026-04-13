// Double-submit cookie CSRF protection.
// - We mint a random token stored in a readable (non-HttpOnly) cookie.
// - The frontend reads it and echoes it in the `X-CSRF-Token` header on
//   state-changing requests.
// - The cookie is bound to the session via sameSite=lax, so cross-site
//   requests can't set the cookie and the attacker can't read it
//   (JS on other origins can't read our cookies).

const crypto = require('crypto');

const CSRF_COOKIE = 'csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Endpoints that must be reachable without a CSRF cookie (external redirects,
// cron jobs that bring their own auth mechanism).
const EXEMPT_PATHS = [
  /^\/api\/auth\/discord\/callback$/, // browser redirect from Discord
  /^\/api\/watcher\/cron-poll$/,       // secured by CRON_SECRET
  /^\/api\/notifications\/cron-poly-poll$/,
];

function isExempt(req) {
  return EXEMPT_PATHS.some(rx => rx.test(req.path));
}

function issueToken(res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,               // must be readable by JS
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  return token;
}

function verify(req) {
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.headers['x-csrf-token'];
  if (!cookie || !header) return false;
  if (typeof cookie !== 'string' || typeof header !== 'string') return false;
  if (cookie.length !== header.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
  } catch { return false; }
}

function csrfProtection(req, res, next) {
  // Seed the CSRF cookie on safe-method requests so the browser has a token
  // ready before its first mutation (login, etc.).
  if (SAFE_METHODS.has(req.method)) {
    if (!req.cookies?.[CSRF_COOKIE]) issueToken(res);
    return next();
  }
  if (isExempt(req)) return next();
  if (!verify(req)) {
    return res.status(403).json({ error: 'Falha de validação CSRF. Recarregue a página e tente novamente.' });
  }
  next();
}

module.exports = { csrfProtection, issueToken, CSRF_COOKIE };
