// Security headers — CSP kept permissive for inline handlers/styles already
// in the codebase, but locks down connect/script/frame sources. When the
// frontend is refactored to drop inline handlers, tighten script-src.

const SELF = "'self'";

function buildCsp() {
  const directives = {
    'default-src': [SELF],
    // Inline scripts are used (onclick handlers); keep 'unsafe-inline'.
    // CDN needed for Chart.js bundle referenced in index.html.
    'script-src':  [SELF, "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
    'style-src':   [SELF, "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src':    [SELF, 'https://fonts.gstatic.com', 'data:'],
    // Discord avatars (user profile images); data: for fallback icons.
    'img-src':     [SELF, 'data:', 'https://cdn.discordapp.com'],
    // Client-side FX rate fetches hit these endpoints directly.
    'connect-src': [
      SELF,
      'https://api.binance.com',
      'https://open.er-api.com',
      'https://api.frankfurter.app',
    ],
    'frame-ancestors': ["'none'"],
    'base-uri': [SELF],
    'form-action': [SELF],
    'object-src': ["'none'"],
    'upgrade-insecure-requests': [],
  };
  return Object.entries(directives)
    .map(([k, v]) => v.length ? `${k} ${v.join(' ')}` : k)
    .join('; ');
}

const CSP = buildCsp();

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

module.exports = securityHeaders;
