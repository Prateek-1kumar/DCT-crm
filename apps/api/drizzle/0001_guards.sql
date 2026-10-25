-- Audit log is append-only: refuse UPDATE and DELETE at the database level.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
-- Signed versions are immutable: only the signed → superseded status change is allowed.
CREATE FUNCTION rulebook_versions_signed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('signed', 'superseded') AND (
       NEW.rulebook IS DISTINCT FROM OLD.rulebook OR NEW.anomalies IS DISTINCT FROM OLD.anomalies
    OR NEW.editors IS DISTINCT FROM OLD.editors OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
    OR NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.applies_from IS DISTINCT FROM OLD.applies_from
    OR NOT (NEW.status = OLD.status OR (OLD.status = 'signed' AND NEW.status = 'superseded'))
  ) THEN
    RAISE EXCEPTION 'signed rulebook versions are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rulebook_versions_immutable BEFORE UPDATE ON rulebook_versions
  FOR EACH ROW EXECUTE FUNCTION rulebook_versions_signed_immutable();
--> statement-breakpoint
INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;
