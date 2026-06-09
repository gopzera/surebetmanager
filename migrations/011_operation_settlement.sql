-- Coluna de liquidação para "tentativa de duplo". Guarda, em JSON, o desfecho do
-- pagamento antecipado quando o jogo termina: { "outcome": "none|duplo|cashout",
-- "adjustment": <valor somado ao lucro base da arbitragem> }.
-- O lucro final da operação (coluna profit) = lucro base + adjustment.
-- Nullable e ignorada pelos demais tipos. ALTER ADD COLUMN não reconstrói a tabela.

ALTER TABLE operations ADD COLUMN settlement TEXT;
