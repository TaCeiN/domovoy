-- Справочник КЛАДР заменён адресным деревом ГАР (address_object).
-- Регион перестаёт считаться загруженным, пока в него не загружен набор данных
-- (npm run prod:dataset): иначе житель без адреса в квитанции увидел бы
-- пустой поиск улиц вместо честного «регион пока не подключён».
UPDATE "region" SET "status" = 'loading', "place_count" = 0, "street_count" = 0;--> statement-breakpoint
DROP TABLE "address_place" CASCADE;--> statement-breakpoint
DROP TABLE "address_street" CASCADE;
