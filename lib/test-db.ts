import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.ts';
import { resetRateLimits } from './rate-limit.ts';
import { eq } from 'drizzle-orm';

/**
 * База для интеграционных тестов.
 *
 * ЗАЩИТА ОТ ВЫСТРЕЛА В НОГУ: тесты чистят таблицы, поэтому подключаться
 * к чему-то, кроме локальной базы, запрещено. Один невнимательный запуск
 * с облачной строкой в окружении — и демо-данные вытерты за секунду.
 * Обойти можно только явным TEST_DB_ALLOW_REMOTE=1.
 */

/**
 * ОТДЕЛЬНАЯ БАЗА, а не та, в которой лежит демо.
 *
 * Тесты делают TRUNCATE всех таблиц. Пока адрес совпадал с рабочим,
 * каждый `npm test` молча вытирал засеянный стенд: сервер продолжал
 * работать, но житель, квитанции и диспетчер исчезали — и это выглядело
 * как поломка входа, а не как последствие прогона тестов.
 *
 * Базу создаёт и накатывает `npm run db:setup`.
 */
export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://domovoy:domovoy@localhost:5433/domovoy_test';

const TABLES = [
  'demo_release', 'demo_role', 'bill_bringer', 'app_setting',
  'bot_draft', 'bot_dialog', 'assistant_dialog', 'bot_miss', 'bot_usage', 'bot_seen', 'house_contact',
  'mock_complex_photo', 'mock_complex',
  'house_review', 'house_favorite', 'review_prompt', 'poi',
  'operator_event_seen', 'house_claim',
  'notification', 'admin_action', 'session', 'rating', 'request_photo', 'request_event', 'request',
  'poll_vote', 'poll_option', 'poll', 'post', 'meter_reading', 'meter',
  'bill', 'account', 'user_property', 'property', 'chairman', 'dispatcher', 'uk', 'app_user',
  'address_object', 'region', 'house', 'managing_org',
  // Последней: на неё ссылаются и admin_action, и session — они уже очищены выше
  'admin',
];

function assertLocal(url: string) {
  if (process.env.TEST_DB_ALLOW_REMOTE === '1') return;
  const { hostname } = new URL(url);
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'db';
  if (!local) {
    throw new Error(
      `Тесты чистят таблицы и работают только с локальной базой, а указан ${hostname}.\n` +
      'Поднимите её: docker compose up -d db',
    );
  }
}

let pool: pg.Pool | null = null;

export function testDb() {
  assertLocal(TEST_URL);
  pool ??= new pg.Pool({ connectionString: TEST_URL, max: 4 });
  return drizzle(pool, { schema });
}

/**
 * Есть ли база для интеграционных тестов.
 *
 * ПОЧЕМУ ЗДЕСЬ ПАДЕНИЕ, А НЕ ТИХИЙ ПРОПУСК. Раньше без базы `npm test`
 * молча пропускал 135 тестов из 228 и выходил с кодом 0 — отчёт выглядел
 * успешным, отличаясь от настоящего одной строкой `skipped`. На свежей
 * машине это состояние по умолчанию: прежний быстрый старт базу
 * не создаёт. То есть следующий разработчик видел «всё зелено», не выполнив
 * ни одного сквозного теста.
 *
 * Пропуск остаётся, но теперь его надо попросить: `ALLOW_SKIP_DB_TESTS=1`.
 * Так локально можно быстро гонять юнит-тесты, а «зелёный без базы»
 * перестаёт случаться сам собой.
 */
export async function isDbAvailable(): Promise<boolean> {
  try {
    assertLocal(TEST_URL);
    const probe = new pg.Pool({ connectionString: TEST_URL, max: 1, connectionTimeoutMillis: 1500 });
    await probe.query('select 1');
    await probe.end();
    return true;
  } catch (error) {
    if (process.env.ALLOW_SKIP_DB_TESTS === '1') return false;

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error([
      `Тестовая база недоступна (${TEST_URL}): ${reason}`,
      '',
      'Больше половины набора — сквозные проверки, и без базы они не выполняются.',
      'Поднять базу:',
      '  docker compose up -d db',
      '  npm run db:setup',
      '',
      'Если юнит-тесты нужны прямо сейчас без базы: ALLOW_SKIP_DB_TESTS=1 npm test',
    ].join('\n'));
  }
}

export async function resetTables(): Promise<void> {
  /**
   * Счётчик частоты живёт в памяти процесса и переживает TRUNCATE.
   * Без сброса десятый по счёту вход в одном прогоне получал 429,
   * и падал не тот тест, который сломан.
   */
  resetRateLimits();

  const db = testDb();
  await db.execute(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Подтвердить все ожидающие заявки. ФИКСТУРА, а не поведение приложения.
 *
 * Квитанция теперь заводит заявку, а доступ открывает председатель или
 * УК (см. lib/auth/claims.ts). Тесты про ленту дома, заявки и счётчики
 * не о том, кто кого подтверждает, — им нужен житель с доступом. Гонять
 * их через полный кабинет председателя значило бы проверять модель
 * доступа по десятому разу и ломать все эти файлы при каждой её правке.
 *
 * Сама модель проверяется там, где ей место: lib/auth/bind.test.ts
 * и server/routes/auth.test.ts.
 *
 * Первый по времени на объекте получает «собственника», остальные —
 * «жильца»: ровно так же, как это сделал бы председатель.
 */
export async function grantAccess(): Promise<void> {
  const db = testDb();

  const pending = await db.execute(
    `select up.id, up.property_id
       from user_property up
      where up.status = 'pending'
      order by up.created_at, up.id`,
  );

  const seen = new Set<string>();
  const takenOwner = await db.execute(
    `select property_id from user_property where role = 'owner' and status = 'active'`,
  );
  for (const row of takenOwner.rows as { property_id: string }[]) seen.add(row.property_id);

  for (const row of pending.rows as { id: string; property_id: string }[]) {
    const role = seen.has(row.property_id) ? 'member' : 'owner';
    seen.add(row.property_id);

    await db.execute(
      /**
       * Имя из заявки НЕ выдумываем.
       *
       * Оно становится подписью под объявлениями председателя и именем
       * в списке жильцов. Подставив сюда заглушку, мы получали бы
       * «Председатель совета дома · Тестовый Житель» вместо настоящей
       * фамилии, и тесты проверяли бы фикстуру, а не поведение.
       */
      `update user_property
          set status = 'active', role = '${role}', decided_at = now()
        where id = '${row.id}'`,
    );
  }
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Дом из набора данных региона — ФИКСТУРА реестрового слоя `house`.
 *
 * Раньше тесты вставляли строку в `managed_house`. Теперь реестр живёт
 * в колонках `registry_*` той же таблицы, что и решения людей, и писать
 * их вручную в каждом тесте значило бы размножить знание о том, как
 * загрузчик набора выводит форму. Форма по умолчанию — как в миграции:
 * организация с лицензией даёт 'uk', без лицензии — 'unknown'.
 */
export async function insertRegistryHouse(
  db: ReturnType<typeof testDb>,
  input: {
    houseKey: string;
    addressRaw: string;
    orgId?: string | null;
    registryForm?: string;
    regionCode?: string;
    houseKeyLoose?: string | null;
    garFlats?: number;
    flatCount?: number | null;
    lat?: number | null;
    lon?: number | null;
    houseKind?: string | null;
    garMkd?: boolean | null;
    builtYear?: number | null;
    floors?: number | null;
    streetGuid?: string | null;
  },
): Promise<void> {
  let registryForm = input.registryForm;
  if (!registryForm) {
    registryForm = 'unknown';
    if (input.orgId) {
      const [org] = await db
        .select({ licenseNumber: schema.managingOrg.licenseNumber })
        .from(schema.managingOrg)
        .where(eq(schema.managingOrg.id, input.orgId));
      if (org?.licenseNumber) registryForm = 'uk';
    }
  }

  const values = {
    addressRaw: input.addressRaw,
    houseKeyLoose: input.houseKeyLoose ?? null,
    regionCode: input.regionCode ?? '61',
    registryForm,
    registryOrgId: input.orgId ?? null,
    garFlats: input.garFlats ?? 0,
    flatCount: input.flatCount ?? null,
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    houseKind: input.houseKind ?? null,
    garMkd: input.garMkd ?? null,
    builtYear: input.builtYear ?? null,
    floors: input.floors ?? null,
    streetGuid: input.streetGuid ?? null,
    importedAt: new Date(),
  };

  await db
    .insert(schema.house)
    .values({ houseKey: input.houseKey, ...values })
    .onConflictDoUpdate({ target: schema.house.houseKey, set: values });
}
