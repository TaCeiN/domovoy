ALTER TABLE "house" ADD COLUMN "fias_guid" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "address_raw" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "house_key_loose" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "region_code" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "gis_house_guid" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "flat_count" integer;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "gar_flats" integer;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "registry_form" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "registry_org_id" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "lon" double precision;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "house" ADD CONSTRAINT "house_registry_org_id_managing_org_id_fk" FOREIGN KEY ("registry_org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Дома реестра переезжают из managed_house в реестровый слой house.
-- Человеческий слой (form, org_id, source) у уже существующих строк не трогается:
-- там решения оператора и правила частного дома.
-- Форма 'uk' — только у организаций с лицензией: без лицензии в managed_house
-- лежали ТСЖ и ЖСК, заведённые оператором через house:org.
INSERT INTO "house" ("house_key", "form", "source", "address_raw", "house_key_loose", "region_code",
                     "gis_house_guid", "flat_count", "registry_form", "registry_org_id", "imported_at")
SELECT mh."house_key", 'unknown', 'registry', mh."address_raw", mh."house_key_loose", mh."region_code",
       mh."gis_house_guid", mh."flat_count",
       CASE WHEN mo."license_number" IS NOT NULL THEN 'uk' ELSE 'unknown' END,
       mh."org_id", mh."imported_at"
  FROM "managed_house" mh
  JOIN "managing_org" mo ON mo."id" = mh."org_id"
ON CONFLICT ("house_key") DO UPDATE SET
  "address_raw" = EXCLUDED."address_raw",
  "house_key_loose" = EXCLUDED."house_key_loose",
  "region_code" = EXCLUDED."region_code",
  "gis_house_guid" = EXCLUDED."gis_house_guid",
  "flat_count" = EXCLUDED."flat_count",
  "registry_form" = EXCLUDED."registry_form",
  "registry_org_id" = EXCLUDED."registry_org_id",
  "imported_at" = EXCLUDED."imported_at";--> statement-breakpoint
DROP TABLE "managed_house" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "house_fias_uq" ON "house" USING btree ("fias_guid") WHERE "house"."fias_guid" is not null;--> statement-breakpoint
CREATE INDEX "house_loose_idx" ON "house" USING btree ("house_key_loose");--> statement-breakpoint
CREATE INDEX "house_region_idx" ON "house" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "house_registry_org_idx" ON "house" USING btree ("registry_org_id");
