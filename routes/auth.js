const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();

const cookieOpts = {
  httpOnly: true,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
};

router.post('/register', async (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }
  try {
    const existing = await db.get('SELECT id FROM users WHERE username = ?', username);
    if (existing) {
      return res.status(400).json({ error: 'Usuário já existe' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await db.run(
      'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)',
      username, hash, display_name
    );
    const token = jwt.sign(
      { id: result.lastInsertRowid, username, display_name },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );
    res.cookie('token', token, cookieOpts);
    res.json({ id: result.lastInsertRowid, username, display_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }
  try {
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, display_name: user.display_name },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );
    res.cookie('token', token, cookieOpts);
    res.json({ id: user.id, username: user.username, display_name: user.display_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', auth, (req, res) => {
  res.json(req.user);
});

module.exports = router;
