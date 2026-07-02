const express = require('express');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Only MEXC needs the proxy (no CORS headers; the browser can't read it). It lists
// USDC/BRL but not USDT/BRL. We return its ORDER BOOK so the frontend can compute
// the effective price for a target size and the real near-top liquidity — the
// top-of-book alone is misleading (MEXC often shows ~$1 at the best price).
// Binance/Bybit/Bitget books are fetched client-side (CORS ok + user's BR IP).

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

let cache = { ts: 0, data: null };
const CACHE_MS = 4000;

const pick = (d) => (d && Array.isArray(d.asks) && Array.isArray(d.bids) ? { asks: d.asks, bids: d.bids } : null);

router.get('/quotes', async (req, res) => {
  try {
    if (cache.data && Date.now() - cache.ts < CACHE_MS) return res.json(cache.data);
    // USDCBRL (direct) + BRLUSDT (inverted → normalized to USDT/BRL client-side).
    const [usdc, brlusdt] = await Promise.all([
      fetchJson('https://api.mexc.com/api/v3/depth?symbol=USDCBRL&limit=50'),
      fetchJson('https://api.mexc.com/api/v3/depth?symbol=BRLUSDT&limit=50'),
    ]);
    const data = { mexc: { USDCBRL: pick(usdc), BRLUSDT: pick(brlusdt) }, ts: Date.now() };
    cache = { ts: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error('[fx quotes]', err && err.message);
    res.status(500).json({ error: 'Erro ao buscar cotações' });
  }
});

module.exports = router;
