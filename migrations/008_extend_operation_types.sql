-- Estende a CHECK constraint de operations.type para incluir 'arbitragem_br'
-- (já usado no app — antes falhava silenciosamente em "erro interno") e o novo
-- tipo 'punter' (aposta single-leg sem proteção).
--
-- SQLite não permite ALTER CHECK; precisa recriar a tabela. Mantemos todos os
-- dados, FKs (operation_accounts, operation_tags, giros) seguem referenciando
-- operations.id que preservamos via INSERT SELECT.

PRAGMA foreign_keys = OFF;

CREATE TABLE operations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('aquecimento', 'arbitragem', 'aumentada25', 'arbitragem_br', 'punter')),
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
  extra_bets TEXT,
  uses_freebet INTEGER NOT NULL DEFAULT 0,
  freebet_account_id INTEGER,
  freebet_account_ids TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO operations_new
SELECT id, user_id, type, game, event_date, stake_bet365, odd_bet365,
       stake_poly_usd, odd_poly, exchange_rate, result, profit, notes,
       created_at, extra_bets, uses_freebet, freebet_account_id, freebet_account_ids
FROM operations;

DROP TABLE operations;
ALTER TABLE operations_new RENAME TO operations;

-- Re-create indexes (index definitions live in SCHEMA; runMigrations executes
-- after SCHEMA so IF NOT EXISTS on those is a no-op for an existing DB —
-- recreate them here explicitly so the rebuilt table is indexed).
CREATE INDEX IF NOT EXISTS idx_operations_user ON operations(user_id);
CREATE INDEX IF NOT EXISTS idx_operations_date ON operations(created_at);
CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(type);

PRAGMA foreign_keys = ON;
