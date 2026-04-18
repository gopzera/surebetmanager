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

  return { POLY_CATS, computeProfit, calcEffOdds, calcTakerFeePct };
}));
