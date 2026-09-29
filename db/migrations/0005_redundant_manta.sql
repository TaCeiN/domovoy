CREATE TABLE "invite" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"created_by" text NOT NULL,
	"code" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_used_by_app_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invite_code_uq" ON "invite" USING btree ("code");--> statement-breakpoint
CREATE INDEX "invite_property_idx" ON "invite" USING btree ("property_id");