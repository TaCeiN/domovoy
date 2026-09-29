-- Прежние председатели были ОТДЕЛЬНЫМИ УЧЁТКАМИ: логин, пароль, своя
-- сессия, свой веб-кабинет. Теперь председатель — это роль жителя, и такая
-- строка обязана ссылаться на app_user. Сопоставить старые учётки с людьми
-- нечем: у них нет ни max_user_id, ни привязки к квартире.
--
-- Поэтому они удаляются, а УК назначает председателей заново — из жителей
-- дома. Публикации остаются: подпись под ними теряет имя, но сами
-- объявления и опросы дома не пропадают, история дома не переписывается.
UPDATE "poll" SET "chairman_id" = NULL WHERE "chairman_id" IS NOT NULL;--> statement-breakpoint
UPDATE "post" SET "chairman_id" = NULL WHERE "chairman_id" IS NOT NULL;--> statement-breakpoint
-- Кто из председателей решил заявку — та же история: строка уходит,
-- решение остаётся, только без имени решившего
UPDATE "user_property" SET "decided_by_chairman_id" = NULL WHERE "decided_by_chairman_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "session" WHERE "chairman_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "chairman";--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_chairman_id_chairman_id_fk";
--> statement-breakpoint
DROP INDEX "chairman_login_uq";--> statement-breakpoint
ALTER TABLE "chairman" ALTER COLUMN "login" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chairman" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chairman" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user_property" ADD COLUMN "address_from_user" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chairman" ADD CONSTRAINT "chairman_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chairman_user_idx" ON "chairman" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chairman_house_active_uq" ON "chairman" USING btree ("house_key") WHERE "chairman"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "chairman_id";