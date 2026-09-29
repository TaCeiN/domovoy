/**
 * Накат миграций обычным соединением node-postgres, транзакцией:
 * применяется либо всё, либо ничего.
 *
 *   npm run db:migrate            накатить
 *   npm run db:reset              снести схему и накатить заново
 *
 * Базы этот скрипт НЕ создаёт — на чистой машине нужен `npm run db:setup`.
 */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sslOptions } from './client.ts';

const MIGRATIONS_FOLDER = './db/migrations';
const RETRIES = 4;

/** channel_binding понимает libpq, но не понимает чистый JS-драйвер. */
function toTcpUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('channel_binding');
  return parsed.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NETWORK_ERROR = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|fetch failed|terminated/i;

/** Postgres: объект уже существует (42P07 таблица/индекс, 42710 объект, 42701 колонка). */
const ALREADY_EXISTS = /already exists|42P07|42710|42701/i;

/**
 * Повтор при обрыве канала.
 *
 * Тонкость, на которой это ломалось: запрос мог УСПЕШНО выполниться на сервере,
 * а ответ — потеряться по дороге. Тогда повтор натыкается на «relation already
 * exists», хотя всё в порядке. Поэтому начиная со второй попытки ошибка
 * «объект уже существует» считается доказательством того, что предыдущая
 * попытка долетела. На первой попытке она по-прежнему настоящая ошибка.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      if (attempt > 1 && ALREADY_EXISTS.test(message)) {
        console.log(`  ${label}: предыдущая попытка всё-таки долетела, идём дальше`);
        return undefined;
      }
      if (!NETWORK_ERROR.test(message) || attempt === RETRIES) break;

      console.log(`  ${label}: попытка ${attempt} не удалась (${message}), повторяю...`);
      await sleep(attempt * 700);
    }
  }
  throw lastError;
}

async function main() {
  const reset = process.argv.includes('--reset');

  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error(
      'DATABASE_URL не задан.\n' +
      'Локально:  docker compose up -d db,  затем скопируйте .env.example в .env.local',
    );
    process.exit(1);
  }

  const url = toTcpUrl(raw);
  const { hostname, pathname } = new URL(url);
  console.log(`Миграции → node-postgres → ${hostname}${pathname}`);

  const pool = new pg.Pool({
    connectionString: url,
    ssl: sslOptions(url),
    max: 1,
    keepAlive: true,
  });
  // Без обработчика pg роняет процесс на разрыве соединения
  pool.on('error', (e) => console.log('  соединение потеряно:', e.message));

  try {
    if (reset) {
      console.log('Сношу схему public целиком...');
      await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
      await pool.query('CREATE SCHEMA public');
      await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    }
    await withRetry('migrate', () =>
      migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER }),
    );

    const { rows } = await pool.query(
      `select table_name from information_schema.tables
       where table_schema='public' order by table_name`,
    );
    console.log(`Готово. Таблиц: ${rows.length}`);
    console.log(rows.map((r) => r.table_name).join(', '));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Миграции не прошли:', error instanceof Error ? error.message : error);
  process.exit(1);
});
