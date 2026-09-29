CREATE TABLE "address_object" (
	"guid" text PRIMARY KEY NOT NULL,
	"region_code" text NOT NULL,
	"parent_guid" text,
	"level" integer NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"search_name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "street_guid" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "house_kind" text;--> statement-breakpoint
ALTER TABLE "managing_org" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "managing_org" ADD COLUMN "site" text;--> statement-breakpoint
ALTER TABLE "managing_org" ADD COLUMN "frt_id" text;--> statement-breakpoint
CREATE INDEX "address_object_search_idx" ON "address_object" USING btree ("region_code","level","search_name");--> statement-breakpoint
CREATE INDEX "address_object_parent_idx" ON "address_object" USING btree ("parent_guid");--> statement-breakpoint
CREATE INDEX "house_street_idx" ON "house" USING btree ("street_guid");