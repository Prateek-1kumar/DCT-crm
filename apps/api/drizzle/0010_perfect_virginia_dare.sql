ALTER TABLE "settings" ALTER COLUMN "maker_checker" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "rulebook_versions" ADD COLUMN "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Maker-checker is on for a new database (ADR-001 §10). 0001 seeded the settings row with the old default, so it's turned
-- on where nobody has used the database yet (nothing in the log). A database in use keeps the setting it has.
UPDATE settings SET maker_checker = true WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM audit_log);
