CREATE TABLE "house" (
	"house_key" text PRIMARY KEY NOT NULL,
	"form" text DEFAULT 'unknown' NOT NULL,
	"org_id" text,
	"multi_flat" boolean,
	"source" text DEFAULT 'registry' NOT NULL,
	"set_by" text,
	"set_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "house" ADD CONSTRAINT "house_org_id_managing_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;