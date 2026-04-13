const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// ===== PLATFORMS =====

router.get('/platforms', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT * FROM giros_platforms WHERE user_id = ? ORDER BY name',
      req.user.id
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.post('/platforms', async (req, res) => {
  try {
    const { name } = req.body;
    const clean = (name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Nome obrigatório' });
    const existing = await db.get(
      'SELECT id FROM giros_platforms WHERE user_id = ? AND LOWER(name) = LOWER(?)',
      req.user.id, clean
    );
    if (existing) return res.status(400).json({ error: 'Plataforma já cadastrada' });
    const r = await db.run(
      'INSERT INTO giros_platforms (user_id, name) VALUES (?, ?)',
      req.user.id, clean
    );
    res.json({ id: r.lastInsertRowid, name: clean });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.delete('/platforms/:id', async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const p = await db.get('SELECT id FROM giros_platforms WHERE id = ? AND user_id = ?', pid, req.user.id);
    if (!p) return res.status(404).json({ error: 'Plataforma não encontrada' });
    const inUse = await db.get('SELECT id FROM giros WHERE platform_id = ? LIMIT 1', pid);
    if (inUse) return res.status(400).json({ error: 'Plataforma possui giros registrados — exclua-os primeiro' });
    await db.run('DELETE FROM giros_platforms WHERE id = ?', pid);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ===== GIROS =====

async function attachGiro(g) {
  if (g.operation_id) {
    const op = await db.get(
      'SELECT id, game, profit, type, created_at FROM operations WHERE id = ? AND user_id = ?',
      g.operation_id, g.user_id
    );
    g.operation = op || null;
  } else {
    g.operation = null;
  }
  return g;
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT g.*, p.name as platform_name
       FROM giros g
       JOIN giros_platforms p ON p.id = g.platform_id
       WHERE g.user_id = ?
       ORDER BY g.created_at DESC`,
      req.user.id
    );
    for (const r of rows) await attachGiro(r);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.post('/', async (req, res) => {
  try {
    const { platform_id, quantity, profit, operation_id, notes } = req.body;
    const pid = Number(platform_id);
    if (!pid) return res.status(400).json({ error: 'Plataforma obrigatória' });
    const p = await db.get('SELECT id FROM giros_platforms WHERE id = ? AND user_id = ?', pid, req.user.id);
    if (!p) return res.status(400).json({ error: 'Plataforma inválida' });

    let opId = null;
    if (operation_id) {
      const op = await db.get('SELECT id FROM operations WHERE id = ? AND user_id = ?', Number(operation_id), req.user.id);
      if (!op) return res.status(400).json({ error: 'Operação inválida' });
      opId = op.id;
    }

    const r = await db.run(
      `INSERT INTO giros (user_id, platform_id, quantity, profit, operation_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      req.user.id, pid,
      Number(quantity) || 0,
      Number(profit) || 0,
      opId,
      (notes || '').trim() || null
    );
    res.json({ id: r.lastInsertRowid });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.put('/:id', async (req, res) => {
  try {
    const g = await db.get('SELECT * FROM giros WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!g) return res.status(404).json({ error: 'Giro não encontrado' });
    const { platform_id, quantity, profit, operation_id, notes } = req.body;

    let pid = g.platform_id;
    if (platform_id !== undefined) {
      const p = await db.get('SELECT id FROM giros_platforms WHERE id = ? AND user_id = ?', Number(platform_id), req.user.id);
      if (!p) return res.status(400).json({ error: 'Plataforma inválida' });
      pid = p.id;
    }

    let opId = g.operation_id;
    if (operation_id !== undefined) {
      if (operation_id === null || operation_id === '') {
        opId = null;
      } else {
        const op = await db.get('SELECT id FROM operations WHERE id = ? AND user_id = ?', Number(operation_id), req.user.id);
        if (!op) return res.status(400).json({ error: 'Operação inválida' });
        opId = op.id;
      }
    }

    await db.run(
      `UPDATE giros SET platform_id=?, quantity=?, profit=?, operation_id=?, notes=? WHERE id = ?`,
      pid,
      quantity !== undefined ? Number(quantity) || 0 : g.quantity,
      profit !== undefined ? Number(profit) || 0 : g.profit,
      opId,
      notes !== undefined ? ((notes || '').trim() || null) : g.notes,
      g.id
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const g = await db.get('SELECT id FROM giros WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!g) return res.status(404).json({ error: 'Giro não encontrado' });
    await db.run('DELETE FROM giros WHERE id = ?', g.id);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

module.exports = router;
