ALTER TABLE "chairman" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chairman" ADD COLUMN "created_by_source" text DEFAULT 'dispatcher' NOT NULL;