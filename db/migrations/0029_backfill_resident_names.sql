-- Имя из заявки на доступ становится именем человека, если имени не было.
-- До 26.09.2026 оно оседало только в заявке, и человек без ФИО в квитанции
-- оставался «Житель» в приветствии, у председателя и в поиске оператора.
UPDATE "app_user" u
SET "full_name" = sub.claim_name
FROM (
  SELECT DISTINCT ON (up."user_id") up."user_id", up."claim_name"
  FROM "user_property" up
  WHERE up."claim_name" IS NOT NULL AND length(trim(up."claim_name")) >= 3
  ORDER BY up."user_id", up."created_at" DESC
) sub
WHERE u."id" = sub."user_id" AND u."full_name" = 'Житель';
