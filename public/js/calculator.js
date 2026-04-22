// ===== CALCULATOR =====
// POLY_CATS, calcEffOdds, calcTakerFeePct live in /js/surebet-math.js (tested via Vitest).
// Destructured here (not in app.js) because this file loads first; app.js only
// needs computeProfit and destructures that on its own.
const { POLY_CATS, calcEffOdds, calcTakerFeePct, solveSplitLegs } = window.SurebetMath;
const CAT_KEYS = Object.keys(POLY_CATS);

// Fork/formula types
const CALC_FORK_TYPES_2 = [
  { id:"1-2",   label:"1 \u2014 2",        hint:"Home vs Away" },
  { id:"1-X2",  label:"1 \u2014 X2",       hint:"Back Home / Lay X2" },
  { id:"1X-2",  label:"1X \u2014 2",       hint:"Lay Home / Back Away" },
  { id:"AH",    label:"AH1 \u2014 AH2",    hint:"Asian Handicap" },
  { id:"OU",    label:"Over \u2014 Under",  hint:"Goals market" },
];
const CALC_FORK_TYPES_3 = [
  { id:"1-X-2",    label:"1 \u2014 X \u2014 2",       hint:"3-way standard" },
  { id:"3corr",    label:"3 corners",        hint:"Corners market" },
  { id:"DNB+D",    label:"DNB + Draw",       hint:"Draw No Bet + Draw" },
];
const CALC_FORK_TYPES_N = [
  { id:"multi",    label:"Multi-way",        hint:"4+ outcomes" },
];

const CALC_CURR_SYMS = { USD:"$", BRL:"R$" };

// -- Calculator state --
let calcNumOut = 2;
let calcShowComm = false;
let calcRoundValue = 0;
let calcRoundUseFx = false;
let calcNextId = 3;
let calcRows = [];
let calcUsdcBrl = null;
let calcLastUpdated = null;
let calcResult = null;
let calcDarkMode = true;
let calcRateInterval = null;
let calcForkType = "1-2";
let calcTotalStakeOverride = null;

function makeCalcRow(id) {
  return {
    id, odds: "2", comm: "0",
    betType: "back",      // "back" | "lay"
    usePoly: false, cat: "Sports",
    currency: "USD", isFixed: false, fixedStake: "",
    manualStake: null,    // user-typed override when another row is the fixed anchor
    customRate: null,     // custom BRL/USD rate for display on USD rows
    usesFreebet: false,   // freebet rows use (eff - 1) and don't count in the stake total
    // Liquidity split (Poly back only). When enabled: tier A uses the row's primary
    // odd for up to `sharesA` shares (capA USD = sharesA × 1/odds); any overflow
    // goes to tier B at `oddB`. Each tier has its own fee flag (limit orders on
    // non-current prices pay no taker fee). Solver logic in window.SurebetMath.
    polySplit: null,
  };
}

// Build the "legs" payload for SurebetMath.solveSplitLegs from the current row state.
// Returns one leg per row; split-only rows get { effA, effB, capA } populated.
function calcBuildSolveLegs() {
  return calcRows.map(r => {
    const comm = parseFloat(r.comm) || 0;
    const rawOdd = parseFloat(r.odds);
    const split = calcIsSplitActive(r) ? r.polySplit : null;

    // Tier A effective odd honors the row's own fee flag; with split, it honors
    // the split's feeA override so the user can tell the math "no fee here".
    const effA = calcEffOdds(
      rawOdd, comm, r.betType,
      r.usePoly && (split ? split.feeA : true),
      r.cat
    );
    let effB = null, capA = null;
    if (split) {
      const oddB = parseFloat(split.oddB);
      effB = calcEffOdds(oddB, comm, r.betType, r.usePoly && split.feeB, r.cat);
      const sharesA = parseFloat(split.sharesA) || 0;
      if (rawOdd > 1) capA = sharesA * (1 / rawOdd);
    }
    return { effA, effB, capA, usesFreebet: !!r.usesFreebet };
  });
}

// Split is a back-only Poly feature with sane inputs. Prevent it from coexisting
// with isFixed/usesFreebet (the UI disables those toggles when split is on, but
// guard defensively in case of stale state).
function calcIsSplitActive(row) {
  if (!row.polySplit) return false;
  if (row.betType !== 'back' || !row.usePoly) return false;
  if (row.isFixed || row.usesFreebet) return false;
  const sharesA = parseFloat(row.polySplit.sharesA);
  const oddB = parseFloat(row.polySplit.oddB);
  const rawOdd = parseFloat(row.odds);
  return sharesA > 0 && oddB > 1 && rawOdd > 1 && oddB !== rawOdd;
}

// -- Math -- (calcEffOdds, calcTakerFeePct imported from window.SurebetMath at top of file)

function cf2(n) { return (typeof n === "number" && isFinite(n)) ? n.toFixed(2) : "\u2014"; }

function calcToDisplay(usdAmt, currency) {
  if (currency === "USD") return usdAmt;
  if (currency === "BRL") return calcUsdcBrl ? usdAmt * calcUsdcBrl : null;
  return null;
}

function calcToUSD(amt, cur) {
  if (cur === "USD") return amt;
  if (cur === "BRL") return calcUsdcBrl ? amt / calcUsdcBrl : amt;
  return amt;
}

function calcFromUSD(usd, cur) {
  if (cur === "USD") return usd;
  if (cur === "BRL") return calcUsdcBrl ? usd * calcUsdcBrl : null;
  return null;
}

// -- Theme --
function calcToggleTheme() {
  calcDarkMode = !calcDarkMode;
  const page = document.getElementById('calc-page-root');
  if (page) page.classList.toggle('light', !calcDarkMode);
  const btn = document.getElementById('calc-theme-btn');
  if (btn) btn.textContent = calcDarkMode ? "\u2728 Light" : "\uD83C\uDF19 Dark";
  localStorage.setItem("calcDarkMode", calcDarkMode);
}

// -- Rate fetcher --
async function calcFetchRate() {
  const dot = document.getElementById('calc-status-dot');
  if (dot) dot.className = "c-dot c-dot-load";
  const attempts = [
    () => fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDCBRL",{cache:"no-store"}).then(r=>r.json()).then(d=>({price:parseFloat(d.price),src:"Binance USDCBRL"})),
    () => fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL",{cache:"no-store"}).then(r=>r.json()).then(d=>({price:parseFloat(d.price),src:"Binance USDTBRL"})),
    () => fetch("https://open.er-api.com/v6/latest/USD").then(r=>r.json()).then(d=>({price:d.rates.BRL,src:"ExchangeRate-API"})),
    () => fetch("https://api.frankfurter.app/latest?base=USD&symbols=BRL").then(r=>r.json()).then(d=>({price:d.rates.BRL,src:"Frankfurter/ECB"})),
  ];
  for (const fn of attempts) {
    try {
      const {price, src} = await fn();
      if (price > 0) { calcGotRate(price, src); return; }
    } catch (_) {}
  }
  const body = document.getElementById('calc-ticker-body');
  if (body) body.innerHTML = `<div style="color:var(--red);font-family:var(--mono);font-size:11px">Falha ao buscar cota\u00E7\u00E3o</div>`;
  if (dot) dot.className = "c-dot c-dot-err";
}

function calcGotRate(price, source) {
  calcUsdcBrl = price;
  calcLastUpdated = new Date();
  const dot = document.getElementById('calc-status-dot');
  if (dot) dot.className = "c-dot c-dot-ok";
  const body = document.getElementById('calc-ticker-body');
  if (body) body.innerHTML = `
    <div class="c-ticker-price">R$${price.toFixed(4)}<span class="c-ticker-time">${calcLastUpdated.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</span></div>
    <div class="c-ticker-source">${source}</div>`;
  calcCompute();
  calcUpdateDisplay();
}

// -- Fork type --
function calcBuildForkSelect() {
  const sel = document.getElementById("calc-fork-type");
  if (!sel) return;
  const types = calcNumOut === 2 ? CALC_FORK_TYPES_2 : calcNumOut === 3 ? CALC_FORK_TYPES_3 : CALC_FORK_TYPES_N;
  sel.innerHTML = types.map(t =>
    `<option value="${t.id}" title="${t.hint}"${calcForkType===t.id?" selected":""}>${t.label}</option>`
  ).join("");
  if (!types.find(t=>t.id===calcForkType)) {
    calcForkType = types[0].id;
    sel.value = calcForkType;
  }
}

function calcOnForkChange() {
  calcForkType = document.getElementById("calc-fork-type").value;
  if (calcForkType === "1-X2" && calcRows.length >= 2) {
    calcRows[0].betType = "back"; calcRows[1].betType = "lay";
  } else if (calcForkType === "1X-2" && calcRows.length >= 2) {
    calcRows[0].betType = "lay"; calcRows[1].betType = "back";
  } else {
    calcRows.forEach(r => { if(calcForkType!=="1-X2"&&calcForkType!=="1X-2") r.betType="back"; });
  }
  calcCompute(); calcBuildTable();
}

// -- Outcome buttons --
function calcSetOutcomes(n) {
  calcNumOut = n;
  while (calcRows.length < calcNumOut) calcRows.push(makeCalcRow(calcNextId++));
  calcRows = calcRows.slice(0, calcNumOut);
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b => b.classList.toggle('on', parseInt(b.textContent) === n));
  calcBuildForkSelect();
  calcCompute(); calcBuildTable();
}

function calcToggleShowComm() {
  calcShowComm = !calcShowComm;
  const btn = document.getElementById('calc-show-comm-btn');
  if (btn) { btn.textContent = calcShowComm ? "Hide commissions" : "Show commissions"; btn.classList.toggle('on', calcShowComm); }
  calcBuildTable();
}

// -- Core calculation --
// Freebet rows: stake is the bookie's credit (not user's money). Row contribution
// when won is S*(eff-1) rather than S*eff. Real outlay and invSum exclude them.
// Split rows (polySplit active): stake is allocated across tier A (capped at
// sharesA × 1/odd) and tier B (fallback odd), each with independent fee flag.
function calcCompute() {
  const legs = calcBuildSolveLegs();
  if (!legs.every(l => l.effA !== null && l.effA > 1)) { calcResult = null; return; }
  // Active-split legs need a valid effB too; calcIsSplitActive already gates on odds/shares.
  if (calcRows.some((r, i) => calcIsSplitActive(r) && !(legs[i].effB > 1))) {
    calcResult = null; return;
  }

  const invSum = calcRows.reduce((s, r, i) => {
    if (r.usesFreebet) return s;
    const l = legs[i];
    return s + (calcIsSplitActive(r) ? 1 / l.effB : 1 / l.effA);
  }, 0);
  const margin = invSum;
  const isSurebet = margin < 1 && invSum > 0;

  const fixIdx = calcRows.findIndex(r => r.isFixed);

  // perRow: { tierA, tierB, total, payoutOnWin, splitActive } per row, in USD.
  // total == USD real money out for this row (0 on freebet legs).
  // payoutOnWin == USD returned to user if THIS row's outcome wins.
  let perRow;

  if (fixIdx >= 0) {
    const fRow = calcRows[fixIdx];
    const raw = parseFloat(fRow.fixedStake) || 0;
    let usdFixed;
    if (fRow.currency === "USD") usdFixed = raw;
    else if (fRow.currency === "BRL") usdFixed = calcUsdcBrl ? raw / calcUsdcBrl : raw;
    else usdFixed = raw;
    // UI enforces split OFF on fixed row — payout uses effA directly.
    const lf = legs[fixIdx];
    const fixPayoutFactor = fRow.usesFreebet ? (lf.effA - 1) : lf.effA;
    const target = usdFixed * fixPayoutFactor;

    perRow = calcRows.map((r, i) => {
      const l = legs[i];
      if (r.usesFreebet) {
        const stake = target / (l.effA - 1);
        return { tierA: stake, tierB: 0, total: 0, payoutOnWin: target, splitActive: false };
      }
      if (calcIsSplitActive(r)) {
        const tierBRaw = (target - l.capA * l.effA) / l.effB;
        if (tierBRaw < 0) {
          // Cap exceeds what this leg needs — collapse to single-tier on effA.
          const stake = target / l.effA;
          return { tierA: stake, tierB: 0, total: stake, payoutOnWin: target, splitActive: false };
        }
        return {
          tierA: l.capA, tierB: tierBRaw, total: l.capA + tierBRaw,
          payoutOnWin: l.capA * l.effA + tierBRaw * l.effB, splitActive: true,
        };
      }
      const stake = target / l.effA;
      return { tierA: stake, tierB: 0, total: stake, payoutOnWin: target, splitActive: false };
    });
  } else {
    const desiredTotal = calcTotalStakeOverride !== null ? calcTotalStakeOverride : 100;
    const solved = solveSplitLegs(legs, desiredTotal);
    if (!solved) { calcResult = null; return; }
    perRow = solved.stakes.map((s, i) => {
      const l = legs[i];
      const r = calcRows[i];
      if (r.usesFreebet) {
        // solveSplitLegs reports the freebet credit value in s.tierA; payoutOnWin is
        // the net (eff-1)×credit that a freebet row contributes when it wins.
        return { tierA: s.tierA, tierB: 0, total: 0, payoutOnWin: s.tierA * (l.effA - 1), splitActive: false };
      }
      const payoutOnWin = s.splitActive ? s.tierA * l.effA + s.tierB * l.effB : s.tierA * l.effA;
      return { ...s, payoutOnWin };
    });
  }

  // Manual stake overrides (user typed a total USD for this row).
  calcRows.forEach((r, i) => {
    if (r.manualStake === null || r.isFixed) return;
    const raw = r.manualStake === "" ? null : parseFloat(r.manualStake);
    if (raw === null || isNaN(raw)) return;
    let usdManual;
    if (r.currency === "USD") usdManual = raw;
    else if (r.currency === "BRL") usdManual = calcUsdcBrl ? raw / calcUsdcBrl : raw;
    else usdManual = raw;
    const l = legs[i];
    if (r.usesFreebet) {
      perRow[i] = {
        tierA: usdManual, tierB: 0, total: 0,
        payoutOnWin: usdManual * (l.effA - 1), splitActive: false,
      };
    } else if (calcIsSplitActive(r)) {
      const tierA = Math.min(usdManual, l.capA);
      const tierB = Math.max(0, usdManual - l.capA);
      perRow[i] = {
        tierA, tierB, total: usdManual,
        payoutOnWin: tierA * l.effA + tierB * l.effB,
        splitActive: tierB > 0,
      };
    } else {
      perRow[i] = {
        tierA: usdManual, tierB: 0, total: usdManual,
        payoutOnWin: usdManual * l.effA, splitActive: false,
      };
    }
  });

  // Rounding: applied to the row total; for split rows, tier A stays pinned at
  // capA (liquidity constraint) and tier B absorbs the rounding delta.
  if (calcRoundValue > 0) {
    perRow = perRow.map((p, i) => {
      const r = calcRows[i];
      if (r.usesFreebet) return p;
      let roundedTotal;
      if (calcRoundUseFx && r.currency === "BRL" && calcUsdcBrl) {
        const brl = p.total * calcUsdcBrl;
        const r2 = Math.ceil(brl / calcRoundValue) * calcRoundValue;
        roundedTotal = r2 / calcUsdcBrl;
      } else {
        roundedTotal = Math.ceil(p.total / calcRoundValue) * calcRoundValue;
      }
      const l = legs[i];
      if (p.splitActive && l.capA != null && l.effB > 1) {
        const tierA = Math.min(roundedTotal, l.capA);
        const tierB = Math.max(0, roundedTotal - l.capA);
        return {
          tierA, tierB, total: roundedTotal,
          payoutOnWin: tierA * l.effA + tierB * l.effB,
          splitActive: tierB > 0,
        };
      }
      return {
        tierA: roundedTotal, tierB: 0, total: roundedTotal,
        payoutOnWin: roundedTotal * l.effA, splitActive: false,
      };
    });
  }

  // Backward-compat arrays: existing display code reads stakesUSD[], returnsUSD[], profitsUSD[].
  const totalUSD   = perRow.reduce((s, p) => s + p.total, 0);
  const stakesUSD  = perRow.map(p => p.total);
  const returnsUSD = perRow.map(p => p.payoutOnWin);
  const profitsUSD = returnsUSD.map(r => r - totalUSD);
  const minProfit  = Math.min(...profitsUSD);
  const roi        = totalUSD ? (minProfit / totalUSD) * 100 : 0;
  const effArr     = legs.map(l => l.effA);

  calcResult = { margin, isSurebet, effArr, stakesUSD, totalUSD, returnsUSD, profitsUSD, minProfit, roi, perRow, legs };
}

// -- Build table --
// -- Polymarket price/shares helpers (reused in build and update) --
function calcPolyState(row) {
  const isLay = row.betType === "lay";
  const rawOdd = parseFloat(row.odds) || 0;
  const isPoly = !isLay && row.usePoly && rawOdd > 1;
  if (!isPoly) return { isPoly: false };
  const priceExact = 1 / rawOdd;
  const priceRounded = Math.round(priceExact * 100) / 100;
  if (priceRounded <= 0 || priceRounded >= 1) return { isPoly: false };
  const realOdd = 1 / priceRounded;
  const oddDiffers = Math.abs(realOdd - rawOdd) > 1e-9;
  return { isPoly: true, rawOdd, priceRounded, realOdd, oddDiffers };
}

function calcBuildPolyPriceHint(row) {
  const s = calcPolyState(row);
  if (!s.isPoly) return "";
  const priceStr = s.priceRounded.toFixed(2);
  const realOddStr = s.realOdd.toFixed(10);
  return `
    <div class="c-poly-price" title="Preço por share em limit order (arredondado para 2 casas)">$${priceStr}/share</div>
    ${s.oddDiffers ? `<div class="c-poly-real-odd" title="Odd real com preço arredondado">odd real: ${realOddStr}</div>
    <button type="button" class="c-poly-odd-btn" onclick="calcUseRealOdd(${row.id})" title="Substituir a odd pela odd real">transformar em odd real</button>` : ''}
  `;
}

function calcBuildPolySharesHint(row, idx) {
  const s = calcPolyState(row);
  if (!s.isPoly || !calcResult) return "";
  const p = calcResult.perRow?.[idx];
  if (!p || p.total <= 0) return "";

  // Split active: show tier A + tier B breakdown (shares per tier).
  if (p.splitActive && row.polySplit) {
    const oddB = parseFloat(row.polySplit.oddB);
    const priceB = oddB > 1 ? 1 / oddB : null;
    const priceBRounded = priceB ? Math.round(priceB * 100) / 100 : null;
    const sharesA = p.tierA / s.priceRounded;
    const sharesB = (priceBRounded && priceBRounded > 0) ? p.tierB / priceBRounded : null;
    return `
      <div class="c-shares-badge c-shares-split" title="Tier A: ${sharesA.toFixed(2)} shares @ $${s.priceRounded.toFixed(2)} | Tier B: ${sharesB != null ? sharesB.toFixed(2) : '—'} shares @ $${priceBRounded != null ? priceBRounded.toFixed(2) : '—'}">
        <div>Tier A: ${sharesA.toFixed(2)} sh × $${s.priceRounded.toFixed(2)} = $${p.tierA.toFixed(2)}</div>
        <div>Tier B: ${sharesB != null ? sharesB.toFixed(2) : '—'} sh × $${priceBRounded != null ? priceBRounded.toFixed(2) : '—'} = $${p.tierB.toFixed(2)}</div>
      </div>`;
  }

  const shares = p.total / s.priceRounded;
  return `<div class="c-shares-badge" title="Shares em limit order a $${s.priceRounded.toFixed(2)} cada">Shares: ${shares.toFixed(2)}</div>`;
}

function calcBuildTable() {
  calcCompute();

  let h = `<tr>
    <th style="width:28px" class="c-ctr-col">#</th>
    <th class="c-ctr-col" style="width:50px">B/L</th>
    <th>Odds</th>
    <th class="c-num-col">Prob%</th>`;
  if (calcShowComm) h += `<th>Comm %</th><th class="c-num-col">Eff.Odds</th>`;
  h += `
    <th class="c-poly-th c-ctr-col">Poly</th>
    <th class="c-poly-th">Category</th>
    <th class="c-poly-th c-num-col">Taker Fee</th>
    <th class="c-ctr-col">Currency</th>
    <th>Stake</th>
    <th class="c-ctr-col" style="width:44px" title="Usar saldo de freebet">FB</th>
    <th class="c-ctr-col" style="width:44px">Fix</th>
    <th class="c-num-col">Profit</th>
  </tr>`;
  document.getElementById("calc-thead").innerHTML = h;

  document.getElementById("calc-tbody").innerHTML = calcRows.map((row, idx) => {
    const cur = row.currency;
    const isLay = row.betType === "lay";
    const catOpts = CAT_KEYS.map(k =>
      `<option value="${k}"${row.cat===k?" selected":""}>${k}</option>`
    ).join("");

    let commCols = "";
    if (calcShowComm) {
      const eff = calcResult ? calcResult.effArr[idx] : null;
      commCols = `
        <td><input type="number" min="-40" max="40" step="0.01" value="${row.comm}"
          style="width:70px;text-align:center"
          oninput="calcOnCommInput(${row.id},this.value)"></td>
        <td class="c-num-col" id="calc-ao-${row.id}" style="font-size:12px">
          ${eff ? `<span style="font-family:var(--mono);font-size:11px">${eff.toFixed(4)}</span>` : "\u2014"}
        </td>`;
    }

    // Liability for lay bets
    let liabHtml = "";
    if (isLay && calcResult) {
      const raw = parseFloat(row.odds) || 0;
      const s = calcResult.stakesUSD[idx];
      const liab = s * (raw - 1);
      const liabDisp = calcToDisplay(liab, cur);
      liabHtml = `<div class="c-liab-badge" title="Your liability">Liab: ${CALC_CURR_SYMS[cur]}${cf2(liabDisp??liab)}</div>`;
    }

    const polyPriceHint = calcBuildPolyPriceHint(row);
    const polySharesHint = calcBuildPolySharesHint(row, idx);

    const stakeFixed = (row.isFixed || row.manualStake !== null) ? "c-stake-fixed" : "";
    const stakeVal = row.isFixed ? row.fixedStake
      : row.manualStake !== null ? row.manualStake
      : calcResult ? (() => {
          const v = calcToDisplay(calcResult.stakesUSD[idx], cur);
          return v !== null ? cf2(v) : "";
        })() : "";

    return `
    <tr class="${isLay?"c-is-lay":""}">
      <td class="c-ctr-col" style="font:600 11px/1 var(--mono);color:var(--text3)">${idx+1}</td>
      <td class="c-ctr-col">
        <button class="c-bl-btn ${isLay?"c-lay":"c-back"}" onclick="calcToggleBL(${row.id})" title="${isLay?"Lay (you're the bookmaker)":"Back (you're the bettor)"}">${isLay?"\u2212":"+"}</button>
      </td>
      <td>
        <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
          <input type="number" min="1.001" step="0.01" value="${row.odds}" style="width:88px;text-align:center"
            placeholder="${isLay?"Lay odds":"Back odds"}"
            oninput="calcOnOddsInput(${row.id},this.value)">
          <div id="calc-polyprice-${row.id}" class="c-polyprice-wrap">${polyPriceHint}</div>
        </div>
      </td>
      <td class="c-num-col" id="calc-prob-${row.id}" style="font-size:12px">
        ${(parseFloat(row.odds)||0) > 1 ? (100/(parseFloat(row.odds))).toFixed(1)+"%" : "\u2014"}
      </td>
      ${commCols}
      <td class="c-poly-td c-ctr-col">
        <input type="checkbox" ${row.usePoly&&!isLay?"checked":""} ${isLay?"disabled":""} onchange="calcOnPolyChange(${row.id},this.checked)" title="${isLay?"Polymarket only for back bets":"Use Polymarket taker fee"}">
      </td>
      <td class="c-poly-td">
        <select id="calc-catsel-${row.id}" ${(row.usePoly&&!isLay)?"":"disabled"} onchange="calcOnCatChange(${row.id},this.value)">${catOpts}</select>
      </td>
      <td id="calc-fee-${row.id}" class="c-poly-td c-num-col">
        ${(!isLay && row.usePoly) ? (() => {
          const fp = calcTakerFeePct(parseFloat(row.odds)||0, parseFloat(row.comm)||0, row.cat);
          return fp > 0 ? `<span class="c-fee-badge">${fp.toFixed(3)}%</span>` : `<span style="color:var(--text3)">\u2014</span>`;
        })() : `<span style="color:var(--text3)">\u2014</span>`}
      </td>
      <td class="c-ctr-col">
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
          <button class="c-cur-btn" id="calc-curbtn-${row.id}" onclick="calcCycleCur(${row.id})">${cur==="USD"?"$ USD":"R$ BRL"}</button>
          ${cur==="USD" ? `<div style="display:flex;align-items:center;gap:3px">
            <span style="font:400 9px/1 var(--mono);color:var(--text3)">R$/\$</span>
            <input type="number" min="0.01" step="0.01"
              style="width:64px;font-size:11px;padding:3px 5px;text-align:right"
              placeholder="${calcUsdcBrl ? calcUsdcBrl.toFixed(2) : 'rate'}"
              value="${row.customRate !== null ? row.customRate : ''}"
              oninput="calcOnCustomRate(${row.id},this.value)"
              title="Cota\u00E7\u00E3o USD/BRL personalizada para esta linha">
          </div>` : ""}
        </div>
      </td>
      <td>
        <div style="display:flex;flex-direction:column;gap:3px">
          <div style="display:flex;align-items:center;gap:4px">
            <span id="calc-cursym-${row.id}" style="font:400 11px/1 var(--mono);color:var(--text3)">${CALC_CURR_SYMS[cur]}</span>
            <input type="number" id="calc-stake-${row.id}" class="${stakeFixed}" style="width:92px;text-align:right"
              oninput="calcOnStakeInput(${row.id},this.value)"
              value="${stakeVal}"
              placeholder="${isLay?"Backer stake":"Your stake"}">
          </div>
          ${liabHtml}
          <div id="calc-shares-${row.id}" class="c-shares-wrap">${polySharesHint}</div>
          <div id="calc-brl-hint-${row.id}" class="c-dim" style="padding-left:2px;display:none"></div>
          ${calcBuildSplitControls(row)}
        </div>
      </td>
      <td class="c-ctr-col">
        <input type="checkbox" ${row.usesFreebet?"checked":""} ${row.polySplit?"disabled":""} onchange="calcOnFreebetChange(${row.id},this.checked)"
          title="${row.polySplit?'Desative o split para usar freebet':'Usar saldo de freebet nesta linha (odd cai 1 e stake n\u00E3o entra no total)'}">
      </td>
      <td class="c-ctr-col" id="calc-fixcell-${row.id}">
        <button class="c-fix-btn ${row.isFixed?"c-fix-on":"c-fix-off"}" ${row.polySplit?"disabled":""} onclick="calcToggleFix(${row.id})"
          title="${row.polySplit?"Desative o split para fixar o stake":(row.isFixed?"Unfix stake":"Fix this stake")}">${row.isFixed?"\uD83D\uDD12":"\uD83D\uDD13"}</button>
      </td>
      <td id="calc-profit-${row.id}" class="c-num-col">\u2014</td>
    </tr>`;
  }).join("");

  calcUpdateDisplay();
  calcRenderSimulator();
}

// -- Update display --
function calcUpdateDisplay() {
  const roiBadge = document.getElementById("calc-roi-badge");
  if (!calcResult) {
    document.getElementById("calc-tfoot").innerHTML = "";
    document.getElementById("calc-cards").innerHTML = "";
    if (roiBadge) roiBadge.style.display = "none";
    return;
  }

  calcRows.forEach((row, i) => {
    const probEl = document.getElementById(`calc-prob-${row.id}`);
    if (probEl) {
      probEl.innerHTML = (parseFloat(row.odds)||0) > 1 ? (100/(parseFloat(row.odds))).toFixed(1)+"%" : "\u2014";
    }

    const feeEl = document.getElementById(`calc-fee-${row.id}`);
    if (feeEl) {
      const isLay = row.betType === "lay";
      if (!isLay && row.usePoly) {
        const fp = calcTakerFeePct(parseFloat(row.odds)||0, parseFloat(row.comm)||0, row.cat);
        feeEl.innerHTML = fp > 0 ? `<span class="c-fee-badge">${fp.toFixed(3)}%</span>` : `<span style="color:var(--text3)">\u2014</span>`;
      } else {
        feeEl.innerHTML = `<span style="color:var(--text3)">\u2014</span>`;
      }
    }

    const profEl = document.getElementById(`calc-profit-${row.id}`);
    if (profEl) {
      const pUSD = calcResult.profitsUSD[i];
      const disp = calcToDisplay(pUSD, row.currency);
      const sign = pUSD >= 0 ? "+" : "";
      const cls  = pUSD >= -0.005 ? "c-pos" : "c-neg";
      const sym  = CALC_CURR_SYMS[row.currency];
      const main = disp !== null ? `${sign}${sym}${Math.abs(disp).toFixed(2)}` : `${sign}$${Math.abs(pUSD).toFixed(2)}`;
      const sub  = row.currency !== "USD" && disp !== null ? `<div class="c-dim">${sign}$${cf2(Math.abs(pUSD))}</div>` : "";
      profEl.innerHTML = `<span class="${cls}">${main}</span>${sub}`;
    }

    // Stake
    const stakeEl = document.getElementById(`calc-stake-${row.id}`);
    if (stakeEl && !row.isFixed && row.manualStake === null && document.activeElement !== stakeEl) {
      const v = calcToDisplay(calcResult.stakesUSD[i], row.currency);
      stakeEl.value = v !== null ? cf2(v) : "";
    }

    // Polymarket price/real-odd hint (below odd input)
    const polyPriceWrap = document.getElementById(`calc-polyprice-${row.id}`);
    if (polyPriceWrap) polyPriceWrap.innerHTML = calcBuildPolyPriceHint(row);

    // Polymarket shares badge (near stake)
    const sharesWrap = document.getElementById(`calc-shares-${row.id}`);
    if (sharesWrap) sharesWrap.innerHTML = calcBuildPolySharesHint(row, i);

    // BRL hint for USD rows with customRate
    const brlHint = document.getElementById(`calc-brl-hint-${row.id}`);
    if (brlHint && row.currency === "USD") {
      const activeRate = row.customRate || null;
      if (activeRate) {
        const usdAmt = calcResult.stakesUSD[i];
        brlHint.textContent = `\u2248 R$${cf2(usdAmt * activeRate)}`;
        brlHint.style.display = "";
      } else {
        brlHint.style.display = "none";
      }
    } else if (brlHint) {
      brlHint.style.display = "none";
    }

    // Liability update (for lay rows)
    if (row.betType === "lay") {
      const raw = parseFloat(row.odds) || 0;
      const s = calcResult.stakesUSD[i];
      const liab = s * (raw - 1);
      const liabDisp = calcToDisplay(liab, row.currency);
      const sym = CALC_CURR_SYMS[row.currency];
      const cell = document.getElementById(`calc-stake-${row.id}`)?.closest("td");
      if (cell) {
        let badge = cell.querySelector(".c-liab-badge");
        if (!badge) {
          badge = document.createElement("div");
          badge.className = "c-liab-badge";
          cell.querySelector("div").appendChild(badge);
        }
        badge.textContent = `Liab: ${sym}${cf2(liabDisp??liab)}`;
      }
    }
  });

  // Total stake input sync
  const totalInput = document.getElementById("calc-total-stake-input");
  if (totalInput && document.activeElement !== totalInput) {
    totalInput.value = cf2(calcResult.totalUSD);
  }

  // Footer
  const colCount = 12 + (calcShowComm ? 2 : 0);
  const colsBeforeStake = colCount - 3;
  const totalInputActive = document.activeElement?.id === "calc-total-stake-input";

  if (!totalInputActive) {
    document.getElementById("calc-tfoot").innerHTML = `
      <tr>
        <td colspan="${colsBeforeStake}" style="text-align:right;color:var(--text2);font:500 12px/1 var(--sans)">
          Total stake (USD):</td>
        <td>
          <div style="display:flex;align-items:center;gap:4px">
            <span style="color:var(--text3);font-family:var(--mono);font-size:11px">$</span>
            <input type="number" id="calc-total-stake-input" min="0.01" step="0.01"
              value="${cf2(calcResult.totalUSD)}"
              style="width:92px;text-align:right;font-weight:700"
              title="Edite para distribuir o total entre as apostas"
              oninput="calcOnTotalStakeInput(this.value)">
          </div>
        </td>
        <td></td>
        <td class="c-num-col" id="calc-tfoot-profit">
          <span class="${calcResult.minProfit>=0?"c-pos":"c-neg"}">${calcResult.minProfit>=0?"+":""}$${cf2(Math.abs(calcResult.minProfit))}</span>
          ${calcUsdcBrl?`<div class="c-dim">R$${cf2(calcResult.minProfit*calcUsdcBrl)}</div>`:""}
        </td>
      </tr>`;
  } else {
    const profitCell = document.getElementById("calc-tfoot-profit");
    if (profitCell) {
      profitCell.innerHTML = `
        <span class="${calcResult.minProfit>=0?"c-pos":"c-neg"}">${calcResult.minProfit>=0?"+":""}$${cf2(Math.abs(calcResult.minProfit))}</span>
        ${calcUsdcBrl?`<div class="c-dim">R$${cf2(calcResult.minProfit*calcUsdcBrl)}</div>`:""}`;
    }
  }

  // Cards
  const r = calcResult;
  const vc = r.isSurebet ? "c-green" : "c-red";
  document.getElementById("calc-cards").innerHTML = `
    <div class="c-card ${vc}"><div class="c-card-label">Verdict</div><div class="c-card-value">${r.isSurebet?"\u2713 Surebet":"\u2717 No arb"}</div></div>
    <div class="c-card ${vc}"><div class="c-card-label">Margin</div><div class="c-card-value">${(r.margin*100).toFixed(3)}%</div></div>
    <div class="c-card"><div class="c-card-label">Total USD</div><div class="c-card-value">$${cf2(r.totalUSD)}</div></div>
    ${calcUsdcBrl?`<div class="c-card"><div class="c-card-label">Total BRL</div><div class="c-card-value">R$${(r.totalUSD*calcUsdcBrl).toFixed(2)}</div></div>`:""}
    <div class="c-card ${vc}"><div class="c-card-label">Min Profit</div><div class="c-card-value">+$${cf2(r.minProfit)}</div></div>
    <div class="c-card ${vc}"><div class="c-card-label">ROI</div><div class="c-card-value">${r.roi.toFixed(2)}%</div></div>`;

  // ROI Badge
  if (roiBadge) {
    roiBadge.style.display = "";
    roiBadge.textContent = calcResult.roi.toFixed(2) + "%";
    roiBadge.className = "c-roi-badge " + (calcResult.isSurebet ? "c-arb" : "c-noarb");
  }

  const warn = document.getElementById("calc-brl-warn");
  if (warn) warn.style.display = (calcRows.some(r=>r.currency==="BRL") && !calcUsdcBrl) ? "" : "none";
}

// -- Input handlers --
function calcOnOddsInput(id, val) { calcRows.find(r=>r.id===id).odds = val; calcCompute(); calcUpdateDisplay(); }
function calcUseRealOdd(id) {
  const row = calcRows.find(r => r.id === id);
  if (!row) return;
  const raw = parseFloat(row.odds) || 0;
  if (raw <= 1) return;
  const priceExact = 1 / raw;
  const priceRounded = Math.round(priceExact * 100) / 100;
  if (priceRounded <= 0 || priceRounded >= 1) return;
  const realOdd = 1 / priceRounded;
  row.odds = realOdd.toFixed(10);
  calcCompute();
  calcBuildTable();
}
function calcOnCommInput(id, val) { calcRows.find(r=>r.id===id).comm = val; calcCompute(); calcUpdateDisplay(); }
function calcOnPolyChange(id, checked) {
  const row = calcRows.find(r=>r.id===id);
  row.usePoly = checked;
  // Split only makes sense with Poly on; dropping Poly clears any split config.
  if (!checked) row.polySplit = null;
  const sel = document.getElementById(`calc-catsel-${id}`);
  if (sel) sel.disabled = !checked;
  calcCompute(); calcBuildTable();
}

function calcOnFreebetChange(id, checked) {
  const row = calcRows.find(r => r.id === id);
  if (!row) return;
  row.usesFreebet = checked;
  // Manual / fixed overrides don't survive a freebet toggle — the stake basis changed.
  row.manualStake = null;
  if (row.isFixed) { row.isFixed = false; row.fixedStake = ""; }
  if (checked) row.polySplit = null;  // freebet + split don't mesh (no real money on tier allocation)
  calcCompute(); calcBuildTable();
  calcSaveState();
}
function calcOnCatChange(id, val) { calcRows.find(r=>r.id===id).cat = val; calcCompute(); calcUpdateDisplay(); }

function calcOnStakeInput(id, val) {
  const row = calcRows.find(r=>r.id===id);
  calcTotalStakeOverride = null;
  if (row.isFixed) {
    row.fixedStake = val;
  } else {
    row.manualStake = (val === "" || val === null) ? null : val;
  }
  calcCompute(); calcUpdateDisplay();
}

function calcToggleBL(id) {
  const row = calcRows.find(r=>r.id===id);
  row.betType = row.betType === "back" ? "lay" : "back";
  if (row.betType === "lay") { row.usePoly = false; row.polySplit = null; }
  calcCompute(); calcBuildTable();
}

// -- Liquidity split controls (Poly back rows only) --
// Scenario: you want N shares at the current Poly price but only M < N are available.
// The overflow goes to a lower odd. Tier A captures the constrained slice (fixed capA
// in USD = sharesA × 1/odds), tier B absorbs the rest at `oddB`. Fee flag per tier
// handles the "limit order at non-current price → no taker fee" quirk.
function calcBuildSplitControls(row) {
  const canSplit = row.betType === 'back' && row.usePoly && !row.isFixed && !row.usesFreebet;
  if (!canSplit && !row.polySplit) return '';
  if (!canSplit && row.polySplit) { row.polySplit = null; return ''; }

  if (!row.polySplit) {
    return `<button type="button" class="c-split-toggle" onclick="calcToggleSplit(${row.id})"
              title="Divida o stake entre a odd atual (limitada por liquidez) e uma odd fallback">
              + Split por liquidez
            </button>`;
  }

  const sp = row.polySplit;
  return `
    <div class="c-split-panel">
      <div class="c-split-head">
        <span class="c-split-title">Split por liquidez</span>
        <button type="button" class="c-split-close" onclick="calcToggleSplit(${row.id})" title="Desativar split">✕</button>
      </div>
      <div class="c-split-row">
        <label>Shares na odd ${row.odds}
          <input type="number" min="0" step="1" value="${sp.sharesA === '' ? '' : sp.sharesA}"
            oninput="calcOnSplitInput(${row.id},'sharesA',this.value)"
            placeholder="ex: 270">
        </label>
        <label>Odd fallback
          <input type="number" min="1.001" step="0.01" value="${sp.oddB === '' ? '' : sp.oddB}"
            oninput="calcOnSplitInput(${row.id},'oddB',this.value)"
            placeholder="ex: 1.43">
        </label>
      </div>
      <div class="c-split-row">
        <label class="c-split-check">
          <input type="checkbox" ${sp.feeA?'checked':''} onchange="calcOnSplitFee(${row.id},'feeA',this.checked)">
          Taker fee no tier A
        </label>
        <label class="c-split-check">
          <input type="checkbox" ${sp.feeB?'checked':''} onchange="calcOnSplitFee(${row.id},'feeB',this.checked)">
          Taker fee no tier B
        </label>
      </div>
    </div>
  `;
}

function calcToggleSplit(id) {
  const row = calcRows.find(r => r.id === id);
  if (!row) return;
  if (row.polySplit) {
    row.polySplit = null;
  } else {
    // feeA defaults to ON (current odd is usually taker → pays fee).
    // feeB defaults to OFF (the common "limit order at non-current price" scenario).
    row.polySplit = { sharesA: '', oddB: '', feeA: true, feeB: false };
  }
  calcCompute(); calcBuildTable();
}

function calcOnSplitInput(id, key, val) {
  const row = calcRows.find(r => r.id === id);
  if (!row || !row.polySplit) return;
  row.polySplit[key] = val;
  calcCompute(); calcUpdateDisplay();
}

function calcOnSplitFee(id, key, val) {
  const row = calcRows.find(r => r.id === id);
  if (!row || !row.polySplit) return;
  row.polySplit[key] = !!val;
  calcCompute(); calcUpdateDisplay();
}

function calcCycleCur(id) {
  const row = calcRows.find(r=>r.id===id);
  const order = ["USD","BRL"];
  const next = order[(order.indexOf(row.currency)+1) % order.length];
  row.customRate = null;
  if (row.isFixed && row.fixedStake) {
    const usd = calcToUSD(parseFloat(row.fixedStake), row.currency);
    row.fixedStake = cf2(calcFromUSD(usd, next) ?? usd);
  }
  if (row.manualStake !== null && row.manualStake !== "") {
    const usd = calcToUSD(parseFloat(row.manualStake), row.currency);
    row.manualStake = cf2(calcFromUSD(usd, next) ?? usd);
  }
  row.currency = next;
  calcCompute(); calcBuildTable();
}

function calcToggleFix(id) {
  const row = calcRows.find(r=>r.id===id);
  if (row.isFixed) {
    row.isFixed = false; row.fixedStake = "";
  } else {
    calcRows.forEach(r => { r.isFixed = false; r.fixedStake = ""; r.manualStake = null; });
    calcTotalStakeOverride = null;
    row.isFixed = true;
    row.polySplit = null; // fixed + split not supported — fix pins total, split needs the anchor math
    const stakeEl = document.getElementById(`calc-stake-${id}`);
    const typedVal = row.manualStake !== null && row.manualStake !== ""
      ? row.manualStake
      : (stakeEl && stakeEl.value !== "" ? stakeEl.value : null);
    if (typedVal !== null) {
      row.fixedStake = typedVal;
    } else {
      const idx = calcRows.indexOf(row);
      const usd = calcResult ? calcResult.stakesUSD[idx] : 0;
      const disp = calcFromUSD(usd, row.currency);
      row.fixedStake = cf2(disp ?? usd);
    }
    row.manualStake = null;
  }
  calcCompute(); calcBuildTable();
}

function calcOnCustomRate(id, val) {
  const row = calcRows.find(r=>r.id===id);
  row.customRate = (val === "" || val === null) ? null : parseFloat(val) || null;
  calcUpdateDisplay();
}

function calcOnTotalStakeInput(val) {
  const parsed = parseFloat(val);
  if (!isNaN(parsed) && parsed > 0) {
    calcTotalStakeOverride = parsed;
    calcRows.forEach(r => { r.isFixed = false; r.fixedStake = ""; r.manualStake = null; });
    calcCompute(); calcUpdateDisplay();
  } else if (val === "" || val === null) {
    calcTotalStakeOverride = null;
    calcCompute(); calcUpdateDisplay();
  }
}

// -- Share odds --
function calcShareOdds() {
  if (!calcRows.some(r => r.odds)) return alert("Enter odds first.");
  const params = new URLSearchParams();
  params.set("n", calcNumOut);
  params.set("ft", calcForkType);
  calcRows.forEach((r, i) => {
    params.set(`o${i}`, r.odds);
    params.set(`c${i}`, r.comm);
    params.set(`bt${i}`, r.betType);
    params.set(`poly${i}`, r.usePoly ? "1" : "0");
    params.set(`cat${i}`, r.cat);
    params.set(`cur${i}`, r.currency);
    params.set(`fx${i}`, r.isFixed ? "1" : "0");
    if (r.isFixed && r.fixedStake) params.set(`fxs${i}`, r.fixedStake);
    if (r.customRate !== null) params.set(`cr${i}`, r.customRate);
  });
  const url = `${location.origin}${location.pathname}?${params.toString()}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById("calc-share-btn");
    if (btn) { const orig = btn.textContent; btn.textContent = "\u2705 Link copied!"; setTimeout(() => btn.textContent = orig, 2000); }
  }).catch(() => {
    prompt("Copy this link:", url);
  });
}

// -- Import to operation (BUG FIX: uses highest BRL stake row's odd, not highest odd) --
function calcImportToOperation() {
  if (!calcResult) return alert("Calcule uma surebet antes de importar.");

  const polyRows = [];
  const bet365Rows = [];
  calcRows.forEach((row, i) => {
    const data = {
      row,
      idx: i,
      odds: parseFloat(row.odds) || 0,
      stakeUSD: calcResult.stakesUSD[i],
      stakeBRL: calcResult.stakesUSD[i] * (calcUsdcBrl || 5),
      currency: row.currency,
      usePoly: row.usePoly,
      usesFreebet: !!row.usesFreebet,
    };
    if (row.usePoly) polyRows.push(data);
    else bet365Rows.push(data);
  });

  if (!polyRows.length || !bet365Rows.length) {
    return alert("Marque pelo menos um outcome como Poly e tenha pelo menos um outcome Bet365.");
  }

  const poly = polyRows[0];
  const polyStakeUSD = poly.stakeUSD;
  const polyOdd = poly.odds;

  // Aumentada itself = the Bet365 row with the highest BRL stake. Other Bet365
  // rows are the regulating bets, shipped separately as extra_bets so they're
  // structured data instead of freeform notes.
  const aumentadaRow = bet365Rows.reduce((best, r) => r.stakeBRL > best.stakeBRL ? r : best, bet365Rows[0]);
  const mainStakeBRL = aumentadaRow.stakeBRL;
  const extras = bet365Rows.filter(r => r !== aumentadaRow).map(r => ({
    stake: Number(r.stakeBRL.toFixed(2)),
    odd: Number(r.odds.toFixed(2)),
    uses_freebet: r.usesFreebet,
  }));

  const isAumentada = bet365Rows.length >= 3 && polyRows.length >= 1;
  const type = isAumentada ? 'aumentada25' : 'arbitragem';

  // Per-outcome profit in BRL (from calculator, already fee-adjusted).
  const fx = calcUsdcBrl || 5;
  const profitsBRL = calcResult.profitsUSD.map(p => p * fx);

  window._calcImport = {
    type,
    stakeBet365: mainStakeBRL,
    oddBet365: aumentadaRow.odds,
    usesFreebet: aumentadaRow.usesFreebet,
    extraBets: extras,
    stakePolyUSD: polyStakeUSD,
    oddPoly: polyOdd,
    exchangeRate: fx,
    notes: '',
    // Pre-computed profit per outcome (fee-adjusted).
    profitsBRL,
    minProfitBRL: calcResult.minProfit * fx,
  };

  navigate('new-operation');
  toast('Dados importados da calculadora!', 'success');
}

// -- Scenario Simulator --
function calcRenderSimulator() {
  const container = document.getElementById('calc-simulator');
  if (!container) return;

  if (!calcResult || !calcResult.isSurebet) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  const r = calcResult;
  const fx = calcUsdcBrl || 5.0;

  // Breakeven: at what margin does profit = 0? margin = 1.0
  // Find how much one odd can drop before margin hits 1. Freebet rows aren't in
  // the margin (they don't cost real money), so exclude them from both sides.
  const effArr = r.effArr;
  const breakevens = effArr.map((_, i) => {
    if (calcRows[i].usesFreebet) return null;
    const otherSum = effArr.reduce((s, o, j) => {
      if (j === i || calcRows[j].usesFreebet) return s;
      return s + 1/o;
    }, 0);
    const neededInv = 1 - otherSum;
    if (neededInv <= 0) return null;
    return 1 / neededInv;
  });

  const currentTotal = r.totalUSD;

  const beRows = breakevens.map((be, i) => {
    if (!be) return null;
    const currentEff = effArr[i];
    const drop = currentEff - be;
    const dropPct = currentEff > 1 ? (drop / (currentEff - 1) * 100) : 0;
    return { idx: i, currentEff, breakeven: be, drop, dropPct };
  }).filter(Boolean);

  container.innerHTML = `
    <div style="
      margin-bottom:12px;padding:16px;
      background:var(--surface2);border:1px solid var(--border);
      border-radius:var(--r-sm);
    ">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;opacity:.85">\uD83D\uDD2C Simulador de Cen\u00E1rios</h3>

      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">Breakeven por Linha</div>
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead><tr style="color:var(--text3)">
            <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">#</th>
            <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Odd Atual</th>
            <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Odd Breakeven</th>
            <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Margem</th>
          </tr></thead>
          <tbody>
            ${beRows.map(b => `
              <tr>
                <td style="padding:3px 8px;font-family:var(--mono)">${b.idx + 1}</td>
                <td style="padding:3px 8px;text-align:right;font-family:var(--mono)">${b.currentEff.toFixed(3)}</td>
                <td style="padding:3px 8px;text-align:right;font-family:var(--mono);color:var(--yellow)">${b.breakeven.toFixed(3)}</td>
                <td style="padding:3px 8px;text-align:right;font-family:var(--mono);color:${b.dropPct > 10 ? 'var(--green-bright)' : 'var(--red)'}">
                  ${b.dropPct.toFixed(1)}%
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="font-size:10px;color:var(--text3);margin-top:6px">
          Margem = quanto a odd efetiva pode cair antes de perder a surebet
        </div>
      </div>

      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Simulador R\u00E1pido</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <label style="font-size:12px;color:var(--text3)">Stake total:</label>
          <input type="range" id="calc-sim-slider" min="10" max="10000" step="10" value="${Math.round(currentTotal)}"
            oninput="calcSimSliderUpdate()" style="flex:1;min-width:120px;accent-color:var(--green-bright)">
          <span id="calc-sim-stake" style="font-family:var(--mono);font-size:13px;min-width:70px">$${Math.round(currentTotal)}</span>
          <span id="calc-sim-profit" style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--green-bright);min-width:90px">
            \u2192 R$${(r.minProfit * fx).toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  `;
}

function calcSimSliderUpdate() {
  const slider = document.getElementById('calc-sim-slider');
  const stakeEl = document.getElementById('calc-sim-stake');
  const profitEl = document.getElementById('calc-sim-profit');
  if (!slider || !calcResult) return;
  const total = parseFloat(slider.value);
  const profit = total * (calcResult.roi / 100);
  const fx = calcUsdcBrl || 5.0;
  stakeEl.textContent = `$${Math.round(total)}`;
  profitEl.textContent = `\u2192 R$${(profit * fx).toFixed(2)}`;
}

function calcResetAll() {
  calcNumOut = 2; calcForkType = "1-2";
  calcRows = [makeCalcRow(1), makeCalcRow(2)];
  calcNextId = 3; calcRoundValue = 0; calcRoundUseFx = false; calcTotalStakeOverride = null;
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b => b.classList.toggle("on", b.textContent==="2"));
  calcBuildForkSelect();
  calcShowComm = false;
  const commBtn = document.getElementById("calc-show-comm-btn");
  if (commBtn) { commBtn.textContent = "Show commissions"; commBtn.classList.remove("on"); }
  calcSaveState();
  calcCompute(); calcBuildTable();
}

// -- Odds history (last 10 saved calculations) --
const CALC_HISTORY_KEY = 'calcOddsHistory';
const CALC_HISTORY_MAX = 10;

function calcGetHistory() {
  try {
    return JSON.parse(localStorage.getItem(CALC_HISTORY_KEY) || '[]');
  } catch (_) { return []; }
}

function calcSaveToHistory() {
  if (!calcResult || !calcResult.isSurebet) return; // only save surebets
  const entry = {
    ts: Date.now(),
    forkType: calcForkType,
    numOut: calcNumOut,
    roi: calcResult.roi,
    minProfit: calcResult.minProfit,
    totalUSD: calcResult.totalUSD,
    rows: calcRows.map(r => ({
      odds: r.odds, comm: r.comm, betType: r.betType,
      usePoly: r.usePoly, cat: r.cat, currency: r.currency,
      customRate: r.customRate, usesFreebet: r.usesFreebet,
    })),
  };
  const history = calcGetHistory();
  // Avoid duplicate: skip if last entry has same odds
  if (history.length > 0) {
    const last = history[0];
    const sameOdds = last.rows.length === entry.rows.length &&
      last.rows.every((r, i) => r.odds === entry.rows[i].odds && r.betType === entry.rows[i].betType);
    if (sameOdds) return;
  }
  history.unshift(entry);
  if (history.length > CALC_HISTORY_MAX) history.length = CALC_HISTORY_MAX;
  localStorage.setItem(CALC_HISTORY_KEY, JSON.stringify(history));
  calcRenderHistory();
}

function calcLoadFromHistory(idx) {
  const history = calcGetHistory();
  const entry = history[idx];
  if (!entry) return;
  calcNumOut = entry.numOut || 2;
  calcForkType = entry.forkType || "1-2";
  calcTotalStakeOverride = null;
  calcRows = entry.rows.map((r, i) => ({
    id: i + 1, odds: r.odds || "", comm: r.comm || "0",
    betType: r.betType || "back", usePoly: !!r.usePoly,
    cat: r.cat || "Sports", currency: r.currency || "USD",
    isFixed: false, fixedStake: "", manualStake: null,
    customRate: r.customRate !== undefined ? r.customRate : null,
    usesFreebet: !!r.usesFreebet,
  }));
  calcNextId = calcRows.length + 1;

  // Update outcome buttons
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b =>
    b.classList.toggle('on', parseInt(b.textContent) === calcNumOut)
  );
  calcBuildForkSelect();
  const forkSel = document.getElementById('calc-fork-type');
  if (forkSel) forkSel.value = calcForkType;

  calcCompute();
  calcBuildTable();
  toast('C\u00E1lculo restaurado do hist\u00F3rico');
}

function calcDeleteHistory(idx) {
  const history = calcGetHistory();
  history.splice(idx, 1);
  localStorage.setItem(CALC_HISTORY_KEY, JSON.stringify(history));
  calcRenderHistory();
}

function calcClearHistory() {
  localStorage.removeItem(CALC_HISTORY_KEY);
  calcRenderHistory();
}

function calcRenderHistory() {
  const container = document.getElementById('calc-history-list');
  if (!container) return;
  const history = calcGetHistory();
  if (!history.length) {
    container.innerHTML = `<div style="color:var(--text3);font-size:12px;padding:8px 0;text-align:center">Nenhum c\u00E1lculo salvo. Use o bot\u00E3o \u201CSalvar no hist\u00F3rico\u201D para guardar um c\u00E1lculo.</div>`;
    return;
  }
  container.innerHTML = history.map((entry, idx) => {
    const date = new Date(entry.ts);
    const timeStr = date.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' }) + ' ' +
      date.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    const oddsStr = entry.rows.map((r, i) => {
      const prefix = r.betType === 'lay' ? 'L' : '';
      const poly = r.usePoly ? '*' : '';
      return `${prefix}${r.odds}${poly}`;
    }).join(' / ');
    const forkLabel = entry.forkType || '';
    return `
      <div style="
        display:flex;align-items:center;gap:10px;
        padding:8px 12px;
        background:var(--surface2);border:1px solid var(--border);
        border-radius:var(--r-sm);font-size:12px;
      ">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--mono);font-weight:600;color:var(--text)">${oddsStr}</div>
          <div style="color:var(--text3);font-size:10px;margin-top:2px">${timeStr} \u2022 ${forkLabel} \u2022 ROI: <span style="color:${entry.roi >= 0 ? 'var(--green-bright)' : 'var(--red)'}">${entry.roi.toFixed(2)}%</span></div>
        </div>
        <button class="c-btn" style="padding:3px 8px;font-size:11px" onclick="calcLoadFromHistory(${idx})" title="Carregar">\u21BB</button>
        <button class="c-btn" style="padding:3px 8px;font-size:11px;color:var(--red)" onclick="calcDeleteHistory(${idx})" title="Remover">\u2715</button>
      </div>
    `;
  }).join('');
}

// -- State persistence --
function calcSaveState() {
  const state = {
    numOut: calcNumOut,
    showComm: calcShowComm,
    roundValue: calcRoundValue,
    roundUseFx: calcRoundUseFx,
    forkType: calcForkType,
    totalStakeOverride: calcTotalStakeOverride,
    nextId: calcNextId,
    rows: calcRows.map(r => ({
      id: r.id, odds: r.odds, comm: r.comm, betType: r.betType,
      usePoly: r.usePoly, cat: r.cat, currency: r.currency,
      isFixed: r.isFixed, fixedStake: r.fixedStake,
      manualStake: r.manualStake, customRate: r.customRate,
      usesFreebet: r.usesFreebet,
      polySplit: r.polySplit ? { ...r.polySplit } : null,
    })),
  };
  sessionStorage.setItem('calcState', JSON.stringify(state));
}

function calcRestoreState() {
  try {
    const raw = sessionStorage.getItem('calcState');
    if (!raw) return false;
    const state = JSON.parse(raw);
    calcNumOut = state.numOut || 2;
    calcShowComm = state.showComm || false;
    calcRoundValue = state.roundValue || 0;
    calcRoundUseFx = state.roundUseFx || false;
    calcForkType = state.forkType || "1-2";
    calcTotalStakeOverride = state.totalStakeOverride || null;
    calcNextId = state.nextId || 3;
    if (state.rows && state.rows.length) {
      calcRows = state.rows.map(r => ({
        id: r.id, odds: r.odds || "", comm: r.comm || "0",
        betType: r.betType || "back", usePoly: !!r.usePoly,
        cat: r.cat || "Sports", currency: r.currency || "USD",
        isFixed: !!r.isFixed, fixedStake: r.fixedStake || "",
        manualStake: r.manualStake !== undefined ? r.manualStake : null,
        customRate: r.customRate !== undefined ? r.customRate : null,
        usesFreebet: !!r.usesFreebet,
        polySplit: r.polySplit && typeof r.polySplit === 'object' ? {
          sharesA: r.polySplit.sharesA ?? '',
          oddB:    r.polySplit.oddB ?? '',
          feeA:    r.polySplit.feeA !== false,
          feeB:    !!r.polySplit.feeB,
        } : null,
      }));
    } else {
      return false;
    }
    return true;
  } catch (_) { return false; }
}

// Persist current state on every change (does NOT save to history — that's manual).
const _origCalcCompute = calcCompute;
calcCompute = function() {
  _origCalcCompute();
  calcSaveState();
};

function calcManualSaveToHistory() {
  if (!calcResult || !calcResult.isSurebet) {
    toast('Nada para salvar: insira uma surebet v\u00E1lida primeiro', 'error');
    return;
  }
  const before = calcGetHistory().length;
  calcSaveToHistory();
  const after = calcGetHistory().length;
  if (after > before) toast('C\u00E1lculo salvo no hist\u00F3rico', 'success');
  else toast('Esse c\u00E1lculo j\u00E1 est\u00E1 no hist\u00F3rico', 'info');
}

// -- Load shared odds from URL --
function calcLoadFromURL() {
  const params = new URLSearchParams(location.search);
  if (!params.has("n") || !params.has("o0")) return false;

  const n = parseInt(params.get("n")) || 2;
  calcNumOut = n;
  calcForkType = params.get("ft") || "1-2";
  calcShowComm = false;
  calcRoundValue = 0;
  calcRoundUseFx = false;
  calcTotalStakeOverride = null;
  calcRows = [];
  for (let i = 0; i < n; i++) {
    const r = makeCalcRow(i + 1);
    r.odds     = params.get(`o${i}`)   || "";
    r.comm     = params.get(`c${i}`)   || "0";
    r.betType  = params.get(`bt${i}`)  || "back";
    r.usePoly  = params.get(`poly${i}`) === "1";
    r.cat      = params.get(`cat${i}`) || "Sports";
    r.currency = params.get(`cur${i}`) || "USD";
    r.isFixed  = params.get(`fx${i}`) === "1";
    r.fixedStake = r.isFixed ? (params.get(`fxs${i}`) || "") : "";
    r.customRate = params.has(`cr${i}`) ? parseFloat(params.get(`cr${i}`)) || null : null;
    calcRows.push(r);
  }
  calcNextId = n + 1;

  // Clean URL params so refresh doesn't re-apply
  history.replaceState(null, '', location.pathname);
  return true;
}

// -- Render --
function renderCalculator() {
  // Priority: URL params > sessionStorage > defaults
  const fromURL = calcLoadFromURL();
  if (!fromURL) {
    const restored = calcRestoreState();
    if (!restored) {
      calcRows = [makeCalcRow(1), makeCalcRow(2)];
      calcNextId = 3;
      calcNumOut = 2;
      calcShowComm = false;
      calcRoundValue = 0;
      calcRoundUseFx = false;
      calcForkType = "1-2";
      calcTotalStakeOverride = null;
      calcResult = null;
    }
  }

  const stored = localStorage.getItem("calcDarkMode");
  if (stored !== null) calcDarkMode = stored === "true";

  const mc = document.getElementById('main-content');
  mc.innerHTML = `
  <div class="calc-page ${calcDarkMode ? '' : 'light'}" id="calc-page-root">

    <div class="c-hdr">
      <div class="c-hdr-brand">
        <h2>Sure<em>bet</em></h2>
        <div class="c-sub">Arbitrage + Polymarket</div>
      </div>
      <div class="c-hdr-right">
        <div id="calc-roi-badge" class="c-roi-badge" style="display:none">\u2014</div>
        <button class="c-theme-btn" id="calc-theme-btn" onclick="calcToggleTheme()">${calcDarkMode ? "\u2728 Light" : "\uD83C\uDF19 Dark"}</button>
        <div class="c-ticker">
          <div class="c-ticker-top">
            <span><span class="c-dot c-dot-load" id="calc-status-dot"></span>USDC / BRL</span>
            <button class="c-refresh-btn" onclick="calcFetchRate()" title="Atualizar">\u21BA</button>
          </div>
          <div id="calc-ticker-body"><div class="c-ticker-load">Buscando cota\u00E7\u00E3o\u2026</div></div>
          <div class="c-ticker-note">\u21BB atualiza a cada 5s</div>
        </div>
      </div>
    </div>

    <div class="c-controls">
      <div class="c-ctrl-group">
        <span class="c-ctrl-label">Outcomes</span>
        <div id="calc-outcome-btns" style="display:flex;gap:5px">
          ${[2,3,4,5,6].map(n => `<button class="c-btn ${n===calcNumOut?'on':''}" onclick="calcSetOutcomes(${n})">${n}</button>`).join('')}
        </div>
      </div>
      <div class="c-ctrl-sep"></div>
      <div class="c-ctrl-group">
        <span class="c-ctrl-label">Type</span>
        <select class="c-fork-select" id="calc-fork-type" onchange="calcOnForkChange()"></select>
      </div>
      <div class="c-ctrl-sep"></div>
      <button class="c-btn ${calcShowComm?'on':''}" id="calc-show-comm-btn" onclick="calcToggleShowComm()">${calcShowComm ? "Hide commissions" : "Show commissions"}</button>

      <div id="calc-brl-warn" style="display:none" class="c-warn-bar">\u26A0 Linhas em BRL precisam da cota\u00E7\u00E3o ao vivo</div>
    </div>

    <div class="c-tbl-wrap">
      <table>
        <thead id="calc-thead"></thead>
        <tbody id="calc-tbody"></tbody>
        <tfoot id="calc-tfoot"></tfoot>
      </table>
    </div>

    <div class="c-cards" id="calc-cards"></div>

    <div class="c-actions">
      <button class="c-btn c-primary" onclick="calcShareOdds()" id="calc-share-btn">\uD83D\uDD17 Share odds</button>
      <button class="c-btn c-primary" onclick="calcImportToOperation()" id="calc-import-btn">\uD83D\uDCE5 Importar p/ Opera\u00E7\u00E3o</button>
      <button class="c-btn" onclick="calcManualSaveToHistory()" id="calc-save-history-btn">\uD83D\uDCBE Salvar no hist\u00F3rico</button>
      <button class="c-btn" onclick="calcResetAll()">Reset all</button>
    </div>

    <div id="calc-simulator" style="display:none"></div>

    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0;font-size:14px;font-weight:600;opacity:.85">\uD83D\uDCCB Hist\u00F3rico de C\u00E1lculos</h3>
        <button class="c-btn" onclick="calcClearHistory()" style="font-size:11px;padding:3px 10px">Limpar</button>
      </div>
      <div id="calc-history-list" style="display:flex;flex-direction:column;gap:6px"></div>
    </div>

    <div class="c-legend">
      <strong>Polymarket taker fee (a partir de 30/03/2026):</strong><br>
      Back: <code>eff = 1 + (raw\u22121)\u00D7(1\u2212c%)</code> | Lay: <code>eff = raw \u2212 c%</code><br>
      <code>taker_fee = feeRate \u00D7 (p \u00D7 (1\u2212p))^exponent</code> onde p = 1/eff_odds.
    </div>

  </div>`;

  // Build fork select
  calcBuildForkSelect();

  // Start rate fetching
  calcFetchRate();
  calcRateInterval = setInterval(calcFetchRate, 5000);

  // Build initial table
  calcCompute();
  calcBuildTable();
  calcRenderHistory();
}
