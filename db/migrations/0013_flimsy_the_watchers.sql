CREATE TABLE "admin" (
	"id" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_action" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" text NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "admin_id" text;--> statement-breakpoint
ALTER TABLE "admin_action" ADD CONSTRAINT "admin_action_admin_id_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_login_uq" ON "admin" USING btree ("login");--> statement-breakpoint
CREATE INDEX "admin_action_at_idx" ON "admin_action" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_action_target_idx" ON "admin_action" USING btree ("target_kind","target_id");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_admin_id_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin"("id") ON DELETE no action ON UPDATE no action;