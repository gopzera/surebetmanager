const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { audit } = require('../utils/audit');
const { ALLOWED_FIELDS, NUMERIC_OPS, STRING_OPS } = require('../utils/tagRules');

const router = express.Router();
router.use(auth);

function validateConditions(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const clean = [];
  for (const c of input) {
    if (!c || !ALLOWED_FIELDS.has(c.field)) return null;
    const op = String(c.op || '');
    if (!NUMERIC_OPS.has(op) && !STRING_OPS.has(op)) return null;
    if (c.value === undefined || c.value === null || c.value === '') return null;
    clean.push({ field: c.field, op, value: c.value });
  }
  return clean;
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, name, conditions, tag, enabled, created_at
       FROM tag_rules WHERE user_id = ? ORDER BY created_at DESC`,
      req.user.id
    );
    for (const r of rows) {
      try { r.conditions = JSON.parse(r.conditions); } catch { r.conditions = []; }
      r.enabled = !!r.enabled;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, conditions, tag, enabled } = req.body;
    const nm = String(name || '').trim();
    const tg = String(tag || '').trim().toLowerCase();
    const conds = validateConditions(conditions);
    if (!nm || !tg || !conds) {
      return res.status(400).json({ error: 'Nome, tag e pelo menos uma condição válida são obrigatórios' });
    }
    const r = await db.run(
      `INSERT INTO tag_rules (user_id, name, conditions, tag, enabled)
       VALUES (?, ?, ?, ?, ?)`,
      req.user.id, nm, JSON.stringify(conds), tg, enabled === false ? 0 : 1
    );
    await audit(req, 'tag_rule', r.lastInsertRowid, 'created', { name: nm, tag: tg });
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const rule = await db.get(
      'SELECT id, name, tag FROM tag_rules WHERE id = ? AND user_id = ?',
      req.params.id, req.user.id
    );
    if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });

    const { name, conditions, tag, enabled } = req.body;
    const nm = name !== undefined ? String(name).trim() : rule.name;
    const tg = tag  !== undefined ? String(tag).trim().toLowerCase() : rule.tag;
    let condsJson;
    if (conditions !== undefined) {
      const conds = validateConditions(conditions);
      if (!conds) return res.status(400).json({ error: 'Condições inválidas' });
      condsJson = JSON.stringify(conds);
    }
    await db.run(
      `UPDATE tag_rules SET
         name = ?,
         tag = ?,
         conditions = COALESCE(?, conditions),
         enabled = ?
       WHERE id = ?`,
      nm, tg, condsJson ?? null, enabled === undefined ? 1 : (enabled ? 1 : 0),
      rule.id
    );
    await audit(req, 'tag_rule', rule.id, 'updated', { name: nm, tag: tg });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const rule = await db.get(
      'SELECT id, name FROM tag_rules WHERE id = ? AND user_id = ?',
      req.params.id, req.user.id
    );
    if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
    await db.run('DELETE FROM tag_rules WHERE id = ?', rule.id);
    await audit(req, 'tag_rule', rule.id, 'deleted', { name: rule.name });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
