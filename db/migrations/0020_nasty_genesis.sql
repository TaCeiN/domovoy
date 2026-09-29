CREATE TABLE "operator_event_seen" (
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"seen_by" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_event_seen" ADD CONSTRAINT "operator_event_seen_seen_by_admin_id_fk" FOREIGN KEY ("seen_by") REFERENCES "public"."admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_event_seen_uq" ON "operator_event_seen" USING btree ("kind","ref_id");