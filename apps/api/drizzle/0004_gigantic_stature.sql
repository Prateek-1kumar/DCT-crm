CREATE TABLE "alert_reads" (
	"alert_id" uuid NOT NULL,
	"person" text NOT NULL,
	CONSTRAINT "alert_reads_alert_id_person_pk" PRIMARY KEY("alert_id","person")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"study_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"by" text NOT NULL,
	"count" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_reads" ADD CONSTRAINT "alert_reads_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_list_idx" ON "alerts" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);