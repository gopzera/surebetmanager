const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();

app.use(express.json());
app.use(cookieParser());

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/operations', require('./routes/operations'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/freebets', require('./routes/freebets'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/watcher', require('./routes/watcher'));

// Static files & SPA fallback (local dev only; Vercel handles via CDN + rewrites)
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

module.exports = app;
