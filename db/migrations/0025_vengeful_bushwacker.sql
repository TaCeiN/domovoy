CREATE TABLE "house_contact" (
	"id" text PRIMARY KEY NOT NULL,
	"house_key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"phone" text NOT NULL,
	"note" text,
	"updated_by_role" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "house_contact_house_idx" ON "house_contact" USING btree ("house_key");--> statement-breakpoint
CREATE UNIQUE INDEX "house_contact_kind_uq" ON "house_contact" USING btree ("house_key","kind") WHERE "house_contact"."kind" <> 'other';