// Pure math shared by the app and by tests.
// UMD: browser sets window.SurebetMath; Node/Vitest get CommonJS exports.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SurebetMath = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Polymarket maker-taker fee bands (taker side only — maker is 0).
  // Must match https://docs.polymarket.com/polymarket-learn/trading/fees
  const POLY_CATS = {
    'None (free)':   { feeRate: 0     },
    'Crypto':        { feeRate: 0.072 },
    'Sports':        { feeRate: 0.03  },
    'Finance':       { feeRate: 0.04  },
    'Politics':      { feeRate: 0.04  },
    'Tech':          { feeRate: 0.04  },
    'Mentions':      { feeRate: 0.04  },
    'Culture':       { feeRate: 0.05  },
    'Economics':     { feeRate: 0.05  },
    'Weather':       { feeRate: 0.05  },
    'Other/General': { feeRate: 0.05 },
    'Geopolitical':  { feeRate: 0     },
  };

  // Profit for a 2-leg Bet365/Polymarket operation given the settled result.
  // Returns null for stakes=0 or pending/unknown result (UI treats as "don't auto-fill").
  function computeProfit(stakeBet365, oddBet365, stakePolyUsd, oddPoly, exchangeRate, result) {
    const sb = parseFloat(stakeBet365) || 0;
    const ob = parseFloat(oddBet365) || 0;
    const sp = parseFloat(stakePolyUsd) || 0;
    const op = parseFloat(oddPoly) || 0;
    const fx = parseFloat(exchangeRate) || 0;

    if (!sb && !sp) return null;

    const totalInvested = sb + sp * fx;

    if (result === 'bet365_won') return sb * ob - totalInvested;
    if (result === 'poly_won')   return sp * op * fx - totalInvested;
    if (result === 'void')       return 0;
    return null;
  }

  // Effective odds accounting for exchange commissions and Polymarket taker fee.
  //
  // Back:  eff = 1 + (raw-1)(1-c)
  // Lay:   eff = raw - c       (c already a decimal fraction of the lay stake)
  // Poly (back only): adjEff = eff × (1 - feeRate × (1-p)), where p = 1/eff.
  //   Equivalent to: the fee is taken on the portion above the implied price.
  function calcEffOdds(raw, commPct, betType, usePoly, catKey) {
    if (!raw || raw <= 1) return null;
    const c = (parseFloat(commPct) || 0) / 100;
    let eff;
    if (betType === 'lay') eff = raw - c;
    else                   eff = 1 + (raw - 1) * (1 - c);
    if (eff <= 1) return null;
    if (!usePoly || betType === 'lay') return eff;
    const cat = POLY_CATS[catKey];
    if (!cat || !cat.feeRate) return eff;
    const p = 1 / eff;
    const adjEff = eff * (1 - cat.feeRate * (1 - p));
    return adjEff > 1 ? adjEff : null;
  }

  // Taker fee as a percentage of the bet (for display).
  function calcTakerFeePct(raw, commPct, catKey) {
    if (raw <= 1) return 0;
    const c = (parseFloat(commPct) || 0) / 100;
    const eff = 1 + (raw - 1) * (1 - c);
    if (eff <= 1) return 0;
    const cat = POLY_CATS[catKey];
    if (!cat || !cat.feeRate) return 0;
    const p = 1 / eff;
    return cat.feeRate * (1 - p) * 100;
  }

  // Solve stake distribution for a surebet with optional liquidity splits per leg.
  //
  // Each leg: { effA, effB, capA, usesFreebet }
  //   effA:        effective odd at tier A (also used as the sole odd when split disabled)
  //   effB/capA:   null when split disabled; otherwise effB = fallback odd, capA = USD cap
  //                of tier A (derived from "shares available × price").
  //   usesFreebet: excluded from invSum and from real-money totals.
  //
  // Derivation:
  //   When leg i wins, payout = target (same across legs by arbitrage).
  //   Split leg:      capA·effA + tierB·effB = target  ⇒  tierB = (target - capA·effA)/effB
  //                   total_stake_i = capA + tierB     = capA·(1 - effA/effB) + target/effB
  //   Non-split leg:  tierA = target/effA              = total_stake_i
  //   Σ total_stake_i = desiredTotalUSD (excl. freebet legs)
  //   Let invSum = Σ (1/effB for split, 1/effA for non-split),
  //       K      = Σ capA·(1 - effA/effB)  over split legs.
  //   Then target = (desiredTotalUSD - K) / invSum.
  //
  // If a split leg's computed tierB < 0, its capA exceeds what the solver needs — the
  // leg effectively doesn't need the fallback tier. We deactivate split for that leg
  // and re-solve (bounded iteration: each pass deactivates at least one leg).
  function solveSplitLegs(rawLegs, desiredTotalUSD) {
    if (!Array.isArray(rawLegs) || rawLegs.length === 0) return null;
    const legs = rawLegs.map(l => ({
      effA: Number(l.effA),
      effB: l.effB != null ? Number(l.effB) : null,
      capA: l.capA != null ? Number(l.capA) : null,
      usesFreebet: !!l.usesFreebet,
      _splitActive: !!(
        l.capA != null && l.effB != null &&
        Number(l.capA) > 0 && Number(l.effB) > 1 && !l.usesFreebet
      ),
    }));
    if (legs.some(l => !(l.effA > 1))) return null;
    if (legs.some(l => l._splitActive && !(l.effB > 1))) return null;

    for (let iter = 0; iter <= legs.length + 1; iter++) {
      let invSum = 0, K = 0;
      for (const l of legs) {
        if (l.usesFreebet) continue;
        if (l._splitActive) {
          invSum += 1 / l.effB;
          K      += l.capA * (1 - l.effA / l.effB);
        } else {
          invSum += 1 / l.effA;
        }
      }
      if (invSum <= 0) return null;
      const target = (desiredTotalUSD - K) / invSum;

      let changed = false;
      for (const l of legs) {
        if (!l._splitActive) continue;
        const tierB = (target - l.capA * l.effA) / l.effB;
        if (tierB < 0) { l._splitActive = false; changed = true; }
      }
      if (changed) continue;

      const stakes = legs.map(l => {
        if (l.usesFreebet) {
          const eff = l.effA;
          return { tierA: target / (eff - 1), tierB: 0, total: 0, splitActive: false };
        }
        if (l._splitActive) {
          const tierB = Math.max(0, (target - l.capA * l.effA) / l.effB);
          return { tierA: l.capA, tierB, total: l.capA + tierB, splitActive: true };
        }
        const tierA = target / l.effA;
        return { tierA, tierB: 0, total: tierA, splitActive: false };
      });
      const totalUSD = stakes.reduce((s, x) => s + x.total, 0);
      return { target, stakes, totalUSD };
    }
    return null;
  }

  return { POLY_CATS, computeProfit, calcEffOdds, calcTakerFeePct, solveSplitLegs };
}));
