-- Persistent rate-limit buckets. The in-memory limiter resets on every cold
-- start (Vercel serverless), which means an attacker can just wait ~10 min
-- between login attempts to bypass the 10/5min cap. This table survives cold
-- starts so the limiter stays honest.
--
-- key         : namespace|ip/user (same as in-memory bucket key)
-- window_start: epoch ms when the current window opened
-- count       : hits in the current window

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Index for periodic cleanup of expired buckets.
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_buckets(window_start);
