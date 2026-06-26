const express = require('express');
const auth = require('../middleware/auth');
const db = require('../db/database');

const router = express.Router();
router.use(auth);

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB binary
const MAX_BIO_LEN = 280;

// Parse a base64 image data URL → { mime, buffer, size }. Images only.
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.*)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return null;
  const buffer = Buffer.from(m[2], 'base64');
  return { mime, buffer, size: buffer.length };
}

async function hasAvatar(userId) {
  const r = await db.get('SELECT 1 AS x FROM user_avatars WHERE user_id = ?', userId);
  return !!r;
}

// Current user's profile (bio + avatar preference + whether a custom image exists).
router.get('/', async (req, res) => {
  try {
    const u = await db.get('SELECT bio, avatar_source FROM users WHERE id = ?', req.user.id);
    res.json({ bio: (u && u.bio) || '', avatar_source: (u && u.avatar_source) || 'discord', has_avatar: await hasAvatar(req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Update bio and/or which avatar to use.
router.put('/', async (req, res) => {
  try {
    const sets = [];
    const params = [];
    if (req.body.bio !== undefined) {
      const bio = String(req.body.bio || '').slice(0, MAX_BIO_LEN);
      sets.push('bio = ?'); params.push(bio || null);
    }
    if (req.body.avatar_source !== undefined) {
      const src = req.body.avatar_source === 'custom' ? 'custom' : 'discord';
      if (src === 'custom' && !(await hasAvatar(req.user.id))) {
        return res.status(400).json({ error: 'Envie uma imagem antes de usá-la como avatar.' });
      }
      sets.push('avatar_source = ?'); params.push(src);
    }
    if (sets.length) {
      params.push(req.user.id);
      await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params);
    }
    const u = await db.get('SELECT bio, avatar_source FROM users WHERE id = ?', req.user.id);
    res.json({ ok: true, bio: (u && u.bio) || '', avatar_source: (u && u.avatar_source) || 'discord', has_avatar: await hasAvatar(req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Upload/replace the custom profile picture (data URL). Switches avatar_source to
// 'custom' so the new image takes effect immediately.
router.post('/avatar', async (req, res) => {
  try {
    const parsed = parseImageDataUrl(req.body && req.body.data);
    if (!parsed) return res.status(400).json({ error: 'Imagem inválida (use PNG, JPG, WEBP ou GIF).' });
    if (parsed.size > MAX_AVATAR_BYTES) return res.status(400).json({ error: 'Imagem muito grande (máx. 2MB).' });
    // INSERT OR REPLACE on the PK (user_id) keeps exactly one avatar per user.
    await db.run(
      'INSERT OR REPLACE INTO user_avatars (user_id, mime_type, size_bytes, data, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
      req.user.id, parsed.mime, parsed.size, parsed.buffer
    );
    await db.run("UPDATE users SET avatar_source = 'custom' WHERE id = ?", req.user.id);
    res.json({ ok: true, avatar_source: 'custom', has_avatar: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Remove the custom picture and fall back to the Discord avatar.
router.delete('/avatar', async (req, res) => {
  try {
    await db.run('DELETE FROM user_avatars WHERE user_id = ?', req.user.id);
    await db.run("UPDATE users SET avatar_source = 'discord' WHERE id = ?", req.user.id);
    res.json({ ok: true, avatar_source: 'discord', has_avatar: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Serve any user's custom avatar (shown in the group ranking). Auth-only, so it's
// not public, but any logged-in member can view another member's picture.
router.get('/avatar/:userId', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).end();
    const blob = await db.get('SELECT mime_type, size_bytes, data FROM user_avatars WHERE user_id = ?', userId);
    if (!blob) return res.status(404).end();
    const buf = Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data);
    res.setHeader('Content-Type', blob.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

module.exports = router;
