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
