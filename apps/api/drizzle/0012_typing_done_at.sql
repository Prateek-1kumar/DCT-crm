ALTER TABLE "rulebook_versions" ADD COLUMN "typing_done_at" timestamp with time zone;--> statement-breakpoint

-- Typing was marked done when a by-hand draft got its questions: an existing one that has them is done. Drafts only: signed
-- and superseded versions are immutable (0006), and only a draft is ever typed or approved.
UPDATE rulebook_versions SET typing_done_at = updated_at WHERE by_hand AND status = 'draft' AND jsonb_array_length(review) > 0;
