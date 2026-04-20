-- Saved filter combinations per user. Scoped by "view" so different pages
-- (history, finances, ...) can persist their own sets without colliding.
-- filter_json holds the full query-string-shaped payload the view understands.
CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  view TEXT NOT NULL,
  name TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, view, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_filters_user_view ON saved_filters(user_id, view);
