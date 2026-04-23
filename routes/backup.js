// User-scoped JSON backup / restore.
//
// GET  /api/backup          → dump of everything owned by the authenticated user.
//                              Excludes: password hash, sessions, audit logs,
//                              receipt blobs (too heavy), notifications (transient).
// POST /api/restore         → body { confirm: 'REPLACE', data: {...} } wipes the
//                              user's data and re-creates it from the snapshot.
//                              IDs are remapped (new autoinc ids), internal
//                              references are stitched via old→new id maps.
//
// Format is stable enough to move a user's data between Turso instances.

const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();
router.use(auth);

const BACKUP_VERSION = 1;

// ---------- EXPORT ----------

router.get('/backup', async (req, res) => {
  try {
    const uid = req.user.id;

    const user = await db.get(
      `SELECT id, username, display_name, show_in_ranking, show_in_giros_ranking,
              poly_wallet_address, notify_fill_order, notify_fill_limit_order,
              notify_redeem, default_payment_day, notify_operator_payment,
              dash_include_operators, created_at
         FROM users WHERE id = ?`,
      uid
    );

    const [
      accounts, operations, operationAccounts, operationTags,
      freebetAdjustments,
      girosPlatforms, giros,
      operators, operatorAccounts, operatorTags, operatorPayments,
      tagRules, savedFilters, alertConfigs,
      watchedWallets, walletPositions, walletAlerts,
    ] = await Promise.all([
      db.all('SELECT * FROM accounts WHERE user_id = ?', uid),
      db.all('SELECT * FROM operations WHERE user_id = ?', uid),
      db.all(
        `SELECT oa.* FROM operation_accounts oa
         JOIN operations o ON o.id = oa.operation_id
         WHERE o.user_id = ?`,
        uid
      ),
      db.all(
        `SELECT ot.* FROM operation_tags ot
         JOIN operations o ON o.id = ot.operation_id
         WHERE o.user_id = ?`,
        uid
      ),
      db.all('SELECT * FROM freebet_adjustments WHERE user_id = ?', uid),
      db.all('SELECT * FROM giros_platforms WHERE user_id = ?', uid),
      db.all('SELECT * FROM giros WHERE user_id = ?', uid),
      db.all('SELECT * FROM operators WHERE user_id = ?', uid),
      db.all(
        `SELECT oa.* FROM operator_accounts oa
         JOIN operators op ON op.id = oa.operator_id
         WHERE op.user_id = ?`,
        uid
      ),
      db.all(
        `SELECT ot.* FROM operator_tags ot
         JOIN operators op ON op.id = ot.operator_id
         WHERE op.user_id = ?`,
        uid
      ),
      db.all(
        `SELECT id, user_id, operator_id, period, due_date, amount, tip,
                status, paid_at, notes, created_at, updated_at
         FROM operator_payments WHERE user_id = ?`,
        uid
      ),
      safeAll(db, 'SELECT * FROM tag_rules WHERE user_id = ?', uid),
      safeAll(db, 'SELECT * FROM saved_filters WHERE user_id = ?', uid),
      safeAll(db, 'SELECT * FROM alert_configs WHERE user_id = ?', uid),
      db.all('SELECT * FROM watched_wallets WHERE user_id = ?', uid),
      db.all(
        `SELECT wp.* FROM wallet_positions wp
         JOIN watched_wallets w ON w.id = wp.wallet_id
         WHERE w.user_id = ?`,
        uid
      ),
      db.all(
        `SELECT wa.* FROM wallet_alerts wa
         JOIN watched_wallets w ON w.id = wa.wallet_id
         WHERE w.user_id = ?`,
        uid
      ),
    ]);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="surebet-backup-${user.username}-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json({
      version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      user,
      accounts, operations, operation_accounts: operationAccounts, operation_tags: operationTags,
      freebet_adjustments: freebetAdjustments,
      giros_platforms: girosPlatforms, giros,
      operators, operator_accounts: operatorAccounts,
      operator_tags: operatorTags, operator_payments: operatorPayments,
      tag_rules: tagRules, saved_filters: savedFilters, alert_configs: alertConfigs,
      watched_wallets: watchedWallets,
      wallet_positions: walletPositions, wallet_alerts: walletAlerts,
    });
  } catch (err) {
    console.error('backup error', err);
    res.status(500).json({ error: 'Falha ao gerar backup' });
  }
});

// Tables introduced by later migrations may not exist on older instances yet.
// Return [] instead of throwing so a backup still works during rollouts.
async function safeAll(db, sql, ...params) {
  try { return await db.all(sql, ...params); }
  catch { return []; }
}

// ---------- RESTORE ----------

router.post('/restore', async (req, res) => {
  try {
    const { confirm, data } = req.body || {};
    if (confirm !== 'REPLACE') {
      return res.status(400).json({
        error: 'Restore requer confirmação explícita (confirm=REPLACE).',
      });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Payload inválido' });
    }
    if (data.version !== BACKUP_VERSION) {
      return res.status(400).json({
        error: `Versão de backup incompatível: esperado ${BACKUP_VERSION}, recebido ${data.version}`,
      });
    }
    const uid = req.user.id;

    const counts = await db.transaction(async (tx) => {
      // 1. Wipe everything owned by this user. Order matters: children first.
      await tx.run(
        `DELETE FROM operation_tags WHERE operation_id IN
           (SELECT id FROM operations WHERE user_id = ?)`, uid);
      await tx.run(
        `DELETE FROM operation_accounts WHERE operation_id IN
           (SELECT id FROM operations WHERE user_id = ?)`, uid);
      await tx.run('DELETE FROM operations WHERE user_id = ?', uid);
      await tx.run('DELETE FROM freebet_adjustments WHERE user_id = ?', uid);
      await tx.run('DELETE FROM giros WHERE user_id = ?', uid);
      await tx.run('DELETE FROM giros_platforms WHERE user_id = ?', uid);
      await tx.run(
        `DELETE FROM operator_tags WHERE operator_id IN
           (SELECT id FROM operators WHERE user_id = ?)`, uid);
      await tx.run(
        `DELETE FROM operator_accounts WHERE operator_id IN
           (SELECT id FROM operators WHERE user_id = ?)`, uid);
      await tx.run('DELETE FROM operator_payments WHERE user_id = ?', uid);
      await tx.run('DELETE FROM operators WHERE user_id = ?', uid);
      await safeRun(tx, 'DELETE FROM tag_rules WHERE user_id = ?', uid);
      await safeRun(tx, 'DELETE FROM saved_filters WHERE user_id = ?', uid);
      await safeRun(tx, 'DELETE FROM alert_configs WHERE user_id = ?', uid);
      await tx.run(
        `DELETE FROM wallet_alerts WHERE wallet_id IN
           (SELECT id FROM watched_wallets WHERE user_id = ?)`, uid);
      await tx.run(
        `DELETE FROM wallet_positions WHERE wallet_id IN
           (SELECT id FROM watched_wallets WHERE user_id = ?)`, uid);
      await tx.run('DELETE FROM watched_wallets WHERE user_id = ?', uid);
      await tx.run('DELETE FROM accounts WHERE user_id = ?', uid);

      const c = { accounts: 0, operations: 0, operators: 0, giros: 0, wallets: 0 };

      // 2. Accounts — remap ids.
      const accMap = new Map();
      for (const a of (data.accounts || [])) {
        const r = await tx.run(
          `INSERT INTO accounts (user_id, name, max_stake_aumentada, active, hidden, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          uid, String(a.name || '').slice(0, 100),
          Number(a.max_stake_aumentada) || 250,
          a.active ? 1 : 0, a.hidden ? 1 : 0,
          a.created_at || null
        );
        accMap.set(a.id, r.lastInsertRowid);
        c.accounts++;
      }

      // 3. Operations + child rows (operation_accounts + tags).
      // Freebet ids need remapping because account ids changed in step 2;
      // we keep the legacy scalar column in sync with the first remapped id.
      const opMap = new Map();
      for (const o of (data.operations || [])) {
        let remappedIds = null;
        if (o.freebet_account_ids) {
          let raw = o.freebet_account_ids;
          if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
          if (Array.isArray(raw)) {
            const mapped = raw.map(id => accMap.get(Number(id))).filter(Boolean);
            if (mapped.length) remappedIds = mapped;
          }
        }
        const legacyRemapped = o.freebet_account_id != null ? (accMap.get(o.freebet_account_id) || null) : null;
        if (!remappedIds && legacyRemapped) remappedIds = [legacyRemapped];
        const r = await tx.run(
          `INSERT INTO operations
             (user_id, type, game, event_date, stake_bet365, odd_bet365,
              stake_poly_usd, odd_poly, exchange_rate, result, profit, notes,
              extra_bets, uses_freebet, freebet_account_id, freebet_account_ids, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uid, o.type, o.game, o.event_date || null,
          o.stake_bet365 || 0, o.odd_bet365 || 0,
          o.stake_poly_usd || 0, o.odd_poly || 0,
          o.exchange_rate || 5.0,
          o.result || 'pending', o.profit || 0, o.notes || null,
          o.extra_bets || null,
          o.uses_freebet ? 1 : 0,
          remappedIds && remappedIds.length ? remappedIds[0] : null,
          remappedIds && remappedIds.length ? JSON.stringify(remappedIds) : null,
          o.created_at || null
        );
        opMap.set(o.id, r.lastInsertRowid);
        c.operations++;
      }

      for (const oa of (data.operation_accounts || [])) {
        const newOpId = opMap.get(oa.operation_id);
        const newAccId = accMap.get(oa.account_id);
        if (!newOpId || !newAccId) continue;
        await tx.run(
          'INSERT INTO operation_accounts (operation_id, account_id, stake_bet365) VALUES (?, ?, ?)',
          newOpId, newAccId, oa.stake_bet365 ?? null
        );
      }
      for (const ot of (data.operation_tags || [])) {
        const newOpId = opMap.get(ot.operation_id);
        if (!newOpId || !ot.tag) continue;
        await tx.run(
          'INSERT OR IGNORE INTO operation_tags (operation_id, tag) VALUES (?, ?)',
          newOpId, String(ot.tag).slice(0, 64)
        );
      }

      // 4. Freebet adjustments (reference accounts).
      for (const fa of (data.freebet_adjustments || [])) {
        const newAccId = accMap.get(fa.account_id);
        if (!newAccId) continue;
        await tx.run(
          `INSERT OR IGNORE INTO freebet_adjustments
             (user_id, account_id, week_start, dismissed, used_amount, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          uid, newAccId, fa.week_start,
          fa.dismissed ? 1 : 0, fa.used_amount || 0, fa.updated_at || null
        );
      }

      // 5. Giros (platforms first for FK mapping).
      const platMap = new Map();
      for (const p of (data.giros_platforms || [])) {
        const r = await tx.run(
          'INSERT INTO giros_platforms (user_id, name, created_at) VALUES (?, ?, ?)',
          uid, String(p.name || '').slice(0, 80), p.created_at || null
        );
        platMap.set(p.id, r.lastInsertRowid);
      }
      for (const g of (data.giros || [])) {
        const newPlat = platMap.get(g.platform_id);
        if (!newPlat) continue;
        await tx.run(
          `INSERT INTO giros (user_id, platform_id, quantity, profit, operation_id, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          uid, newPlat, g.quantity || 0, g.profit || 0,
          g.operation_id ? (opMap.get(g.operation_id) || null) : null,
          g.notes || null, g.created_at || null
        );
        c.giros++;
      }

      // 6. Operators + children.
      const operMap = new Map();
      for (const op of (data.operators || [])) {
        const r = await tx.run(
          `INSERT INTO operators
             (user_id, name, notes, payment_type, payment_value,
              custom_payment_day, pix_key, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uid, op.name, op.notes || null,
          op.payment_type || 'monthly',
          op.payment_value || 0,
          op.custom_payment_day ?? null,
          op.pix_key || null,
          op.active ? 1 : 0,
          op.created_at || null
        );
        operMap.set(op.id, r.lastInsertRowid);
        c.operators++;
      }
      for (const oa of (data.operator_accounts || [])) {
        const newOper = operMap.get(oa.operator_id);
        const newAcc = accMap.get(oa.account_id);
        if (!newOper || !newAcc) continue;
        await tx.run(
          'INSERT OR IGNORE INTO operator_accounts (operator_id, account_id) VALUES (?, ?)',
          newOper, newAcc
        );
      }
      for (const ot of (data.operator_tags || [])) {
        const newOper = operMap.get(ot.operator_id);
        if (!newOper || !ot.tag) continue;
        await tx.run(
          'INSERT OR IGNORE INTO operator_tags (operator_id, tag) VALUES (?, ?)',
          newOper, String(ot.tag).slice(0, 64)
        );
      }
      for (const p of (data.operator_payments || [])) {
        const newOper = operMap.get(p.operator_id);
        if (!newOper) continue;
        await tx.run(
          `INSERT OR IGNORE INTO operator_payments
             (user_id, operator_id, period, due_date, amount, tip, status,
              paid_at, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uid, newOper, p.period, p.due_date || null,
          p.amount || 0, p.tip || 0, p.status || 'pending',
          p.paid_at || null, p.notes || null,
          p.created_at || null, p.updated_at || null
        );
      }

      // 7. Tag rules / saved filters / alert configs (user-level).
      for (const r of (data.tag_rules || [])) {
        await safeRun(tx,
          `INSERT INTO tag_rules (user_id, name, conditions, tag, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          uid, r.name, r.conditions, r.tag, r.enabled ? 1 : 0, r.created_at || null
        );
      }
      for (const f of (data.saved_filters || [])) {
        await safeRun(tx,
          `INSERT INTO saved_filters (user_id, view, name, filter_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          uid, f.view, f.name, f.filter_json, f.created_at || null
        );
      }
      for (const a of (data.alert_configs || [])) {
        await safeRun(tx,
          `INSERT INTO alert_configs (user_id, alert_key, enabled, params, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          uid, a.alert_key, a.enabled ? 1 : 0, a.params, a.created_at || null
        );
      }

      // 8. Watched wallets + children.
      const walletMap = new Map();
      for (const w of (data.watched_wallets || [])) {
        const r = await tx.run(
          'INSERT INTO watched_wallets (user_id, label, address, active, created_at) VALUES (?, ?, ?, ?, ?)',
          uid, w.label, w.address, w.active ? 1 : 0, w.created_at || null
        );
        walletMap.set(w.id, r.lastInsertRowid);
        c.wallets++;
      }
      for (const pos of (data.wallet_positions || [])) {
        const newW = walletMap.get(pos.wallet_id);
        if (!newW) continue;
        await tx.run(
          `INSERT OR IGNORE INTO wallet_positions
             (wallet_id, condition_id, title, outcome, size, avg_price,
              current_value, first_seen, last_seen, notified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newW, pos.condition_id, pos.title || null, pos.outcome || null,
          pos.size || 0, pos.avg_price || 0, pos.current_value || 0,
          pos.first_seen || null, pos.last_seen || null,
          pos.notified ? 1 : 0
        );
      }
      for (const al of (data.wallet_alerts || [])) {
        const newW = walletMap.get(al.wallet_id);
        if (!newW) continue;
        await tx.run(
          `INSERT INTO wallet_alerts
             (wallet_id, type, condition_id, title, outcome, side, size, price,
              usdc_size, timestamp, seen, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newW, al.type, al.condition_id || null, al.title || null,
          al.outcome || null, al.side || null,
          al.size ?? null, al.price ?? null, al.usdc_size ?? null,
          al.timestamp || null, al.seen ? 1 : 0, al.created_at || null
        );
      }

      return c;
    });

    audit(req, 'user', uid, 'restored_backup', counts).catch(() => {});
    res.json({ ok: true, restored: counts });
  } catch (err) {
    console.error('restore error', err);
    res.status(500).json({ error: 'Falha ao restaurar backup: ' + err.message });
  }
});

async function safeRun(tx, sql, ...params) {
  try { return await tx.run(sql, ...params); }
  catch { return { changes: 0 }; }
}

module.exports = router;
