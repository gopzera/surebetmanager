// Shared, DB-agnostic mapping from a legacy-shaped operation to the v2 leg model.
// Used by the one-time backfill (db/backfillLegs.js) and by the operations route,
// which keeps operation_legs in sync as a projection of each write during the
// transition. Pure: returns leg objects, performs no DB access.

const STANDARD_LIKE = new Set(['aquecimento', 'arbitragem', 'aumentada25']);
const BR_LIKE = new Set(['arbitragem_br', 'punter', 'tentativa_duplo']);

// op: legacy columns { type, stake_bet365, odd_bet365, stake_poly_usd, odd_poly,
//   exchange_rate, result, uses_freebet }.
// extras: parsed extra_bets array (may be []).
// accs: [{ account_id, stake }] splitting the Bet365 main leg (may be []).
// ctx: { bet365Id, polyId, hasBookmaker(id)->bool, matchName(name)->id|null }.
// Returns: [{ bookmaker_id, role, stake, stake_orig, currency, rate, odd, won,
//   early_payout, uses_freebet, raw_bookmaker, accounts:[{account_id, stake}] }].
function buildOpLegs(op, extras, accs, ctx) {
  const legs = [];
  const standardLike = STANDARD_LIKE.has(op.type);

  if (standardLike && (Number(op.stake_bet365) > 0 || Number(op.odd_bet365) > 0)) {
    legs.push({
      bookmaker_id: ctx.bet365Id, role: 'main',
      stake: Number(op.stake_bet365) || 0, stake_orig: Number(op.stake_bet365) || 0,
      currency: 'BRL', rate: 1, odd: Number(op.odd_bet365) || 0,
      won: op.result === 'bet365_won' ? 1 : 0, early_payout: 0,
      uses_freebet: op.uses_freebet ? 1 : 0, raw_bookmaker: null,
      accounts: (accs || []).map(a => ({ account_id: a.account_id, stake: a.stake })),
    });
  }
  if (standardLike && Number(op.stake_poly_usd) > 0) {
    const fx = Number(op.exchange_rate) || 1;
    legs.push({
      bookmaker_id: ctx.polyId, role: 'protection',
      stake: (Number(op.stake_poly_usd) || 0) * fx, stake_orig: Number(op.stake_poly_usd) || 0,
      currency: 'USD', rate: fx, odd: Number(op.odd_poly) || 0,
      won: op.result === 'poly_won' ? 1 : 0, early_payout: 0,
      uses_freebet: 0, raw_bookmaker: null, accounts: [],
    });
  }

  let brIdx = 0;
  for (const leg of (extras || [])) {
    if (!leg) continue;
    let bookmaker_id = null, raw_bookmaker = null;
    const currency = leg.currency === 'USD' ? 'USD' : 'BRL';
    if (leg.bookmaker_id != null && ctx.hasBookmaker(Number(leg.bookmaker_id))) {
      bookmaker_id = Number(leg.bookmaker_id);
    } else if (leg.bookmaker) {
      const m = ctx.matchName(String(leg.bookmaker).trim());
      if (m) bookmaker_id = m; else raw_bookmaker = String(leg.bookmaker);
    } else if (op.type === 'aumentada25') {
      bookmaker_id = ctx.bet365Id; // secondary Bet365 bet
    }
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
  return legs;
}

module.exports = { STANDARD_LIKE, BR_LIKE, buildOpLegs };
