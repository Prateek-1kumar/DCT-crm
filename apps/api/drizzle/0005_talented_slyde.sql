ALTER TABLE "documents" ADD COLUMN "text_source" text;--> statement-breakpoint
ALTER TABLE "rulebook_versions" ADD COLUMN "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rulebook_versions" ADD COLUMN "review" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rulebook_versions" ADD COLUMN "pdf_check" jsonb;--> statement-breakpoint
ALTER TABLE "rulebook_versions" ADD COLUMN "by_hand" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rulebook_versions" ADD COLUMN "proofread" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Signed versions stay immutable, now with the evidence and questions they were approved with. Proofread marks are left
-- out on purpose: they never change the numbers, so a live version takes them.
CREATE OR REPLACE FUNCTION rulebook_versions_signed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('signed', 'superseded') AND (
       NEW.rulebook IS DISTINCT FROM OLD.rulebook OR NEW.anomalies IS DISTINCT FROM OLD.anomalies
    OR NEW.editors IS DISTINCT FROM OLD.editors OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
    OR NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.applies_from IS DISTINCT FROM OLD.applies_from
    OR NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.review IS DISTINCT FROM OLD.review
    OR NEW.pdf_check IS DISTINCT FROM OLD.pdf_check OR NEW.by_hand IS DISTINCT FROM OLD.by_hand
    OR NOT (NEW.status = OLD.status OR (OLD.status = 'signed' AND NEW.status = 'superseded'))
  ) THEN
    RAISE EXCEPTION 'signed rulebook versions are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A draft read before this migration has no questions, so it would go straight to approval with nothing checked.
-- Mark it failed: the contract page then offers "Read it again" (or typing it in by hand).
UPDATE "rulebook_versions" SET "status" = 'failed', "error" = 'Read before every number was checked against the PDF. Read it again.', "updated_at" = now()
WHERE "status" = 'draft';
--> statement-breakpoint
UPDATE "studies" s SET "needs_you" = 0,
  "status" = CASE WHEN EXISTS (SELECT 1 FROM "rulebook_versions" v WHERE v.study_id = s.id AND v.status = 'signed') THEN 'amendment_in_review' ELSE 'extraction_failed' END
WHERE EXISTS (
  SELECT 1 FROM "rulebook_versions" v
  WHERE v.study_id = s.id AND v.status = 'failed' AND v.version = (SELECT max(version) FROM "rulebook_versions" WHERE study_id = s.id)
);
