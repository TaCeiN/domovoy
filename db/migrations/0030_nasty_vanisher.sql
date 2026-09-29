CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_release" (
	"id" text PRIMARY KEY NOT NULL,
	"max_user_id" bigint NOT NULL,
	"role_key" text NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_role" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text NOT NULL,
	"position" integer NOT NULL,
	"holder_max_user_id" bigint,
	"holder_name" text,
	"held_since" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "demo_role" ADD CONSTRAINT "demo_role_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_release_max_idx" ON "demo_release" USING btree ("max_user_id");