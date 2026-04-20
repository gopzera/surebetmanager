// Per-user named filter presets, scoped by "view" (history, etc.).
// The server just stores the opaque JSON payload; the view interprets it.

const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const ALLOWED_VIEWS = new Set(['history']);

function cleanView(v) {
  return ALLOWED_VIEWS.has(v) ? v : null;
}

router.get('/', async (req, res) => {
  try {
    const view = cleanView(req.query.view);
    const rows = view
      ? await db.all(
          'SELECT id, view, name, filter_json, created_at FROM saved_filters WHERE user_id = ? AND view = ? ORDER BY name',
          req.user.id, view
        )
      : await db.all(
          'SELECT id, view, name, filter_json, created_at FROM saved_filters WHERE user_id = ? ORDER BY view, name',
          req.user.id
        );
    const filters = rows.map(r => {
      let parsed = null;
      try { parsed = JSON.parse(r.filter_json); } catch {}
      return { id: r.id, view: r.view, name: r.name, filter: parsed, created_at: r.created_at };
    });
    res.json({ filters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar filtros' });
  }
});

router.post('/', async (req, res) => {
  try {
    const view = cleanView(req.body?.view);
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const filter = req.body?.filter;
    if (!view) return res.status(400).json({ error: 'View inválida' });
    if (!name) return res.status(400).json({ error: 'Nome do filtro é obrigatório' });
    if (!filter || typeof filter !== 'object') {
      return res.status(400).json({ error: 'Filtro inválido' });
    }
    const json = JSON.stringify(filter);
    if (json.length > 4000) {
      return res.status(400).json({ error: 'Filtro muito grande' });
    }
    // UPSERT so the client can re-save an existing name to overwrite.
    const r = await db.run(
      `INSERT INTO saved_filters (user_id, view, name, filter_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, view, name) DO UPDATE SET
         filter_json = excluded.filter_json`,
      req.user.id, view, name, json
    );
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao salvar filtro' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
    const r = await db.run(
      'DELETE FROM saved_filters WHERE id = ? AND user_id = ?',
      id, req.user.id
    );
    if (r.changes === 0) return res.status(404).json({ error: 'Filtro não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir filtro' });
  }
});

module.exports = router;
