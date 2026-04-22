import { describe, it, expect } from 'vitest';
import SurebetMath from '../public/js/surebet-math.js';

const { computeProfit, calcEffOdds, calcTakerFeePct, POLY_CATS, solveSplitLegs } = SurebetMath;

describe('computeProfit', () => {
  it('returns null when no stakes are entered', () => {
    expect(computeProfit(0, 2.0, 0, 2.0, 5.0, 'bet365_won')).toBe(null);
    expect(computeProfit('', '', '', '', 5.0, 'bet365_won')).toBe(null);
  });

  it('returns null for pending or unknown result', () => {
    expect(computeProfit(100, 2.0, 20, 2.0, 5.0, 'pending')).toBe(null);
    expect(computeProfit(100, 2.0, 20, 2.0, 5.0, undefined)).toBe(null);
    expect(computeProfit(100, 2.0, 20, 2.0, 5.0, 'anything')).toBe(null);
  });

  it('returns 0 for void', () => {
    expect(computeProfit(100, 2.0, 20, 2.0, 5.0, 'void')).toBe(0);
  });

  it('bet365_won: profit = stake*odd - totalInvested', () => {
    // Bet365: 100 * 2.0 = 200 back. Invested: 100 + 20*5 = 200. Profit: 0 (perfect hedge).
    expect(computeProfit(100, 2.0, 20, 2.0, 5.0, 'bet365_won')).toBe(0);
    // Bet365: 100 * 2.1 = 210. Invested: 200. Profit: 10.
    expect(computeProfit(100, 2.1, 20, 2.0, 5.0, 'bet365_won')).toBeCloseTo(10, 9);
  });

  it('poly_won: profit = stake*odd*fx - totalInvested', () => {
    // Poly: 20 * 2.0 * 5 = 200 back. Invested: 100 + 100 = 200. Profit: 0.
    expect(computeProfit(100, 2.0, 20, 2.0, 5.0, 'poly_won')).toBe(0);
    // Poly: 20 * 2.2 * 5 = 220. Invested: 200. Profit: 20.
    expect(computeProfit(100, 2.0, 20, 2.2, 5.0, 'poly_won')).toBeCloseTo(20, 9);
  });

  it('accepts string inputs (forms submit strings)', () => {
    expect(computeProfit('100', '2.1', '20', '2.0', '5.0', 'bet365_won')).toBeCloseTo(10, 9);
  });

  it('treats non-numeric inputs as 0', () => {
    expect(computeProfit('abc', 2.0, 20, 2.0, 5.0, 'bet365_won')).toBeCloseTo(-100, 9);
  });
});

describe('calcEffOdds', () => {
  it('returns null for invalid raw odds', () => {
    expect(calcEffOdds(0, 0, 'back', false, 'Sports')).toBe(null);
    expect(calcEffOdds(1, 0, 'back', false, 'Sports')).toBe(null);
    expect(calcEffOdds(-2, 0, 'back', false, 'Sports')).toBe(null);
  });

  it('back without commission returns raw odds', () => {
    expect(calcEffOdds(2.0, 0, 'back', false, 'Sports')).toBe(2.0);
  });

  it('back with 5% commission: eff = 1 + (raw-1)*0.95', () => {
    // 2.0 raw, 5% comm => 1 + 1*0.95 = 1.95
    expect(calcEffOdds(2.0, 5, 'back', false, 'Sports')).toBeCloseTo(1.95, 9);
  });

  it('lay: eff = raw - c', () => {
    // raw 2.5, comm 5 => eff = 2.5 - 0.05 = 2.45
    expect(calcEffOdds(2.5, 5, 'lay', false, 'Sports')).toBeCloseTo(2.45, 9);
  });

  it('lay ignores Polymarket fees even if usePoly=true', () => {
    const withoutPoly = calcEffOdds(2.5, 5, 'lay', false, 'Crypto');
    const withPoly = calcEffOdds(2.5, 5, 'lay', true, 'Crypto');
    expect(withPoly).toBe(withoutPoly);
  });

  it('returns null if commission pushes eff <= 1', () => {
    // Lay 1.05 raw, 10% comm => 1.05 - 0.10 = 0.95 => null
    expect(calcEffOdds(1.05, 10, 'lay', false, 'Sports')).toBe(null);
  });

  it('Polymarket back: applies taker fee to effective odds', () => {
    // raw 2.0, no comm, Sports (feeRate 0.03)
    // eff = 2.0; p = 0.5; adjEff = 2.0 * (1 - 0.03 * 0.5) = 2.0 * 0.985 = 1.97
    expect(calcEffOdds(2.0, 0, 'back', true, 'Sports')).toBeCloseTo(1.97, 9);
  });

  it('None (free) category: no Polymarket fee adjustment', () => {
    expect(calcEffOdds(2.0, 0, 'back', true, 'None (free)')).toBe(2.0);
  });

  it('Geopolitical: no fee', () => {
    expect(calcEffOdds(3.0, 0, 'back', true, 'Geopolitical')).toBe(3.0);
  });

  it('Crypto (7.2%): matches docs formula', () => {
    // raw 2.0, Crypto 0.072 => 2.0 * (1 - 0.072 * 0.5) = 2.0 * 0.964 = 1.928
    expect(calcEffOdds(2.0, 0, 'back', true, 'Crypto')).toBeCloseTo(1.928, 9);
  });
});

describe('calcTakerFeePct', () => {
  it('returns 0 for invalid odds', () => {
    expect(calcTakerFeePct(0, 0, 'Sports')).toBe(0);
    expect(calcTakerFeePct(1, 0, 'Sports')).toBe(0);
  });

  it('returns 0 for no-fee categories', () => {
    expect(calcTakerFeePct(2.0, 0, 'None (free)')).toBe(0);
    expect(calcTakerFeePct(2.0, 0, 'Geopolitical')).toBe(0);
  });

  it('Sports at 2.0: 3% × (1 - 0.5) × 100 = 1.5', () => {
    expect(calcTakerFeePct(2.0, 0, 'Sports')).toBeCloseTo(1.5, 9);
  });

  it('Crypto at 2.0: 7.2% × 0.5 × 100 = 3.6', () => {
    expect(calcTakerFeePct(2.0, 0, 'Crypto')).toBeCloseTo(3.6, 9);
  });

  it('fee vanishes as odds → 1 (implied p → 1)', () => {
    const hi = calcTakerFeePct(1.01, 0, 'Crypto');
    const lo = calcTakerFeePct(100, 0, 'Crypto');
    expect(hi).toBeLessThan(lo);
  });
});

describe('solveSplitLegs', () => {
  it('reduces to classical surebet when no leg has split', () => {
    // Two legs at odds 2.0 (zero margin). Total $200 → $100 each, payout $200 each.
    const r = solveSplitLegs([
      { effA: 2.0 }, { effA: 2.0 },
    ], 200);
    expect(r.target).toBeCloseTo(200, 6);
    expect(r.stakes[0].total).toBeCloseTo(100, 6);
    expect(r.stakes[1].total).toBeCloseTo(100, 6);
    expect(r.totalUSD).toBeCloseTo(200, 6);
    expect(r.stakes[0].splitActive).toBe(false);
    expect(r.stakes[1].splitActive).toBe(false);
  });

  it('split leg: anchor fully used + overflow tier B solved', () => {
    // Leg 0 has 270 shares at odd 1.45 (price = 1/1.45 ≈ 0.6897, capA ≈ $186.21),
    // fallback odd 1.43 at tier B (no fee — limit order). Leg 1 is the other side.
    // Chose effA=1.45 (no fee on tier A) and effB=1.43 for clarity.
    const capA = 270 * (1/1.45);
    const r = solveSplitLegs([
      { effA: 1.45, effB: 1.43, capA },
      { effA: 3.30 },
    ], 1000);
    // Sanity: tier A uses exactly capA, tier B picks up the rest so that
    // payout on leg 0 winning = capA*1.45 + tierB*1.43 = target.
    expect(r.stakes[0].splitActive).toBe(true);
    expect(r.stakes[0].tierA).toBeCloseTo(capA, 6);
    expect(r.stakes[0].tierA + r.stakes[0].tierB).toBeCloseTo(r.stakes[0].total, 6);
    // Payouts on each leg winning should equal target.
    expect(r.stakes[0].tierA * 1.45 + r.stakes[0].tierB * 1.43).toBeCloseTo(r.target, 6);
    expect(r.stakes[1].tierA * 3.30).toBeCloseTo(r.target, 6);
    // Total stake matches desiredTotalUSD.
    expect(r.totalUSD).toBeCloseTo(1000, 6);
  });

  it('deactivates split when capA > required stake (tier A covers everything)', () => {
    // capA way bigger than needed. Leg 0 should collapse to single-tier.
    const r = solveSplitLegs([
      { effA: 1.45, effB: 1.43, capA: 9999 },
      { effA: 3.30 },
    ], 1000);
    expect(r.stakes[0].splitActive).toBe(false);
    expect(r.stakes[0].tierB).toBe(0);
    expect(r.stakes[0].tierA * 1.45).toBeCloseTo(r.target, 6);
    expect(r.totalUSD).toBeCloseTo(1000, 6);
  });

  it('tier A fee differs from tier B fee (limit-order scenario)', () => {
    // Tier A: odd 1.45 with Sports fee applied (effA ≈ from calcEffOdds).
    // Tier B: odd 1.43 WITHOUT fee (limit order).
    const effA = calcEffOdds(1.45, 0, 'back', true, 'Sports');  // with fee
    const effB = calcEffOdds(1.43, 0, 'back', false, 'Sports'); // no fee → 1.43
    const capA = 270 / 1.45; // 270 shares at price 1/1.45
    const r = solveSplitLegs([
      { effA, effB, capA },
      { effA: 3.30 },
    ], 1000);
    // Payouts balance at target regardless of fee difference.
    expect(r.stakes[0].tierA * effA + r.stakes[0].tierB * effB).toBeCloseTo(r.target, 6);
    expect(r.stakes[1].tierA * 3.30).toBeCloseTo(r.target, 6);
  });

  it('freebet leg is excluded from cost totals', () => {
    const r = solveSplitLegs([
      { effA: 2.0 },
      { effA: 2.0, usesFreebet: true },
    ], 100);
    // Only leg 0 costs real money.
    expect(r.stakes[1].total).toBe(0);
    expect(r.totalUSD).toBeCloseTo(r.stakes[0].total, 6);
  });

  it('returns null when any leg has effA <= 1', () => {
    expect(solveSplitLegs([{ effA: 1.0 }, { effA: 2.0 }], 100)).toBe(null);
  });

  it('silently disables split when effB is bogus (fall back to single-tier)', () => {
    // effB=0.5 is invalid; split auto-disables for that leg and math proceeds.
    const r = solveSplitLegs([{ effA: 2.0, effB: 0.5, capA: 10 }, { effA: 2.0 }], 100);
    expect(r).not.toBe(null);
    expect(r.stakes[0].splitActive).toBe(false);
  });
});

describe('POLY_CATS contract', () => {
  it('has all expected categories with numeric feeRate', () => {
    const expected = [
      'None (free)', 'Crypto', 'Sports', 'Finance', 'Politics', 'Tech',
      'Mentions', 'Culture', 'Economics', 'Weather', 'Other/General', 'Geopolitical',
    ];
    for (const k of expected) {
      expect(POLY_CATS).toHaveProperty(k);
      expect(typeof POLY_CATS[k].feeRate).toBe('number');
      expect(POLY_CATS[k].feeRate).toBeGreaterThanOrEqual(0);
      expect(POLY_CATS[k].feeRate).toBeLessThan(0.2);
    }
  });
});
