ALTER TABLE "managed_house" ADD COLUMN "house_key_loose" text;--> statement-breakpoint
CREATE INDEX "managed_house_loose_idx" ON "managed_house" USING btree ("house_key_loose");