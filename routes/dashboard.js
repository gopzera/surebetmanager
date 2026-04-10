const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function getWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  return monday.toISOString().split('T')[0];
}

router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];
    const weekStart = getWeekStart();
    const monthStart = today.substring(0, 7) + '-01';

    const todayStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) = ?`,
      userId, today
    );

    const weekStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) >= ?`,
      userId, weekStart
    );

    const monthStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) >= ?`,
      userId, monthStart
    );

    const allTimeStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ?`,
      userId
    );

    const accountVolumes = await db.all(
      `SELECT
        a.id as account_id,
        a.name as account_name,
        a.max_stake_aumentada,
        COALESCE(SUM(
          CASE WHEN o.odd_bet365 >= 2.0 AND DATE(o.created_at) >= ?
          THEN o.stake_bet365 * 1.0 / (
            SELECT COUNT(*) FROM operation_accounts oa2 WHERE oa2.operation_id = o.id
          )
          ELSE 0 END
        ), 0) as volume
      FROM accounts a
      LEFT JOIN operation_accounts oa ON oa.account_id = a.id
      LEFT JOIN operations o ON o.id = oa.operation_id AND o.user_id = ?
      WHERE a.user_id = ? AND a.active = 1
      GROUP BY a.id
      ORDER BY a.name`,
      weekStart, userId, userId
    );

    const profitByType = await db.all(
      `SELECT type, COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ?
       GROUP BY type`,
      userId
    );

    const dailyProfits = await db.all(
      `SELECT DATE(created_at) as date, SUM(profit) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) >= DATE('now', '-30 days')
       GROUP BY DATE(created_at)
       ORDER BY date`,
      userId
    );

    const recentOps = await db.all(
      'SELECT * FROM operations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
      userId
    );

    for (const op of recentOps) {
      op.accounts = await db.all(
        `SELECT a.id, a.name FROM operation_accounts oa
         JOIN accounts a ON a.id = oa.account_id
         WHERE oa.operation_id = ?`,
        op.id
      );
    }

    res.json({
      today: todayStats,
      week: weekStats,
      month: monthStats,
      allTime: allTimeStats,
      accountVolumes,
      weeklyVolumeGoal: 1500,
      profitByType,
      dailyProfits,
      recentOps,
      weekStart
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Data export / backup
router.get('/export', async (req, res) => {
  try {
    const userId = req.user.id;
    const operations = await db.all('SELECT * FROM operations WHERE user_id = ? ORDER BY created_at DESC', userId);
    for (const op of operations) {
      op.accounts = await db.all(
        `SELECT a.id, a.name FROM operation_accounts oa
         JOIN accounts a ON a.id = oa.account_id WHERE oa.operation_id = ?`, op.id
      );
    }
    const accounts = await db.all('SELECT * FROM accounts WHERE user_id = ?', userId);
    const freebets = await db.all('SELECT * FROM freebets WHERE user_id = ? ORDER BY week_start DESC', userId);

    res.setHeader('Content-Disposition', `attachment; filename=surebet-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.json({
      exported_at: new Date().toISOString(),
      user: { id: userId, display_name: req.user.display_name },
      accounts,
      operations,
      freebets,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
