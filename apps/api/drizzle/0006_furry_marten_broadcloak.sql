ALTER TABLE "documents" DROP COLUMN "ocr_status";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "ocr_pages_done";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "ocr_error";--> statement-breakpoint
DROP TYPE "public"."ocr_status";