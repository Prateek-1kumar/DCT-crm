-- A live rulebook never changes: once approved, a version's rulebook, documents and approval are fixed, and it can only
-- move on to superseded. Approved and superseded versions can't be deleted.
CREATE FUNCTION versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'superseded') THEN
      RAISE EXCEPTION 'An approved rulebook can''t be deleted.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'A superseded rulebook can''t be changed.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'approved' AND (
    NEW.status NOT IN ('approved', 'superseded')
    OR NEW.rulebook IS DISTINCT FROM OLD.rulebook
    OR NEW.problems IS DISTINCT FROM OLD.problems
    OR NEW.document_ids IS DISTINCT FROM OLD.document_ids
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
  ) THEN
    RAISE EXCEPTION 'A live rulebook can''t be changed: make a new version instead.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER versions_guard BEFORE UPDATE OR DELETE ON versions FOR EACH ROW EXECUTE FUNCTION versions_guard();
--> statement-breakpoint
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The audit log can''t be changed or deleted.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
