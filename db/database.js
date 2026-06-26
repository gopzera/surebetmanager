const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

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
    type TEXT NOT NULL CHECK(type IN ('aquecimento', 'arbitragem', 'aumentada25', 'arbitragem_br', 'punter', 'tentativa_duplo')),
    game TEXT NOT NULL,
    event_date DATE,
    stake_bet365 REAL NOT NULL DEFAULT 0,
    odd_bet365 REAL NOT NULL DEFAULT 0,
    stake_poly_usd REAL NOT NULL DEFAULT 0,
    odd_poly REAL NOT NULL DEFAULT 0,
    exchange_rate REAL NOT NULL DEFAULT 5.0,
    result TEXT CHECK(result IN ('pending', 'bet365_won', 'poly_won', 'void', 'won', 'lost')),
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

  CREATE TABLE IF NOT EXISTS bookmakers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BRL' CHECK(currency IN ('BRL','USD')),
    is_builtin INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, name)
  );

  -- v2: every operation is a set of legs that reference a house (bookmaker).
  -- Replaces the bet365/poly fixed columns + the extra_bets JSON. stake is BRL;
  -- stake_orig/rate keep the entered value + USD→BRL conversion. role marks the
  -- main bet vs the protection (hedge). raw_bookmaker holds a legacy free-text
  -- house name pending curation (bookmaker_id NULL until mapped).
  CREATE TABLE IF NOT EXISTS operation_legs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id INTEGER NOT NULL,
    bookmaker_id INTEGER,
    role TEXT NOT NULL DEFAULT 'main',
    stake REAL NOT NULL DEFAULT 0,
    stake_orig REAL,
    currency TEXT NOT NULL DEFAULT 'BRL',
    rate REAL NOT NULL DEFAULT 1,
    odd REAL NOT NULL DEFAULT 0,
    won INTEGER NOT NULL DEFAULT 0,
    early_payout INTEGER NOT NULL DEFAULT 0,
    uses_freebet INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    raw_bookmaker TEXT,
    FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
    FOREIGN KEY (bookmaker_id) REFERENCES bookmakers(id)
  );

  -- v2: a single leg (e.g. a Bet365 side) can be split across N accounts for
  -- volume/freebet tracking. Generalizes the old operation_accounts.
  CREATE TABLE IF NOT EXISTS operation_leg_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leg_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    stake REAL,
    FOREIGN KEY (leg_id) REFERENCES operation_legs(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  -- Licensing payments (Mercado Pago). mp_payment_id UNIQUE makes the webhook
  -- idempotent (the same approved payment can't extend a license twice).
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'BRL',
    status TEXT NOT NULL DEFAULT 'pending',
    mp_preference_id TEXT,
    mp_payment_id TEXT UNIQUE,
    external_reference TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    approved_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_operations_user ON operations(user_id);
  CREATE INDEX IF NOT EXISTS idx_operations_date ON operations(created_at);
  CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(type);
  CREATE INDEX IF NOT EXISTS idx_operation_tags_op ON operation_tags(operation_id);
  CREATE INDEX IF NOT EXISTS idx_operation_tags_tag ON operation_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_op_accounts_op ON operation_accounts(operation_id);
  CREATE INDEX IF NOT EXISTS idx_op_accounts_acc ON operation_accounts(account_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_bookmakers_user ON bookmakers(user_id);
  CREATE INDEX IF NOT EXISTS idx_op_legs_op ON operation_legs(operation_id);
  CREATE INDEX IF NOT EXISTS idx_op_legs_bm ON operation_legs(bookmaker_id);
  CREATE INDEX IF NOT EXISTS idx_op_leg_accounts_leg ON operation_leg_accounts(leg_id);
  CREATE INDEX IF NOT EXISTS idx_op_leg_accounts_acc ON operation_leg_accounts(account_id);
  -- Recurring subscriptions (Mercado Pago preapproval). One row per preapproval;
  -- each authorized charge records a row in payments (mp_payment_id UNIQUE keeps
  -- license extension idempotent). status mirrors MP: pending, authorized,
  -- paused, cancelled.
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    payer_email TEXT,
    mp_preapproval_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
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

  -- Tags / groups for operators (e.g., "família", "time A", "freelance").
  CREATE TABLE IF NOT EXISTS operator_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE CASCADE,
    UNIQUE(operator_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_operator_tags_op ON operator_tags(operator_id);
  CREATE INDEX IF NOT EXISTS idx_operator_tags_tag ON operator_tags(tag);

  -- Audit log: every mutation to operators/payments gets a row for disputes.
  -- entity = 'operator' | 'payment' ; action = 'created' | 'updated' | 'deleted'
  --                                   | 'marked_paid' | 'receipt_uploaded' | ...
  -- details = JSON with before/after diff or metadata.
  CREATE TABLE IF NOT EXISTS operator_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    operator_id INTEGER,
    payment_id INTEGER,
    entity TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_operator_audit_user ON operator_audit(user_id);
  CREATE INDEX IF NOT EXISTS idx_operator_audit_op ON operator_audit(operator_id);

  -- Blob storage for comprovantes — separate table so the main payment row
  -- stays lightweight. Binary BLOB (not base64) saves ~33% vs data URL in TEXT.
  CREATE TABLE IF NOT EXISTS receipt_blobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    file_name TEXT,
    size_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_receipt_blobs_user ON receipt_blobs(user_id);
`;

// Versioned migrations live in /migrations as NNN_name.sql. Each file is
// applied at most once (tracked in schema_migrations). Use this path for NEW
// schema changes — the ad-hoc ALTER TABLE blocks below stay for legacy rows
// already deployed, but new changes should be migration files.
async function runMigrations() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const dir = path.join(__dirname, '..', 'migrations');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
  catch (_) { return; } // no migrations folder = nothing to do

  const applied = new Set(
    (await client.execute('SELECT version FROM schema_migrations')).rows
      .map(r => r.version)
  );

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await client.executeMultiple(sql);
    await client.execute({
      sql: 'INSERT INTO schema_migrations (version) VALUES (?)',
      args: [version],
    });
  }
}

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
        // Migration: comprovantes in dedicated blob table (BLOB, not base64).
        // Legacy receipt_data stays as fallback; new uploads go to receipt_blobs.
        try {
          await client.execute(`ALTER TABLE operator_payments ADD COLUMN receipt_blob_id INTEGER`);
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
          // Dashboard toggle: subtract operator costs from headline profit.
          'dash_include_operators INTEGER NOT NULL DEFAULT 0',
          // Access control / licensing: new users start blocked (must be granted
          // access or pay). license_expires_at NULL = no expiry (indefinite).
          "access_status TEXT NOT NULL DEFAULT 'blocked'",
          'license_expires_at DATETIME',
          'license_plan TEXT',
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
        // v2: accounts belong to a house; houses gain presentation + a reserved
        // rules slot (generic per-house rules come later).
        try { await client.execute(`ALTER TABLE accounts ADD COLUMN bookmaker_id INTEGER`); } catch (_) {}
        for (const col of ['icon TEXT', 'color TEXT', 'rules TEXT']) {
          try { await client.execute(`ALTER TABLE bookmakers ADD COLUMN ${col}`); } catch (_) {}
        }
        // Apply versioned migrations (runs after SCHEMA + legacy ALTERs so new
        // migrations can rely on columns those added).
        await runMigrations();
        // v2: backfill the relational leg model from legacy operations. Idempotent
        // (guarded by a schema_migrations marker); preserves all data, sends
        // unmatched free-text house names to curation.
        try { await require('./backfillLegs')(client); }
        catch (e) { console.error('[backfillLegs] failed', e?.message); }
        // Access control: grandfather all EXISTING users to active access on the
        // first boot after this feature ships (one-time, guarded). New signups
        // default to 'blocked'. Runs once so manually-blocked users aren't revived.
        try {
          const done = await client.execute({ sql: 'SELECT version FROM schema_migrations WHERE version = ?', args: ['grandfather_access_v1'] });
          if (!done.rows.length) {
            await client.execute("UPDATE users SET access_status = 'active' WHERE access_status = 'blocked'");
            await client.execute({ sql: 'INSERT INTO schema_migrations (version) VALUES (?)', args: ['grandfather_access_v1'] });
            console.log('[grandfather_access] existing users set to active');
          }
        } catch (e) { console.error('[grandfather_access] failed', e?.message); }
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
