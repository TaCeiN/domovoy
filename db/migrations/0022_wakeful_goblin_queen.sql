CREATE TABLE "house_favorite" (
	"user_id" text NOT NULL,
	"house_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "house_favorite_user_id_house_key_pk" PRIMARY KEY("user_id","house_key")
);
--> statement-breakpoint
CREATE TABLE "house_review" (
	"id" text PRIMARY KEY NOT NULL,
	"house_key" text NOT NULL,
	"user_id" text NOT NULL,
	"stars_uk" integer NOT NULL,
	"stars_clean" integer NOT NULL,
	"stars_neighbors" integer NOT NULL,
	"stars_quiet" integer NOT NULL,
	"stars_yard" integer NOT NULL,
	"pros" text,
	"cons" text,
	"hidden_at" timestamp with time zone,
	"hidden_by" text,
	"hidden_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poi" (
	"id" text PRIMARY KEY NOT NULL,
	"region_code" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_prompt" (
	"user_id" text NOT NULL,
	"house_key" text NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismiss_count" integer DEFAULT 0 NOT NULL,
	"bot_sent_at" timestamp with time zone,
	CONSTRAINT "review_prompt_user_id_house_key_pk" PRIMARY KEY("user_id","house_key")
);
--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "built_year" integer;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "floors" integer;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "entrances" integer;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "elevators" integer;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "wall_material" text;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "gas" boolean;--> statement-breakpoint
ALTER TABLE "house" ADD COLUMN "emergency" boolean;--> statement-breakpoint
ALTER TABLE "house_favorite" ADD CONSTRAINT "house_favorite_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "house_favorite" ADD CONSTRAINT "house_favorite_house_key_house_house_key_fk" FOREIGN KEY ("house_key") REFERENCES "public"."house"("house_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "house_review" ADD CONSTRAINT "house_review_house_key_house_house_key_fk" FOREIGN KEY ("house_key") REFERENCES "public"."house"("house_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "house_review" ADD CONSTRAINT "house_review_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "house_review" ADD CONSTRAINT "house_review_hidden_by_admin_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_prompt" ADD CONSTRAINT "review_prompt_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_prompt" ADD CONSTRAINT "review_prompt_house_key_house_house_key_fk" FOREIGN KEY ("house_key") REFERENCES "public"."house"("house_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "house_review_uq" ON "house_review" USING btree ("house_key","user_id");--> statement-breakpoint
CREATE INDEX "house_review_house_idx" ON "house_review" USING btree ("house_key");--> statement-breakpoint
CREATE INDEX "poi_region_idx" ON "poi" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "poi_geo_idx" ON "poi" USING btree ("lat","lon");--> statement-breakpoint
CREATE INDEX "house_geo_idx" ON "house" USING btree ("lat","lon");