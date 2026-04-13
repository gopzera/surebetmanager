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
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
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
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, username, display_name, discord_id, discord_username, discord_avatar, is_admin FROM users WHERE id = ?',
      req.user.id
    );
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== DISCORD OAUTH2 =====

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_CDN = 'https://cdn.discordapp.com';

function getDiscordRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/auth/discord/callback`;
}

// Redirect to Discord OAuth2
// ?action=login (default) or ?action=link (requires auth cookie)
router.get('/discord', (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Discord OAuth não configurado' });

  const action = req.query.action || 'login';
  const state = Buffer.from(JSON.stringify({ action })).toString('base64url');
  const scopes = process.env.DISCORD_GUILD_ID ? 'identify guilds' : 'identify';
  const redirectUri = encodeURIComponent(getDiscordRedirectUri(req));

  res.redirect(
    `https://discord.com/oauth2/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${encodeURIComponent(scopes)}&state=${state}&prompt=consent`
  );
});

// Discord OAuth2 callback
router.get('/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/?discord_error=no_code');

  let action = 'login';
  try { action = JSON.parse(Buffer.from(state, 'base64url').toString()).action; } catch (_) {}

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.redirect('/?discord_error=not_configured');

  try {
    // Exchange code for token
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: getDiscordRedirectUri(req),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?discord_error=token_failed');

    const accessToken = tokenData.access_token;

    // Fetch Discord user profile
    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const discordUser = await userRes.json();
    if (!discordUser.id) return res.redirect('/?discord_error=profile_failed');

    // Guild restriction check
    const requiredGuild = process.env.DISCORD_GUILD_ID;
    if (requiredGuild) {
      const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const guilds = await guildsRes.json();
      if (!Array.isArray(guilds) || !guilds.some(g => g.id === requiredGuild)) {
        return res.redirect('/?discord_error=not_in_guild');
      }
    }

    const discordId = discordUser.id;
    const discordUsername = discordUser.global_name || discordUser.username;
    const discordAvatar = discordUser.avatar || null;

    if (action === 'link') {
      // Link Discord to existing account — requires valid auth cookie
      let userId;
      try {
        const decoded = jwt.verify(req.cookies?.token, process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {
        return res.redirect('/?discord_error=not_authenticated');
      }

      // Check if this Discord is already linked to another account
      const conflict = await db.get(
        'SELECT id FROM users WHERE discord_id = ? AND id != ?', discordId, userId
      );
      if (conflict) return res.redirect('/?discord_error=discord_already_linked');

      await db.run(
        'UPDATE users SET discord_id = ?, discord_username = ?, discord_avatar = ? WHERE id = ?',
        discordId, discordUsername, discordAvatar, userId
      );

      // Re-issue JWT with updated info
      const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
      const token = jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name },
        process.env.JWT_SECRET, { expiresIn: '30d' }
      );
      res.cookie('token', token, cookieOpts);
      return res.redirect('/?discord_linked=1');

    } else {
      // Login/register via Discord
      let user = await db.get('SELECT * FROM users WHERE discord_id = ?', discordId);

      if (!user) {
        // Auto-register: create account linked to Discord (no password)
        const username = `discord_${discordId}`;
        const hash = await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 10);
        const result = await db.run(
          'INSERT INTO users (username, password, display_name, discord_id, discord_username, discord_avatar) VALUES (?, ?, ?, ?, ?, ?)',
          username, hash, discordUsername, discordId, discordUsername, discordAvatar
        );
        user = await db.get('SELECT * FROM users WHERE id = ?', result.lastInsertRowid);
      } else {
        // Update Discord profile data on each login
        await db.run(
          'UPDATE users SET discord_username = ?, discord_avatar = ? WHERE id = ?',
          discordUsername, discordAvatar, user.id
        );
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name },
        process.env.JWT_SECRET, { expiresIn: '30d' }
      );
      res.cookie('token', token, cookieOpts);
      return res.redirect('/?discord_login=1');
    }
  } catch (err) {
    console.error('Discord OAuth error:', err);
    return res.redirect('/?discord_error=server_error');
  }
});

// Unlink Discord from account
router.post('/discord/unlink', auth, async (req, res) => {
  try {
    // Check user has a password set (not random hash from Discord-only registration)
    const user = await db.get('SELECT username FROM users WHERE id = ?', req.user.id);
    if (user && user.username.startsWith('discord_')) {
      return res.status(400).json({ error: 'Defina um usuário e senha antes de desvincular o Discord' });
    }
    await db.run(
      'UPDATE users SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL WHERE id = ?',
      req.user.id
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
