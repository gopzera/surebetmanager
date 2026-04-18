const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { invalidateSession } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const V = require('../utils/validate');

const router = express.Router();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d, matches JWT expiry

const cookieOpts = {
  httpOnly: true,
  maxAge: SESSION_TTL_MS,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
};

// Mints a JWT and persists a matching session row. The jti lets us revoke
// individual sessions (logout, logout-all) without waiting for JWT expiry.
async function issueSession(req, res, payload) {
  const jti = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const ua = (req.headers['user-agent'] || '').slice(0, 255);
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
  await db.run(
    'INSERT INTO sessions (jti, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)',
    jti, payload.id, expiresAt, ua, ip
  );
  const token = jwt.sign({ ...payload, jti }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, cookieOpts);
  return token;
}

// Brute-force protection: tight window on credential endpoints.
// persistent=true: survives cold starts. Without this, on Vercel serverless
// an attacker can wait for a cold start to reset the counter.
const loginLimiter = rateLimit({
  name: 'auth-login', windowMs: 5 * 60 * 1000, max: 10, persistent: true,
  message: 'Muitas tentativas de login. Aguarde alguns minutos antes de tentar novamente.',
});
const registerLimiter = rateLimit({
  name: 'auth-register', windowMs: 60 * 60 * 1000, max: 5, persistent: true,
  message: 'Muitas tentativas de registro. Tente novamente mais tarde.',
});
const discordLimiter = rateLimit({
  name: 'auth-discord', windowMs: 60 * 1000, max: 20, persistent: true,
});

router.post('/register', registerLimiter, V.handle(async (req, res) => {
  const username = V.username(req.body.username);
  const password = V.password(req.body.password);
  const display_name = V.str(req.body.display_name, { min: 1, max: 64, name: 'Nome' });
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
    await issueSession(req, res, { id: result.lastInsertRowid, username, display_name });
    res.json({ id: result.lastInsertRowid, username, display_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}));

router.post('/login', loginLimiter, V.handle(async (req, res) => {
  // Login stays case-sensitive to preserve existing accounts registered
  // before username normalization was added. Only the format is validated.
  const username = V.str(req.body.username, { min: 1, max: 64, name: 'Usuário' });
  const password = V.password(req.body.password);
  try {
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    await issueSession(req, res, {
      id: user.id, username: user.username, display_name: user.display_name,
    });
    res.json({ id: user.id, username: user.username, display_name: user.display_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}));

router.post('/logout', async (req, res) => {
  // Best-effort revoke: decode without requiring a valid session (user may
  // be logging out because the session is already dead).
  try {
    const token = req.cookies?.token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.jti) {
        await db.run('UPDATE sessions SET revoked = 1 WHERE jti = ?', decoded.jti);
        invalidateSession(decoded.jti);
      }
    }
  } catch (_) { /* invalid/expired token — nothing to revoke */ }
  res.clearCookie('token');
  res.json({ ok: true });
});

// Revokes every session for the current user. Useful if the user suspects
// their account was accessed from another device.
router.post('/logout-all', auth, async (req, res) => {
  try {
    await db.run(
      'UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0',
      req.user.id
    );
    if (req.user.jti) invalidateSession(req.user.jti);
    res.clearCookie('token');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
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
router.get('/discord', discordLimiter, (req, res) => {
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
router.get('/discord/callback', discordLimiter, async (req, res) => {
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
      await issueSession(req, res, {
        id: user.id, username: user.username, display_name: user.display_name,
      });
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

      await issueSession(req, res, {
        id: user.id, username: user.username, display_name: user.display_name,
      });
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
