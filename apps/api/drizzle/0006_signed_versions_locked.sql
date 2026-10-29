-- Signed (and superseded) versions are immutable as a whole row. 0005's trigger listed the columns it guarded, so the
-- others (version, study_id, sign_note, cost, pages, notes, cross_read) could still change, and the row could be deleted.
-- Now only these may change: signed → superseded, updated_at, and proofread marks (they never change the numbers).
CREATE OR REPLACE FUNCTION rulebook_versions_signed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('signed', 'superseded') THEN
      RAISE EXCEPTION 'signed rulebook versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('signed', 'superseded') AND (
       (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'proofread']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'proofread'])
    OR NOT (NEW.status = OLD.status OR (OLD.status = 'signed' AND NEW.status = 'superseded'))
  ) THEN
    RAISE EXCEPTION 'signed rulebook versions are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rulebook_versions_no_delete BEFORE DELETE ON rulebook_versions
  FOR EACH ROW EXECUTE FUNCTION rulebook_versions_signed_immutable();
