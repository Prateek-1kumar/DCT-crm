CREATE TYPE "public"."ocr_status" AS ENUM('none', 'queued', 'running', 'done', 'failed');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ocr_status" "ocr_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ocr_pages_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ocr_error" text;