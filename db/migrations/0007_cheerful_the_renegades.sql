ALTER TABLE "request_photo" ADD COLUMN "stored_name" text;--> statement-breakpoint
ALTER TABLE "request_photo" ADD COLUMN "original_name" text;--> statement-breakpoint
ALTER TABLE "request_photo" ADD COLUMN "mime" text;--> statement-breakpoint
ALTER TABLE "request_photo" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "request_photo" ADD COLUMN "uploaded_by" text;--> statement-breakpoint
ALTER TABLE "request_photo" ADD COLUMN "uploaded_by_dispatcher" text;--> statement-breakpoint
ALTER TABLE "request_photo" ADD CONSTRAINT "request_photo_uploaded_by_app_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_photo" ADD CONSTRAINT "request_photo_uploaded_by_dispatcher_dispatcher_id_fk" FOREIGN KEY ("uploaded_by_dispatcher") REFERENCES "public"."dispatcher"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_photo_request_idx" ON "request_photo" USING btree ("request_id");