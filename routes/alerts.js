// User-configurable dashboard alerts (visual only — no push/email).
// GET  /api/alerts          → { triggered, configs }
// POST /api/alerts/config   → body { alert_key, enabled, params } upserts one row.

const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { evaluateAll, getConfigs, getAlertKeys } = require('../utils/alerts');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  try {
    const [configs, triggered] = await Promise.all([
      getConfigs(req.user.id),
      evaluateAll(req.user.id),
    ]);
    res.json({ configs, triggered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao avaliar alertas' });
  }
});

router.post('/config', async (req, res) => {
  try {
    const { alert_key, enabled, params } = req.body || {};
    if (!getAlertKeys().includes(alert_key)) {
      return res.status(400).json({ error: 'Tipo de alerta desconhecido' });
    }
    const paramsJson = JSON.stringify(params && typeof params === 'object' ? params : {});
    if (paramsJson.length > 1000) {
      return res.status(400).json({ error: 'Parâmetros muito grandes' });
    }
    await db.run(
      `INSERT INTO alert_configs (user_id, alert_key, enabled, params)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, alert_key) DO UPDATE SET
         enabled = excluded.enabled,
         params  = excluded.params`,
      req.user.id, alert_key, enabled ? 1 : 0, paramsJson
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao salvar configuração de alerta' });
  }
});

module.exports = router;
