-- Per-user configuration for dashboard alerts (visual only).
-- alert_key identifies the rule type; params is a JSON blob whose shape
-- depends on the rule (e.g. {days: 7} for inactivity).
CREATE TABLE IF NOT EXISTS alert_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  alert_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  params TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_alert_configs_user ON alert_configs(user_id, enabled);
