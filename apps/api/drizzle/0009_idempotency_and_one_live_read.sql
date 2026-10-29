CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"status" integer NOT NULL,
	"response" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
-- Custom: before the index, an older read still marked queued or running beside a newer one of the same version is
-- marked failed (only possible from before reads were queued in one transaction), so the index can be built.
UPDATE "jobs" SET "state" = 'failed', "step" = 'failed', "error" = 'This reading was replaced by a newer one.', "updated_at" = now()
WHERE "kind" = 'extract' AND "state" IN ('queued', 'running') AND "id" NOT IN (
  SELECT DISTINCT ON ("study_id", "version") "id" FROM "jobs" WHERE "kind" = 'extract' AND "state" IN ('queued', 'running') ORDER BY "study_id", "version", "created_at" DESC
);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_live_read_idx" ON "jobs" USING btree ("study_id","version") WHERE kind = 'extract' AND state IN ('queued', 'running');