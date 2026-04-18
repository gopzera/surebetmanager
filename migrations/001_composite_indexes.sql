-- Composite indexes aligned with actual query shapes (user_id + range column).
-- Dashboard buckets by user_id and by a date (event_date OR created_at), so a
-- two-column index skips the full scan within the user's rows.

CREATE INDEX IF NOT EXISTS idx_operations_user_event_date
  ON operations(user_id, event_date);
CREATE INDEX IF NOT EXISTS idx_operations_user_created
  ON operations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_giros_user_created
  ON giros(user_id, created_at);

-- Hot-path filters on operator_payments: "my pending" and "for operator X".
CREATE INDEX IF NOT EXISTS idx_operator_payments_user_status
  ON operator_payments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_operator_payments_user_due
  ON operator_payments(user_id, due_date);

-- Notifications list is always "my unseen first".
CREATE INDEX IF NOT EXISTS idx_notifications_user_seen_created
  ON notifications(user_id, seen, created_at);

-- Operator audit is always "for a specific operator, newest first".
CREATE INDEX IF NOT EXISTS idx_operator_audit_op_created
  ON operator_audit(operator_id, created_at);
