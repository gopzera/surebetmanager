-- Global audit log. Extends the concept from operator_audit to any mutation.
-- Use for: forensics ("quem apagou essa operação?"), undo recovery, and
-- anomaly detection.
--
-- entity:    'operation' | 'account' | 'giro' | 'freebet_adjustment' | ...
-- entity_id: PK of the affected row (nullable for bulk ops)
-- action:    'created' | 'updated' | 'deleted' | ...
-- details:   JSON — before/after diff or snapshot

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);
