const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:db/surebet.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  intMode: 'number',
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    show_in_ranking INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    max_stake_aumentada REAL NOT NULL DEFAULT 250,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('aquecimento', 'arbitragem', 'aumentada25')),
    game TEXT NOT NULL,
    event_date DATE,
    stake_bet365 REAL NOT NULL DEFAULT 0,
    odd_bet365 REAL NOT NULL DEFAULT 0,
    stake_poly_usd REAL NOT NULL DEFAULT 0,
    odd_poly REAL NOT NULL DEFAULT 0,
    exchange_rate REAL NOT NULL DEFAULT 5.0,
    result TEXT CHECK(result IN ('pending', 'bet365_won', 'poly_won', 'void')),
    profit REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS operation_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS freebets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER,
    week_start DATE NOT NULL,
    volume_accumulated REAL NOT NULL DEFAULT 0,
    freebet_earned INTEGER NOT NULL DEFAULT 0,
    freebet_used INTEGER NOT NULL DEFAULT 0,
    freebet_profit REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS watched_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    address TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS wallet_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL,
    condition_id TEXT NOT NULL,
    title TEXT,
    outcome TEXT,
    size REAL NOT NULL DEFAULT 0,
    avg_price REAL NOT NULL DEFAULT 0,
    current_value REAL NOT NULL DEFAULT 0,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    notified INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (wallet_id) REFERENCES watched_wallets(id) ON DELETE CASCADE,
    UNIQUE(wallet_id, condition_id)
  );

  CREATE TABLE IF NOT EXISTS wallet_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('new_position', 'position_closed', 'trade_buy', 'trade_sell')),
    condition_id TEXT,
    title TEXT,
    outcome TEXT,
    side TEXT,
    size REAL,
    price REAL,
    usdc_size REAL,
    timestamp DATETIME,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES watched_wallets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS operation_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
    UNIQUE(operation_id, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_operations_user ON operations(user_id);
  CREATE INDEX IF NOT EXISTS idx_operations_date ON operations(created_at);
  CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(type);
  CREATE INDEX IF NOT EXISTS idx_operation_tags_op ON operation_tags(operation_id);
  CREATE INDEX IF NOT EXISTS idx_operation_tags_tag ON operation_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_op_accounts_op ON operation_accounts(operation_id);
  CREATE INDEX IF NOT EXISTS idx_op_accounts_acc ON operation_accounts(account_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_freebets_user ON freebets(user_id);
  CREATE INDEX IF NOT EXISTS idx_watched_wallets_user ON watched_wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_positions_wallet ON wallet_positions(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_alerts_wallet ON wallet_alerts(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_alerts_seen ON wallet_alerts(seen);

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'general' CHECK(category IN ('general', 'system')),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    data TEXT,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_seen ON notifications(seen);
  CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category);

  CREATE TABLE IF NOT EXISTS admin_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_user_id INTEGER,
    target_operation_id INTEGER,
    details TEXT,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_admin_actions_admin ON admin_actions(admin_id);
  CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_user_id);

  CREATE TABLE IF NOT EXISTS giros_platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS giros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    profit REAL NOT NULL DEFAULT 0,
    operation_id INTEGER,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (platform_id) REFERENCES giros_platforms(id),
    FOREIGN KEY (operation_id) REFERENCES operations(id)
  );

  CREATE INDEX IF NOT EXISTS idx_giros_user ON giros(user_id);
  CREATE INDEX IF NOT EXISTS idx_giros_platform ON giros(platform_id);
  CREATE INDEX IF NOT EXISTS idx_giros_operation ON giros(operation_id);
  CREATE INDEX IF NOT EXISTS idx_giros_platforms_user ON giros_platforms(user_id);

  CREATE TABLE IF NOT EXISTS sessions (
    jti TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    revoked INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT,
    ip TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked);

  -- Freebet overrides: volume-based earning is derived from operations; this
  -- table only records exceptions (user didn't receive the freebet) and
  -- partial usage.
  CREATE TABLE IF NOT EXISTS freebet_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    week_start DATE NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0,
    used_amount REAL NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    UNIQUE(user_id, account_id, week_start)
  );

  CREATE INDEX IF NOT EXISTS idx_freebet_adj_user ON freebet_adjustments(user_id);

  -- Finance operators: people who operate bet365 accounts. Linked 1:N to
  -- accounts (one account can only belong to one operator). Payments are
  -- scheduled periodically (monthly/weekly/one-time) or triggered on demand.
  CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    notes TEXT,
    payment_type TEXT NOT NULL DEFAULT 'monthly' CHECK(payment_type IN ('monthly', 'weekly', 'one_time')),
    payment_value REAL NOT NULL DEFAULT 0,
    custom_payment_day INTEGER, -- 1-31 for monthly; 0-6 (0=Sun) for weekly; NULL => fallback to user default
    pix_key TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- account_id UNIQUE: two operators can't share an account.
  CREATE TABLE IF NOT EXISTS operator_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL UNIQUE,
    FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  -- Payments: one row per (operator, period).
  --   monthly period = YYYY-MM
  --   weekly period  = YYYY-MM-DD (week-start Monday)
  --   one_time period= YYYY-MM-DD (scheduled date)
  CREATE TABLE IF NOT EXISTS operator_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    operator_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    due_date DATE,
    amount REAL NOT NULL DEFAULT 0,
    tip REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'skipped')),
    paid_at DATETIME,
    receipt_data TEXT, -- base64 data URL (small images only)
    receipt_name TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE CASCADE,
    UNIQUE(operator_id, period)
  );

  CREATE INDEX IF NOT EXISTS idx_operators_user ON operators(user_id);
  CREATE INDEX IF NOT EXISTS idx_operator_payments_user ON operator_payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_operator_payments_op ON operator_payments(operator_id);
  CREATE INDEX IF NOT EXISTS idx_operator_payments_status ON operator_payments(status);
`;

let initPromise = null;

const db = {
  async init() {
    if (!initPromise) {
      initPromise = (async () => {
        // Local file mode: set SQLite pragmas
        if (!process.env.TURSO_DATABASE_URL) {
          try {
            await client.execute('PRAGMA journal_mode = WAL');
            await client.execute('PRAGMA foreign_keys = ON');
          } catch (_) {}
        }
        await client.executeMultiple(SCHEMA);
        // Migration: clear old position data that used conditionId without outcome suffix
        // This is safe because positions are re-fetched on next poll
        try {
          await client.execute(
            `DELETE FROM wallet_positions WHERE condition_id NOT LIKE '%/%'`
          );
        } catch (_) {}
        // Migration: add show_in_ranking column if missing
        try {
          await client.execute(
            `ALTER TABLE users ADD COLUMN show_in_ranking INTEGER NOT NULL DEFAULT 1`
          );
        } catch (_) {}
        // Migration: separate giros ranking opt-in from the main surebet ranking.
        try {
          await client.execute(
            `ALTER TABLE users ADD COLUMN show_in_giros_ranking INTEGER NOT NULL DEFAULT 1`
          );
        } catch (_) {}
        // Migration: aumentadas with 3+ Bet365 bets — extra bets as JSON
        // instead of being smuggled into notes.
        try {
          await client.execute(`ALTER TABLE operations ADD COLUMN extra_bets TEXT`);
        } catch (_) {}
        // Migration: flag Bet365 stake on an operation as paid with freebet
        // credit (affects volume counting and profit calc).
        try {
          await client.execute(`ALTER TABLE operations ADD COLUMN uses_freebet INTEGER NOT NULL DEFAULT 0`);
        } catch (_) {}
        // Migration: which account's freebet funds the main bet (when uses_freebet=1).
        // Per-extra-bet attribution lives inside the extra_bets JSON as {account_id}.
        try {
          await client.execute(`ALTER TABLE operations ADD COLUMN freebet_account_id INTEGER`);
        } catch (_) {}
        // Migration: add Discord columns if missing
        for (const col of [
          'discord_id TEXT',
          'discord_username TEXT',
          'discord_avatar TEXT',
        ]) {
          try {
            await client.execute(`ALTER TABLE users ADD COLUMN ${col}`);
          } catch (_) {}
        }
        // Migration: add stake_bet365 to operation_accounts (nullable = equal split)
        try {
          await client.execute(`ALTER TABLE operation_accounts ADD COLUMN stake_bet365 REAL`);
        } catch (_) {}
        // Migration: add hidden flag to accounts (soft-delete — preserves FK to historical ops)
        try {
          await client.execute(`ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
        } catch (_) {}
        // Migration: add Polymarket wallet + notification prefs to users
        for (const col of [
          'poly_wallet_address TEXT',
          'notify_fill_order INTEGER NOT NULL DEFAULT 0',
          'notify_fill_limit_order INTEGER NOT NULL DEFAULT 0',
          'notify_redeem INTEGER NOT NULL DEFAULT 0',
          'poly_last_activity_ts INTEGER NOT NULL DEFAULT 0',
          'is_admin INTEGER NOT NULL DEFAULT 0',
          // Finanças: default day-of-month (1..31) for operator payments.
          'default_payment_day INTEGER NOT NULL DEFAULT 5',
          'notify_operator_payment INTEGER NOT NULL DEFAULT 1',
        ]) {
          try {
            await client.execute(`ALTER TABLE users ADD COLUMN ${col}`);
          } catch (_) {}
        }
        // Bootstrap: promote usernames listed in BOOTSTRAP_ADMIN_USERNAMES (comma-separated).
        // Set once in the environment, redeploy, then unset — this is idempotent but
        // keeping the env var permanently means anyone with deploy access can re-promote.
        if (process.env.BOOTSTRAP_ADMIN_USERNAMES) {
          const names = process.env.BOOTSTRAP_ADMIN_USERNAMES
            .split(',').map(s => s.trim()).filter(Boolean);
          for (const name of names) {
            try {
              await client.execute({
                sql: 'UPDATE users SET is_admin = 1 WHERE username = ?',
                args: [name],
              });
            } catch (_) {}
          }
        }
      })();
    }
    return initPromise;
  },

  async all(sql, ...params) {
    await db.init();
    const r = await client.execute({ sql, args: params });
    return r.rows;
  },

  async get(sql, ...params) {
    await db.init();
    const r = await client.execute({ sql, args: params });
    return r.rows[0] || null;
  },

  async run(sql, ...params) {
    await db.init();
    const r = await client.execute({ sql, args: params });
    return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) };
  },

  async transaction(fn) {
    await db.init();
    const tx = await client.transaction('write');
    const txDb = {
      async all(sql, ...params) {
        return (await tx.execute({ sql, args: params })).rows;
      },
      async get(sql, ...params) {
        return (await tx.execute({ sql, args: params })).rows[0] || null;
      },
      async run(sql, ...params) {
        const r = await tx.execute({ sql, args: params });
        return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) };
      },
    };
    try {
      const result = await fn(txDb);
      await tx.commit();
      return result;
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      throw e;
    }
  },
};

module.exports = db;
