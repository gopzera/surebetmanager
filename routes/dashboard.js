const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function getWeekStart(d) {
  const date = d ? new Date(d) : new Date();
  const dayOfWeek = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  return monday.toISOString().split('T')[0];
}

function getPrevMonthRange(todayStr) {
  const d = new Date(todayStr + 'T00:00:00');
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const last = new Date(d.getFullYear(), d.getMonth(), 0);
  return {
    start: first.toISOString().split('T')[0],
    end: last.toISOString().split('T')[0],
  };
}

router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];
    const weekStart = getWeekStart();
    const monthStart = today.substring(0, 7) + '-01';

    // Previous periods for comparison
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const prevWeekMonday = new Date(weekStart + 'T00:00:00');
    prevWeekMonday.setDate(prevWeekMonday.getDate() - 7);
    const prevWeekStart = prevWeekMonday.toISOString().split('T')[0];
    const prevWeekEnd = new Date(weekStart + 'T00:00:00');
    prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
    const prevWeekEndStr = prevWeekEnd.toISOString().split('T')[0];

    const prevMonth = getPrevMonthRange(today);

    const todayStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) = ?`,
      userId, today
    );

    const yesterdayStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) = ?`,
      userId, yesterdayStr
    );

    const weekStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) >= ?`,
      userId, weekStart
    );

    const prevWeekStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?`,
      userId, prevWeekStart, prevWeekEndStr
    );

    const monthStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) >= ?`,
      userId, monthStart
    );

    const prevMonthStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?`,
      userId, prevMonth.start, prevMonth.end
    );

    const allTimeStats = await db.get(
      `SELECT COALESCE(SUM(profit), 0) as profit, COUNT(*) as count
       FROM operations WHERE user_id = ?`,
      userId
    );

    // Average daily profit (for all-time comparison)
    const firstOp = await db.get(
      `SELECT DATE(created_at) as first_date FROM operations WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`,
      userId
    );
    let avgDailyProfit = 0;
    if (firstOp && firstOp.first_date) {
      const daysSinceFirst = Math.max(1, Math.ceil((new Date(today) - new Date(firstOp.first_date)) / 86400000));
      avgDailyProfit = allTimeStats.profit / daysSinceFirst;
    }

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
      const tagRows = await db.all(
        'SELECT tag FROM operation_tags WHERE operation_id = ?', op.id
      );
      op.tags = tagRows.map(r => r.tag);
    }

    res.json({
      today: todayStats,
      yesterday: yesterdayStats,
      week: weekStats,
      prevWeek: prevWeekStats,
      month: monthStats,
      prevMonth: prevMonthStats,
      allTime: allTimeStats,
      avgDailyProfit,
      accountVolumes,
      weeklyVolumeGoal: 1500,
      profitByType,
      dailyProfits,
      recentOps,
      weekStart
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
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
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
