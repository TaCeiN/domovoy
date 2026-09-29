/**
 * Очистка данных приложения. Справочники остаются на месте.
 *
 *   npm run db:clear
 *
 * Нужна для ручной проверки: пройти вход по квитанции с чистого листа,
 * не потеряв реестр и адреса.
 *
 * ЧТО УХОДИТ: жители, объекты, лицевые счета, начисления, счётчики,
 * заявки, объявления, опросы, сессии, кабинеты УК и председателей, а также
 * то, что приложение УЗНАЛО о доме (`house`: форма управления, признак
 * многоквартирности) — это тоже наши данные, не справочник.
 *
 * ЧТО ОСТАЁТСЯ: реестр управляющих организаций с их домами и справочник
 * адресов. Это внешние данные, а не наши: реестр Ростовской области —
 * 716 организаций и 14 275 домов, импорт идёт около часа. Стереть их
 * заодно с демо-набором значит потерять час на ровном месте — один раз
 * это уже произошло.
 *
 * Отличие от `npm run db:reset`: тот сносит схему целиком, вместе
 * со справочниками, и после него нужен повторный импорт.
 */
import { sql } from 'drizzle-orm';
import { getDb, closeDb, describeConnection } from './client.ts';

/**
 * Порядок таблиц роли не играет: `cascade` разберётся со ссылками,
 * а `restart identity` вернёт счётчики в начало — иначе повторный засев
 * падал бы на уникальном номере заявки.
 *
 * `house` — в списке ЯВНО. У неё нет внешних ключей, по которым её унесло
 * бы каскадом из-за truncate какой-то другой таблицы: `house_key` в ней —
 * обычный текст, а не FK на `property`. Пока её здесь не было, после
 * очистки у домов оставались форма управления и признак многоквартирности,
 * хотя ни жителей, ни объектов у них уже не было, — и это сразу ломало
 * правило частного дома на следующем прогоне: `markMultiFlat` однажды
 * выставленный `multi_flat = true` эта команда не снимала.
 *
 * `house_claim` явно не перечислена — она уходит сама, каскадом
 * от `app_user` (её `user_id` на него ссылается).
 */
export async function wipeAppData(db: ReturnType<typeof getDb>) {
  await db.execute(sql`
    truncate table
      request_event, request_photo, rating, request,
      poll_vote, poll_option, poll, post,
      meter_reading, meter, bill, notification,
      session, user_property, chairman, dispatcher, account, property, app_user, uk, house,
      bot_dialog, bot_usage, bot_seen, bot_miss
    restart identity cascade
  `);
}

/**
 * Предохранитель: по нелокальному адресу очистка снесёт боевые данные.
 * Там требуем --force.
 */
export function refuseRemote(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  const local = /@(localhost|127\.0\.0\.1|db)[:/]/.test(url);
  if (local || process.argv.includes('--force')) return false;

  console.error(
    'База не локальная, а очистка стирает данные приложения целиком.\n' +
    'Если это действительно нужно — повторите с флагом --force.',
  );
  return true;
}

/** Запуск как команды; при импорте из seed.ts это не выполняется. */
if (import.meta.filename === process.argv[1]) {
  const db = getDb();
  console.log('Очистка →', describeConnection());

  if (refuseRemote()) {
    process.exitCode = 1;
  } else {
    await wipeAppData(db);
    console.log(
      'Данные приложения стёрты. Реестр организаций и справочник адресов на месте.',
    );
  }

  await closeDb();
}
