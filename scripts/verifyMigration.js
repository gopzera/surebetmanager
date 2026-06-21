// Dry-run / verificação da migração v2 contra uma CÓPIA do banco de produção.
// Simula exatamente o que acontece no primeiro boot do v2 no live: cria as
// tabelas novas e roda o backfill (operation_legs/leg_accounts), de forma
// aditiva e idempotente — sem tocar profit/result/colunas legadas.
//
// USO (na sua máquina, apontando para uma CÓPIA local do banco de produção):
//   TURSO_DATABASE_URL="file:prod-copy.db" node scripts/verifyMigration.js
//
// Faça SEMPRE numa cópia, nunca no banco de produção direto.

const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

if (!url) {
  console.error('Defina TURSO_DATABASE_URL apontando para a CÓPIA do banco (ex.: file:prod-copy.db).');
  process.exit(1);
}
if (!/^file:/.test(url) && !process.env.ALLOW_REMOTE) {
  console.error('Recusando rodar contra um banco remoto. Use uma cópia local (file:...) ou ALLOW_REMOTE=1 se tiver certeza.');
  process.exit(1);
}

const raw = createClient({ url, authToken, intMode: 'number' });
const q = async (sql, args = []) => (await raw.execute({ sql, args })).rows;
const scalar = async (sql, args = []) => { const r = await q(sql, args); return r[0] ? Object.values(r[0])[0] : null; };
const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('pt-BR');

(async () => {
  console.log('=== PRÉ-MIGRAÇÃO (estado atual da cópia) ===');
  const preOps = Number(await scalar('SELECT COUNT(*) FROM operations')) || 0;
  const preProfit = Number(await scalar('SELECT COALESCE(SUM(profit),0) FROM operations')) || 0;
  const preBet365 = Number(await scalar('SELECT COALESCE(SUM(stake_bet365),0) FROM operations')) || 0;
  const prePoly = Number(await scalar('SELECT COALESCE(SUM(stake_poly_usd),0) FROM operations')) || 0;
  const preAccounts = Number(await scalar('SELECT COUNT(*) FROM accounts')) || 0;
  const preResults = await q("SELECT result, COUNT(*) c FROM operations GROUP BY result ORDER BY result");
  console.log(`  operações: ${preOps} | lucro total: ${fmt(preProfit)} | Σstake_bet365: ${fmt(preBet365)} | Σstake_poly_usd: ${fmt(prePoly)} | contas: ${preAccounts}`);
  console.log('  resultados:', preResults.map(r => `${r.result}=${r.c}`).join(', '));

  console.log('\n=== RODANDO db.init() (cria tabelas v2 + backfill) ===');
  const t0 = Date.now();
  // O módulo db usa o mesmo TURSO_DATABASE_URL → opera sobre a cópia.
  await require('../db/database').init();
  console.log(`  concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('\n=== PÓS-MIGRAÇÃO (conferência) ===');
  const postOps = Number(await scalar('SELECT COUNT(*) FROM operations')) || 0;
  const postProfit = Number(await scalar('SELECT COALESCE(SUM(profit),0) FROM operations')) || 0;
  const postBet365 = Number(await scalar('SELECT COALESCE(SUM(stake_bet365),0) FROM operations')) || 0;
  const postPoly = Number(await scalar('SELECT COALESCE(SUM(stake_poly_usd),0) FROM operations')) || 0;
  const legs = Number(await scalar('SELECT COUNT(*) FROM operation_legs')) || 0;
  const legAccts = Number(await scalar('SELECT COUNT(*) FROM operation_leg_accounts')) || 0;
  const opsWithLegs = Number(await scalar('SELECT COUNT(DISTINCT operation_id) FROM operation_legs')) || 0;
  const acctsNoHouse = Number(await scalar('SELECT COUNT(*) FROM accounts WHERE bookmaker_id IS NULL')) || 0;
  const curation = await q('SELECT raw_bookmaker AS name, COUNT(*) c FROM operation_legs WHERE bookmaker_id IS NULL AND raw_bookmaker IS NOT NULL GROUP BY raw_bookmaker ORDER BY c DESC');
  console.log(`  pernas criadas: ${legs} | leg_accounts: ${legAccts} | operações com pernas: ${opsWithLegs}/${postOps}`);
  console.log(`  contas sem casa (deveria ser 0): ${acctsNoHouse}`);
  console.log(`  casas legadas p/ curadoria: ${curation.length ? curation.map(r => `${r.name} (${r.c})`).join(', ') : 'nenhuma'}`);

  console.log('\n=== SEM PERDA? (pré == pós) ===');
  const sameOps = preOps === postOps;
  const sameProfit = Math.abs(preProfit - postProfit) < 1e-6;
  const sameBet365 = Math.abs(preBet365 - postBet365) < 1e-6;
  const samePoly = Math.abs(prePoly - postPoly) < 1e-6;
  const ok = sameOps && sameProfit && sameBet365 && samePoly;
  console.log(`  operações: ${sameOps ? 'OK' : 'DIVERGIU'} | lucro: ${sameProfit ? 'OK' : 'DIVERGIU'} | stake_bet365: ${sameBet365 ? 'OK' : 'DIVERGIU'} | stake_poly: ${samePoly ? 'OK' : 'DIVERGIU'}`);
  console.log(`\n${ok ? '✅ MIGRAÇÃO OK — sem perda, pronta para o live.' : '❌ ATENÇÃO — algo divergiu, NÃO faça o push até investigar.'}`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERRO:', e); process.exit(1); });
