const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { rateLimit } = require('./middleware/rateLimit');
const securityHeaders = require('./middleware/securityHeaders');
const { csrfProtection } = require('./middleware/csrf');

const app = express();

// Behind Vercel/Nginx — trust first hop so x-forwarded-for is honored.
app.set('trust proxy', 1);

app.use(securityHeaders);
// Finanças uploads base64 comprovantes (5MB binaries → ~7MB after base64 expansion).
app.use('/api/finances', express.json({ limit: '7mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Light global throttle — catches broad scraping/abuse without hitting normal users.
app.use('/api', rateLimit({
  name: 'global-api', windowMs: 60 * 1000, max: 300,
}));

// CSRF on all /api state-changing requests (exemptions declared in csrf.js).
app.use('/api', csrfProtection);

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/operations', require('./routes/operations'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/freebets', require('./routes/freebets'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/watcher', require('./routes/watcher'));
app.use('/api/ranking', require('./routes/ranking'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/giros', require('./routes/giros'));
app.use('/api/finances', require('./routes/finances'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/tag-rules', require('./routes/tagRules'));

// Static files & SPA fallback (local dev only; Vercel handles via CDN + rewrites)
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

module.exports = app;
