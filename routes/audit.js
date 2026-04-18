const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// User-visible audit trail. Filterable by entity/action and paginated.
router.get('/', async (req, res) => {
  try {
    const { entity, action, entity_id, from, to } = req.query;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let where = 'WHERE user_id = ?';
    const params = [req.user.id];
    if (entity) { where += ' AND entity = ?'; params.push(String(entity)); }
    if (action) { where += ' AND action = ?'; params.push(String(action)); }
    if (entity_id) { where += ' AND entity_id = ?'; params.push(Number(entity_id)); }
    if (from) { where += ' AND created_at >= ?'; params.push(String(from)); }
    if (to)   { where += ' AND created_at <= ?'; params.push(String(to) + ' 23:59:59'); }

    const rows = await db.all(
      `SELECT id, entity, entity_id, action, details, ip, user_agent, created_at
       FROM audit_log ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    for (const r of rows) {
      if (r.details) { try { r.details = JSON.parse(r.details); } catch { /* keep as string */ } }
    }
    const countRow = await db.get(
      `SELECT COUNT(*) as total FROM audit_log ${where}`, ...params
    );
    res.json({ rows, total: countRow?.total || 0, limit, offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
