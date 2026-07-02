const express = require('express');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// USDC/BRL (fallback USDT/BRL) buy/sell across exchanges, fetched SERVER-SIDE so the
// browser doesn't hit CORS. Binance stays the primary rate elsewhere in the app; this
// is a comparison panel to spot where BRL↔USDC is cheaper to buy or better to sell.

async function fetchJson(url, ms = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Each source tries USDCBRL first, then USDTBRL. Returns { pair, bid, ask } or null.
// bid = best price someone pays you (you SELL into it); ask = price you pay (you BUY).
const SOURCES = [
  {
    id: 'binance', label: 'Binance',
    async quote() {
      for (const pair of ['USDCBRL', 'USDTBRL']) {
        const d = await fetchJson(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${pair}`);
        const bid = d && parseFloat(d.bidPrice), ask = d && parseFloat(d.askPrice);
        if (bid > 0 && ask > 0) return { pair, bid, ask };
      }
      return null;
    },
  },
  {
    id: 'bybit', label: 'Bybit',
    async quote() {
      for (const pair of ['USDCBRL', 'USDTBRL']) {
        const d = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`);
        const t = d && d.result && Array.isArray(d.result.list) ? d.result.list[0] : null;
        const bid = t && parseFloat(t.bid1Price), ask = t && parseFloat(t.ask1Price);
        if (bid > 0 && ask > 0) return { pair, bid, ask };
      }
      return null;
    },
  },
  {
    id: 'mexc', label: 'MEXC',
    async quote() {
      for (const pair of ['USDCBRL', 'USDTBRL']) {
        const d = await fetchJson(`https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${pair}`);
        const bid = d && parseFloat(d.bidPrice), ask = d && parseFloat(d.askPrice);
        if (bid > 0 && ask > 0) return { pair, bid, ask };
      }
      return null;
    },
  },
  {
    id: 'bitget', label: 'Bitget',
    async quote() {
      for (const pair of ['USDTBRL', 'USDCBRL']) {
        const d = await fetchJson(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${pair}`);
        const t = d && Array.isArray(d.data) ? d.data[0] : null;
        const bid = t && parseFloat(t.bidPr), ask = t && parseFloat(t.askPr);
        if (bid > 0 && ask > 0) return { pair, bid, ask };
      }
      return null;
    },
  },
];

// Short server-side cache so rapid polling from the panel doesn't hammer the exchanges.
let cache = { ts: 0, data: null };
const CACHE_MS = 4000;

router.get('/quotes', async (req, res) => {
  try {
    if (cache.data && Date.now() - cache.ts < CACHE_MS) return res.json(cache.data);
    const quotes = await Promise.all(SOURCES.map(async (s) => {
      try {
        const q = await s.quote();
        return q ? { id: s.id, label: s.label, ok: true, ...q } : { id: s.id, label: s.label, ok: false };
      } catch (_) {
        return { id: s.id, label: s.label, ok: false };
      }
    }));
    const data = { quotes, ts: Date.now() };
    cache = { ts: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error('[fx quotes]', err && err.message);
    res.status(500).json({ error: 'Erro ao buscar cotações' });
  }
});

module.exports = router;
