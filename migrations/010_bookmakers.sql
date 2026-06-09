-- Cadastro de "casas" (bookmakers) como entidade por usuário. Hoje o nome da casa
-- nas pernas (Arbitragem BR / Punter / Tentativa de duplo) é texto livre dentro do
-- JSON extra_bets, o que impede análise confiável por casa. Esta tabela é a fundação
-- para o seletor estruturado no registro e, depois, para analytics (volume/lucro/
-- ranking por casa).
--
-- As built-in (Bet365 BRL, Polymarket USD) são semeadas de forma lazy/idempotente
-- no GET /api/bookmakers (INSERT OR IGNORE apoiado no UNIQUE), cobrindo usuários
-- existentes e novos sem varrer a tabela users aqui.

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

CREATE INDEX IF NOT EXISTS idx_bookmakers_user ON bookmakers(user_id);
