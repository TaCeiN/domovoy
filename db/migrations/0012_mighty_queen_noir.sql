CREATE TABLE "house_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"house_key" text NOT NULL,
	"user_id" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
ALTER TABLE "house_claim" ADD CONSTRAINT "house_claim_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "house_claim_status_idx" ON "house_claim" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "house_claim_open_uq" ON "house_claim" USING btree ("house_key","user_id") WHERE "house_claim"."status" = 'open';