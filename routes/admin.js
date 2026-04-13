const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { requireAdmin, logAdminAction } = require('../middleware/requireAdmin');

const router = express.Router();
router.use(auth);
router.use(requireAdmin);

// ===== USERS =====

router.get('/users', async (req, res) => {
  try {
    const users = await db.all(
      `SELECT id, username, display_name, discord_id, discord_username, is_admin, created_at
       FROM users ORDER BY display_name`
    );
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== SYSTEM NOTIFICATIONS =====

router.post('/notifications', async (req, res) => {
  try {
    const { title, body, user_id } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    const cleanTitle = title.trim().slice(0, 200);
    const cleanBody = (body || '').trim().slice(0, 2000);

    let inserted = 0;
    if (user_id) {
      const target = await db.get('SELECT id FROM users WHERE id = ?', Number(user_id));
      if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
      await db.run(
        `INSERT INTO notifications (user_id, category, type, title, body)
         VALUES (?, 'system', 'system_update', ?, ?)`,
        target.id, cleanTitle, cleanBody || null
      );
      inserted = 1;
    } else {
      const users = await db.all('SELECT id FROM users');
      for (const u of users) {
        await db.run(
          `INSERT INTO notifications (user_id, category, type, title, body)
           VALUES (?, 'system', 'system_update', ?, ?)`,
          u.id, cleanTitle, cleanBody || null
        );
      }
      inserted = users.length;
    }

    await logAdminAction(req.user.id, req.adminIp, 'send_system_notification', {
      targetUserId: user_id ? Number(user_id) : null,
      details: { title: cleanTitle, body: cleanBody, inserted },
    });

    res.json({ ok: true, inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== OPERATIONS (any user) =====

router.get('/operations', async (req, res) => {
  try {
    const { user_id, limit = 100, offset = 0 } = req.query;
    let where = '';
    const params = [];
    if (user_id) { where = 'WHERE o.user_id = ?'; params.push(Number(user_id)); }

    const countRow = await db.get(`SELECT COUNT(*) as total FROM operations o ${where}`, ...params);
    const total = countRow ? countRow.total : 0;

    const operations = await db.all(
      `SELECT o.*, u.display_name as user_display_name, u.username as user_username
       FROM operations o
       JOIN users u ON u.id = o.user_id
       ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      ...params, Number(limit), Number(offset)
    );
    for (const op of operations) {
      op.accounts = await db.all(
        `SELECT a.id, a.name, oa.stake_bet365 as stake FROM operation_accounts oa
         JOIN accounts a ON a.id = oa.account_id
         WHERE oa.operation_id = ?`,
        op.id
      );
      const tagRows = await db.all('SELECT tag FROM operation_tags WHERE operation_id = ?', op.id);
      op.tags = tagRows.map(r => r.tag);
    }

    res.json({ operations, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.put('/operations/:id', async (req, res) => {
  try {
    const op = await db.get('SELECT * FROM operations WHERE id = ?', req.params.id);
    if (!op) return res.status(404).json({ error: 'Operação não encontrada' });

    const { type, game, event_date, stake_bet365, odd_bet365, stake_poly_usd,
            odd_poly, exchange_rate, result, profit, notes } = req.body;

    const before = {
      type: op.type, game: op.game, event_date: op.event_date,
      stake_bet365: op.stake_bet365, odd_bet365: op.odd_bet365,
      stake_poly_usd: op.stake_poly_usd, odd_poly: op.odd_poly,
      exchange_rate: op.exchange_rate, result: op.result,
      profit: op.profit, notes: op.notes,
    };

    await db.run(
      `UPDATE operations SET type=?, game=?, event_date=?, stake_bet365=?, odd_bet365=?,
        stake_poly_usd=?, odd_poly=?, exchange_rate=?, result=?, profit=?, notes=?
       WHERE id = ?`,
      type ?? op.type, game ?? op.game, event_date ?? op.event_date,
      stake_bet365 ?? op.stake_bet365, odd_bet365 ?? op.odd_bet365,
      stake_poly_usd ?? op.stake_poly_usd, odd_poly ?? op.odd_poly,
      exchange_rate ?? op.exchange_rate,
      result ?? op.result, profit ?? op.profit, notes ?? op.notes,
      op.id
    );

    await logAdminAction(req.user.id, req.adminIp, 'edit_operation', {
      targetUserId: op.user_id, targetOperationId: op.id,
      details: { before, after: req.body },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.delete('/operations/:id', async (req, res) => {
  try {
    const op = await db.get('SELECT * FROM operations WHERE id = ?', req.params.id);
    if (!op) return res.status(404).json({ error: 'Operação não encontrada' });

    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM operation_accounts WHERE operation_id = ?', op.id);
      await tx.run('DELETE FROM operation_tags WHERE operation_id = ?', op.id);
      await tx.run('DELETE FROM operations WHERE id = ?', op.id);
    });

    await logAdminAction(req.user.id, req.adminIp, 'delete_operation', {
      targetUserId: op.user_id, targetOperationId: op.id,
      details: { snapshot: op },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== AUDIT LOG =====

router.get('/actions', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const rows = await db.all(
      `SELECT aa.*, u.display_name as admin_display_name, t.display_name as target_display_name
       FROM admin_actions aa
       LEFT JOIN users u ON u.id = aa.admin_id
       LEFT JOIN users t ON t.id = aa.target_user_id
       ORDER BY aa.created_at DESC LIMIT ? OFFSET ?`,
      Number(limit), Number(offset)
    );
    for (const r of rows) {
      if (r.details) { try { r.details = JSON.parse(r.details); } catch { /* keep as string */ } }
    }
    res.json({ actions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
