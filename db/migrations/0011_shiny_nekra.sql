DROP INDEX "request_org_number_uq";--> statement-breakpoint
DROP INDEX "request_status_idx";--> statement-breakpoint
ALTER TABLE "request" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "number_scope" text;--> statement-breakpoint
UPDATE "request" SET "number_scope" = "org_id" WHERE "number_scope" IS NULL OR "number_scope" = '';--> statement-breakpoint
ALTER TABLE "request" ALTER COLUMN "number_scope" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "request_scope_number_uq" ON "request" USING btree ("number_scope","number");--> statement-breakpoint
CREATE INDEX "request_status_idx" ON "request" USING btree ("number_scope","status");
