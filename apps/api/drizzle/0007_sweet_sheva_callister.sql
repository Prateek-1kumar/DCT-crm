CREATE TABLE "proofreads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"item" text NOT NULL,
	"by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proofreads" ADD CONSTRAINT "proofreads_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proofreads_version_item_by" ON "proofreads" USING btree ("version_id","item","by");--> statement-breakpoint
CREATE INDEX "proofreads_version" ON "proofreads" USING btree ("version_id");