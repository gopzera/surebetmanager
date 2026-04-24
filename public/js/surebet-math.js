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
  // Leg input formats (both supported; internally unified to the tier form):
  //   1) Split with N tiers: { tiers: [{eff, cap}, ...], usesFreebet }
  //      tiers MUST be sorted descending by `eff` (best odd first). All tiers
  //      have a `cap` in USD. The last tier's cap may be Infinity to model an
  //      "overflow absorber". If cap is null/0 on any non-last tier, that tier
  //      is ignored.
  //   2) Legacy 2-tier: { effA, effB, capA, usesFreebet }
  //      Converted internally to [{eff:effA, cap:capA}, {eff:effB, cap:Infinity}].
  //   3) Non-split: { effA, usesFreebet }
  //      Converted to [{eff:effA, cap:Infinity}].
  //
  // Algorithm (arbitrage with piecewise-linear per-leg payout):
  //   When leg i wins, payout = target (same across legs by arb definition).
  //   Each split leg greedy-fills tiers in order until target is met. Some tier
  //   t* ends up partially filled; tiers before t* are full (capped), tiers
  //   after t* unused.
  //   Given t*:
  //     stake_i = Σ_{j<t*} cap_j + (target - Σ_{j<t*} cap_j·eff_j) / eff_{t*}
  //             = target/eff_{t*} + Σ_{j<t*} cap_j·(1 - eff_j/eff_{t*})
  //   Let invSum = Σ 1/eff_{t*_i} over split legs + 1/eff for non-split.
  //       K      = Σ Σ_{j<t*_i} cap_j·(1 - eff_j/eff_{t*_i}) over split legs.
  //   Then target = (desiredTotalUSD - K) / invSum.
  //
  //   We initially guess t*_i = tiers.length - 1 (all but last full). Then
  //   verify: if partial stake at t*_i < 0, decrement t*_i (earlier tier is
  //   the partial one). If partial > cap at the last tier (would need more
  //   liquidity than available), cap out and flag `shortfall`. Bounded
  //   iteration — converges in O(Σ tiers) passes.
  //
  // Output:
  //   { target, stakes: [{ tiers: [stakePerTier], total, payoutOnWin, splitActive,
  //                        shortfall }], totalUSD, shortfallUSD }
  //   - stakes[i].tiers[j] = USD allocated to tier j on leg i
  //   - shortfall (leg-level) > 0 means the leg's last tier was saturated and
  //     the leg's payoutOnWin is below target. The surebet can't fully balance;
  //     UI should warn.
  function solveSplitLegs(rawLegs, desiredTotalUSD) {
    if (!Array.isArray(rawLegs) || rawLegs.length === 0) return null;
    const INF = Number.POSITIVE_INFINITY;

    // Normalize every input to tier form.
    const legs = rawLegs.map(l => {
      const usesFreebet = !!l.usesFreebet;
      let tiers;
      if (Array.isArray(l.tiers)) {
        tiers = l.tiers
          .map((t, idx) => ({
            eff: Number(t.eff),
            cap: t.cap == null ? (idx === l.tiers.length - 1 ? INF : 0) : Number(t.cap),
          }))
          .filter(t => t.eff > 1 && t.cap > 0);
        // If tiers don't end with an Infinity cap, last one becomes the absorb
        // tier implicitly (still capped at its cap — we'll flag shortfall if
        // target demand exceeds it).
      } else if (l.effA != null && l.effB != null && l.capA != null &&
                 Number(l.capA) > 0 && Number(l.effB) > 1) {
        tiers = [
          { eff: Number(l.effA), cap: Number(l.capA) },
          { eff: Number(l.effB), cap: INF },
        ];
      } else {
        tiers = [{ eff: Number(l.effA), cap: INF }];
      }
      return { tiers, usesFreebet, _tStar: tiers.length - 1 };
    });

    if (legs.some(l => !(l.tiers[0]?.eff > 1))) return null;

    // Iterative solve: each pass picks the partial tier t*_i per leg; if t*_i
    // turns out inconsistent (stake < 0 → earlier tier is partial; stake > cap
    // on non-last tier → later tier is partial), bump it and re-solve.
    // Upper bound: one move per tier total.
    const maxIters = legs.reduce((s, l) => s + l.tiers.length, 0) + legs.length + 2;
    for (let iter = 0; iter <= maxIters; iter++) {
      let invSum = 0, K = 0;
      for (const l of legs) {
        if (l.usesFreebet) continue;
        const star = l._tStar;
        const effStar = l.tiers[star].eff;
        invSum += 1 / effStar;
        for (let j = 0; j < star; j++) {
          K += l.tiers[j].cap * (1 - l.tiers[j].eff / effStar);
        }
      }
      if (invSum <= 0) return null;
      const target = (desiredTotalUSD - K) / invSum;

      let changed = false;
      for (const l of legs) {
        if (l.usesFreebet) continue;
        const star = l._tStar;
        const effStar = l.tiers[star].eff;
        // prefix_payout = Σ_{j<star} cap_j × eff_j
        let prefixPayout = 0;
        for (let j = 0; j < star; j++) prefixPayout += l.tiers[j].cap * l.tiers[j].eff;
        const partial = (target - prefixPayout) / effStar;

        if (partial < 0 && star > 0) {
          // Earlier tier is actually the partial one.
          l._tStar = star - 1;
          changed = true;
        } else if (partial > l.tiers[star].cap && star < l.tiers.length - 1) {
          // Later tier needed — more demand than this tier can hold.
          l._tStar = star + 1;
          changed = true;
        }
      }
      if (changed) continue;

      // Liquidity clamp: if any real-money leg's full tier capacity can't reach
      // `target`, the arb can't balance at desiredTotal. Clamp target to the
      // smallest feasible max-payout so all legs pay the same on win (surebet
      // stays balanced) and totalUSD drops below desiredTotal. The caller sees
      // the reduced total and the `insufficientLiquidity` flag.
      let finalTarget = target;
      let insufficient = false;
      let maxFeasible = Infinity;
      for (const l of legs) {
        if (l.usesFreebet) continue;
        const cap = l.tiers.reduce((s, t) => s + t.cap * t.eff, 0);
        if (Number.isFinite(cap) && cap < maxFeasible) maxFeasible = cap;
      }
      if (Number.isFinite(maxFeasible) && target > maxFeasible) {
        finalTarget = maxFeasible;
        insufficient = true;
        // Rederive the partial tier for each leg under the clamped target.
        for (const l of legs) {
          if (l.usesFreebet) continue;
          let remaining = finalTarget;
          let star = 0;
          for (let j = 0; j < l.tiers.length; j++) {
            const tp = l.tiers[j].cap * l.tiers[j].eff;
            if (remaining <= tp + 1e-9) { star = j; break; }
            remaining -= tp;
            star = j;
          }
          l._tStar = star;
        }
      }

      // Stable — build the result.
      const stakes = legs.map(l => {
        if (l.usesFreebet) {
          const eff = l.tiers[0].eff;
          // Freebet legs: "stake" is the bookie's credit; payout-on-win is
          // (eff-1) × credit. They don't cost real money and aren't split.
          return {
            tiers: [finalTarget / (eff - 1)],
            total: 0,
            payoutOnWin: finalTarget,
            splitActive: false,
          };
        }
        const star = l._tStar;
        const effStar = l.tiers[star].eff;
        let prefixPayout = 0;
        for (let j = 0; j < star; j++) prefixPayout += l.tiers[j].cap * l.tiers[j].eff;
        let partial = (finalTarget - prefixPayout) / effStar;
        // Clamp to tier cap (only matters if rounding/float error pushes slightly over).
        if (partial > l.tiers[star].cap) partial = l.tiers[star].cap;
        if (partial < 0) partial = 0;
        const tierStakes = l.tiers.map((t, j) =>
          j < star ? t.cap : (j === star ? partial : 0)
        );
        const payoutOnWin = tierStakes.reduce((s, st, j) => s + st * l.tiers[j].eff, 0);
        const total = tierStakes.reduce((a, b) => a + b, 0);
        const tiersUsed = tierStakes.filter(s => s > 1e-9).length;
        return {
          tiers: tierStakes,
          total,
          payoutOnWin,
          splitActive: tiersUsed > 1,
        };
      });
      const totalUSD = stakes.reduce((s, x) => s + x.total, 0);

      // --- Legacy fields for backward compatibility ---
      // Old callers read stakes[i].{tierA, tierB, total, splitActive, shortfall}.
      // Map tiers[0] → tierA, tiers[last>0] → tierB (if split active).
      for (const st of stakes) {
        st.tierA = st.tiers[0] || 0;
        st.tierB = st.tiers.length > 1 ? st.tiers[st.tiers.length - 1] : 0;
        st.shortfall = 0; // shortfall is now a leg-level concept folded into totalUSD clamp
      }

      return {
        target: finalTarget,
        stakes,
        totalUSD,
        insufficientLiquidity: insufficient,
        shortfallUSD: insufficient ? Math.max(0, desiredTotalUSD - totalUSD) : 0,
      };
    }
    return null;
  }

  return { POLY_CATS, computeProfit, calcEffOdds, calcTakerFeePct, solveSplitLegs };
}));
