ALTER TABLE "user_property" ADD COLUMN "claim_name" text;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "claim_flat" text;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "claim_phone" text;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "claim_note" text;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "decided_by_chairman_id" text;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "decided_by_dispatcher_id" text;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_decided_by_chairman_id_chairman_id_fk" FOREIGN KEY ("decided_by_chairman_id") REFERENCES "public"."chairman"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_decided_by_dispatcher_id_dispatcher_id_fk" FOREIGN KEY ("decided_by_dispatcher_id") REFERENCES "public"."dispatcher"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_property_single_owner_uq" ON "user_property" USING btree ("property_id") WHERE "user_property"."role" = 'owner' and "user_property"."status" = 'active';--> statement-breakpoint
CREATE INDEX "user_property_pending_idx" ON "user_property" USING btree ("status","property_id");--> statement-breakpoint
-- Переименование статуса: 'invited' означал «ждёт подтверждения», но читался
-- как «его пригласили», хотя приглашения никто не отправлял — человек сам
-- предъявил квитанцию. Теперь это 'pending', и так же называется в коде.
UPDATE "user_property" SET "status" = 'pending' WHERE "status" = 'invited';
