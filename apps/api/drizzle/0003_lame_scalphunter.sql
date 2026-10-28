ALTER TABLE "studies" ADD COLUMN "needs_you" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "stage" integer GENERATED ALWAYS AS (CASE WHEN status IN ('needs_review', 'amendment_in_review') THEN (CASE WHEN needs_you > 0 THEN 0 ELSE 3 END) WHEN status = 'extraction_failed' THEN 1 WHEN status = 'setting_up' THEN 2 WHEN status = 'extracting' THEN 4 ELSE 5 END) STORED NOT NULL;--> statement-breakpoint
-- Backfill: open anomalies on the latest version when it is a draft (what studySummaryDto counted). stage is generated from it.
UPDATE "studies" s SET "needs_you" = (
  SELECT count(*) FROM "rulebook_versions" v, jsonb_array_elements(v.anomalies) a
  WHERE v.study_id = s.id AND v.status = 'draft' AND coalesce(a->'resolution', 'null') = 'null'
    AND v.version = (SELECT max(version) FROM "rulebook_versions" WHERE study_id = s.id)
);--> statement-breakpoint
CREATE INDEX "studies_list_idx" ON "studies" USING btree ("stage",(CASE WHEN stage = 0 THEN 1 ELSE -1 END * extract(epoch FROM updated_at - timestamptz 'epoch')),"id");--> statement-breakpoint
CREATE INDEX "studies_site_idx" ON "studies" USING btree ("site_name");