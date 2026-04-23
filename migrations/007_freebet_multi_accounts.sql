-- Freebets podem ser divididas entre múltiplas contas agora. Legacy column
-- freebet_account_id continua para rows antigas; novas escritas populam o JSON.
-- Conteúdo: JSON array de ids (ex.: "[3,7]"). Ignorado quando null/vazio.
ALTER TABLE operations ADD COLUMN freebet_account_ids TEXT;
