-- TRUNCATE skips row-level triggers, so 0001's append-only audit log and 0006's immutable signed versions could be wiped
-- by it. Statement-level guards close that: TRUNCATE fires them, and so does a TRUNCATE ... CASCADE that reaches these
-- tables through a foreign key (from studies). The API tests' reset turns them off for its own transaction (test/helpers.ts).
CREATE FUNCTION audit_log_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();
--> statement-breakpoint
-- As DELETE: drafts may go, signed (and superseded) versions may not.
CREATE FUNCTION rulebook_versions_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rulebook_versions WHERE status IN ('signed', 'superseded')) THEN
    RAISE EXCEPTION 'signed rulebook versions are immutable';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER rulebook_versions_no_truncate BEFORE TRUNCATE ON rulebook_versions
  FOR EACH STATEMENT EXECUTE FUNCTION rulebook_versions_no_truncate();
