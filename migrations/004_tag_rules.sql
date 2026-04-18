-- Tag rules: declarative rules that auto-tag operations on create/update.
-- conditions is a JSON array of { field, op, value }; all conditions are AND'd.
-- Example:
--   conditions = [{"field":"odd_bet365","op":">","value":3.0}]
--   tag        = "high-odd"
CREATE TABLE IF NOT EXISTS tag_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  conditions TEXT NOT NULL,
  tag TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tag_rules_user_enabled ON tag_rules(user_id, enabled);
