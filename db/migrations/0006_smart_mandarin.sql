ALTER TABLE "app_user" ADD COLUMN "notify_mode" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "notify_prefs" jsonb;