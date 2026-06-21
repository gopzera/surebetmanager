// v2 backfill: derive the relational leg model (operation_legs +
// operation_leg_accounts) from legacy operations. Purely ADDITIVE — it never
// touches operations.profit/result or the legacy bet365/poly columns, so it's
// reversible and loses no data. Runs once, guarded by a schema_migrations marker.
//
// Mapping per operation:
//   - standard-like (aquecimento/arbitragem/aumentada25): bet365 column → 'main'
//     leg (Bet365 house, split across operation_accounts); poly column →
//     'protection' leg (Polymarket house, USD→BRL via exchange_rate). result
//     bet365_won/poly_won marks that leg as won.
//   - extra_bets legs (arbitragem_br/punter/tentativa_duplo): one leg each, house
//     from bookmaker_id or a case-insensitive name match; unmatched free-text
//     names go to curation (bookmaker_id NULL + raw_bookmaker set). aumentada
//     secondary bets (no bookmaker) → Bet365.

const MARKER = 'backfill_legs_v1';
const STANDARD_LIKE = new Set(['aquecimento', 'arbitragem', 'aumentada25']);
const BR_LIKE = new Set(['arbitragem_br', 'punter', 'tentativa_duplo']);

module.exports = async function backfillLegs(client) {
  const done = await client.execute({
    sql: 'SELECT version FROM schema_migrations WHERE version = ?',
    args: [MARKER],
  });
  if (done.rows.length) return;

  const tx = await client.transaction('write');
  const q = async (sql, args = []) => (await tx.execute({ sql, args })).rows;
  const insert = async (sql, args = []) => Number((await tx.execute({ sql, args })).lastInsertRowid);

  try {
    const users = await q('SELECT id FROM users');
    for (const u of users) {
      const userId = u.id;

      // Built-in houses (lazy elsewhere; ensure here since backfill runs at init).
      await tx.execute({ sql: 'INSERT OR IGNORE INTO bookmakers (user_id,name,currency,is_builtin) VALUES (?,?,?,1)', args: [userId, 'Bet365', 'BRL'] });
      await tx.execute({ sql: 'INSERT OR IGNORE INTO bookmakers (user_id,name,currency,is_builtin) VALUES (?,?,?,1)', args: [userId, 'Polymarket', 'USD'] });
      const bms = await q('SELECT id,name,currency FROM bookmakers WHERE user_id=?', [userId]);
      const byId = new Set(bms.map(b => b.id));
      const byNameLower = new Map(bms.map(b => [String(b.name).toLowerCase(), b]));
      const bet365 = bms.find(b => b.name === 'Bet365') || null;
      const poly = bms.find(b => b.name === 'Polymarket') || null;
      const bet365Id = bet365 ? bet365.id : null;

      // Existing accounts belong to Bet365 until the user reassigns them.
      await tx.execute({ sql: 'UPDATE accounts SET bookmaker_id=? WHERE user_id=? AND bookmaker_id IS NULL', args: [bet365Id, userId] });

      const ops = await q('SELECT * FROM operations WHERE user_id=?', [userId]);
      for (const op of ops) {
        const legs = []; // each: {bookmaker_id, role, stake, stake_orig, currency, rate, odd, won, early_payout, uses_freebet, raw_bookmaker, accounts}
        const standardLike = STANDARD_LIKE.has(op.type);

        if (standardLike && (Number(op.stake_bet365) > 0 || Number(op.odd_bet365) > 0)) {
          const accs = await q('SELECT account_id, stake_bet365 FROM operation_accounts WHERE operation_id=?', [op.id]);
          legs.push({
            bookmaker_id: bet365Id, role: 'main',
            stake: Number(op.stake_bet365) || 0, stake_orig: Number(op.stake_bet365) || 0,
            currency: 'BRL', rate: 1, odd: Number(op.odd_bet365) || 0,
            won: op.result === 'bet365_won' ? 1 : 0, early_payout: 0,
            uses_freebet: op.uses_freebet ? 1 : 0, raw_bookmaker: null,
            accounts: accs.map(a => ({ account_id: a.account_id, stake: a.stake_bet365 })),
          });
        }
        if (standardLike && Number(op.stake_poly_usd) > 0) {
          const fx = Number(op.exchange_rate) || 1;
          legs.push({
            bookmaker_id: poly ? poly.id : null, role: 'protection',
            stake: (Number(op.stake_poly_usd) || 0) * fx, stake_orig: Number(op.stake_poly_usd) || 0,
            currency: 'USD', rate: fx, odd: Number(op.odd_poly) || 0,
            won: op.result === 'poly_won' ? 1 : 0, early_payout: 0,
            uses_freebet: 0, raw_bookmaker: null, accounts: [],
          });
        }

        let extras = [];
        if (op.extra_bets) { try { extras = JSON.parse(op.extra_bets) || []; } catch { extras = []; } }
        let brIdx = 0;
        for (const leg of extras) {
          if (!leg) continue;
          let bookmaker_id = null, raw_bookmaker = null;
          const currency = leg.currency === 'USD' ? 'USD' : 'BRL';
          if (leg.bookmaker_id != null && byId.has(Number(leg.bookmaker_id))) {
            bookmaker_id = Number(leg.bookmaker_id);
          } else if (leg.bookmaker) {
            const m = byNameLower.get(String(leg.bookmaker).trim().toLowerCase());
            if (m) bookmaker_id = m.id; else raw_bookmaker = String(leg.bookmaker);
          } else if (op.type === 'aumentada25') {
            bookmaker_id = bet365Id; // secondary Bet365 bet
          }
          // Role: aumentada secondaries are part of the Bet365 (main) side; for BR
          // arbs the first leg is 'main', the rest 'protection' (2-column display).
          let role;
          if (op.type === 'aumentada25') role = 'main';
          else role = (brIdx === 0 ? 'main' : 'protection');
          if (BR_LIKE.has(op.type)) brIdx++;

          const stakeBRL = Number(leg.stake) || 0;
          legs.push({
            bookmaker_id, role,
            stake: stakeBRL, stake_orig: leg.stake_orig != null ? Number(leg.stake_orig) : stakeBRL,
            currency, rate: leg.rate != null ? Number(leg.rate) : 1, odd: Number(leg.odd) || 0,
            won: leg.won ? 1 : 0, early_payout: leg.early_payout ? 1 : 0,
            uses_freebet: leg.uses_freebet ? 1 : 0, raw_bookmaker,
            accounts: (leg.account_id != null) ? [{ account_id: leg.account_id, stake: null }] : [],
          });
        }

        let position = 0;
        for (const L of legs) {
          const legId = await insert(
            `INSERT INTO operation_legs
               (operation_id,bookmaker_id,role,stake,stake_orig,currency,rate,odd,won,early_payout,uses_freebet,position,raw_bookmaker)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [op.id, L.bookmaker_id, L.role, L.stake, L.stake_orig, L.currency, L.rate, L.odd, L.won, L.early_payout, L.uses_freebet, position++, L.raw_bookmaker]
          );
          for (const a of (L.accounts || [])) {
            if (a.account_id == null) continue;
            await tx.execute({ sql: 'INSERT INTO operation_leg_accounts (leg_id,account_id,stake) VALUES (?,?,?)', args: [legId, a.account_id, a.stake] });
          }
        }
      }
    }

    await tx.execute({ sql: 'INSERT INTO schema_migrations (version) VALUES (?)', args: [MARKER] });
    await tx.commit();
    console.log('[backfillLegs] done');
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    throw e;
  }
};
