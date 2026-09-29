CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"uk_id" text NOT NULL,
	"pers_acc" text NOT NULL,
	"service" text DEFAULT 'other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "address_place" (
	"code" text PRIMARY KEY NOT NULL,
	"region_code" text NOT NULL,
	"name" text NOT NULL,
	"socr" text,
	"parent_name" text,
	"postal_code" text
);
--> statement-breakpoint
CREATE TABLE "address_street" (
	"code" text PRIMARY KEY NOT NULL,
	"region_code" text NOT NULL,
	"place_code" text NOT NULL,
	"name" text NOT NULL,
	"socr" text,
	"postal_code" text,
	"search_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"phone_verified_at" timestamp with time zone,
	"max_user_id" bigint,
	"max_username" text,
	"max_photo_url" text,
	"max_chat_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"property_id" text NOT NULL,
	"period" text NOT NULL,
	"sum_kopecks" bigint NOT NULL,
	"purpose" text,
	"raw_qr" text,
	"source" text NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_kopecks" bigint,
	"paid_source" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chairman" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"house_key" text NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"flat" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dispatcher" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_house" (
	"id" text PRIMARY KEY NOT NULL,
	"house_key" text NOT NULL,
	"org_id" text NOT NULL,
	"region_code" text NOT NULL,
	"address_raw" text NOT NULL,
	"gis_house_guid" text,
	"flat_count" integer,
	"imported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "managing_org" (
	"id" text PRIMARY KEY NOT NULL,
	"inn" text NOT NULL,
	"kpp" text,
	"ogrn" text,
	"name" text NOT NULL,
	"short_name" text,
	"phone" text,
	"region_code" text NOT NULL,
	"license_number" text,
	"license_status" text,
	"gis_org_guid" text,
	"gis_status" text,
	"house_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "meter" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"kind" text NOT NULL,
	"serial" text,
	"verification_due" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter_reading" (
	"id" text PRIMARY KEY NOT NULL,
	"meter_id" text NOT NULL,
	"period" text NOT NULL,
	"value" text NOT NULL,
	"photo_url" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"deep_link_payload" text,
	"transport" text,
	"sent_at" timestamp with time zone,
	"error" text,
	"payload" jsonb,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"chairman_id" text,
	"house_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"opens_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_option" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"text" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_vote" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"option_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"house_key" text NOT NULL,
	"author_id" text,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"contact" text,
	"chairman_id" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "property" (
	"id" text PRIMARY KEY NOT NULL,
	"managing_org_id" text,
	"address_raw" text NOT NULL,
	"house_key" text NOT NULL,
	"postal_code" text,
	"region" text,
	"city" text,
	"street" text,
	"house" text,
	"block" text,
	"flat" text DEFAULT '' NOT NULL,
	"address_source" text DEFAULT 'receipt' NOT NULL,
	"address_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"stars" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "region" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"source" text,
	"place_count" integer DEFAULT 0 NOT NULL,
	"street_count" integer DEFAULT 0 NOT NULL,
	"loaded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "request" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"property_id" text NOT NULL,
	"org_id" text NOT NULL,
	"author_id" text NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"sla_due_at" timestamp with time zone,
	"master_slot_start" timestamp with time zone,
	"master_slot_end" timestamp with time zone,
	"assignee_name" text,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "request_event" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"actor" text NOT NULL,
	"actor_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_photo" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"dispatcher_id" text,
	"chairman_id" text,
	"token_hash" text NOT NULL,
	"platform" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uk" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"inn" text NOT NULL,
	"kpp" text,
	"payee_account" text,
	"bank_name" text,
	"bic" text,
	"corr_account" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_property" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"property_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"invite_code" text,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_uk_id_uk_id_fk" FOREIGN KEY ("uk_id") REFERENCES "public"."uk"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chairman" ADD CONSTRAINT "chairman_org_id_managing_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chairman" ADD CONSTRAINT "chairman_created_by_dispatcher_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."dispatcher"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatcher" ADD CONSTRAINT "dispatcher_org_id_managing_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_house" ADD CONSTRAINT "managed_house_org_id_managing_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter" ADD CONSTRAINT "meter_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_meter_id_meter_id_fk" FOREIGN KEY ("meter_id") REFERENCES "public"."meter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll" ADD CONSTRAINT "poll_org_id_managing_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll" ADD CONSTRAINT "poll_chairman_id_chairman_id_fk" FOREIGN KEY ("chairman_id") REFERENCES "public"."chairman"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_option" ADD CONSTRAINT "poll_option_poll_id_poll_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."poll"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_poll_id_poll_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."poll"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_option_id_poll_option_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_org_id_managing_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_chairman_id_chairman_id_fk" FOREIGN KEY ("chairman_id") REFERENCES "public"."chairman"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_managing_org_id_managing_org_id_fk" FOREIGN KEY ("managing_org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating" ADD CONSTRAINT "rating_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_org_id_managing_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."managing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_event" ADD CONSTRAINT "request_event_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_photo" ADD CONSTRAINT "request_photo_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_dispatcher_id_dispatcher_id_fk" FOREIGN KEY ("dispatcher_id") REFERENCES "public"."dispatcher"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_chairman_id_chairman_id_fk" FOREIGN KEY ("chairman_id") REFERENCES "public"."chairman"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_uk_persacc_uq" ON "account" USING btree ("uk_id","pers_acc");--> statement-breakpoint
CREATE INDEX "account_property_idx" ON "account" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "address_place_region_idx" ON "address_place" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "address_street_region_idx" ON "address_street" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "address_street_search_idx" ON "address_street" USING btree ("region_code","search_name");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_max_uq" ON "app_user" USING btree ("max_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_account_period_uq" ON "bill" USING btree ("account_id","period");--> statement-breakpoint
CREATE INDEX "bill_property_idx" ON "bill" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chairman_login_uq" ON "chairman" USING btree ("login");--> statement-breakpoint
CREATE INDEX "chairman_house_idx" ON "chairman" USING btree ("house_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatcher_login_uq" ON "dispatcher" USING btree ("login");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_house_key_uq" ON "managed_house" USING btree ("house_key");--> statement-breakpoint
CREATE INDEX "managed_house_org_idx" ON "managed_house" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managing_org_inn_uq" ON "managing_org" USING btree ("inn");--> statement-breakpoint
CREATE INDEX "managing_org_region_idx" ON "managing_org" USING btree ("region_code");--> statement-breakpoint
CREATE UNIQUE INDEX "meter_reading_uq" ON "meter_reading" USING btree ("meter_id","period");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "poll_house_idx" ON "poll" USING btree ("house_key");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_vote_uq" ON "poll_vote" USING btree ("poll_id","user_id");--> statement-breakpoint
CREATE INDEX "post_house_idx" ON "post" USING btree ("house_key","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "property_house_flat_uq" ON "property" USING btree ("house_key","flat");--> statement-breakpoint
CREATE INDEX "property_house_key_idx" ON "property" USING btree ("house_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rating_request_uq" ON "rating" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_org_number_uq" ON "request" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "request_status_idx" ON "request" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "request_property_idx" ON "request" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "request_event_request_idx" ON "request_event" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uq" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_inn_uq" ON "uk" USING btree ("inn");--> statement-breakpoint
CREATE UNIQUE INDEX "user_property_uq" ON "user_property" USING btree ("user_id","property_id");--> statement-breakpoint
CREATE INDEX "user_property_property_idx" ON "user_property" USING btree ("property_id");