import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

/**
 * Подключение к базе.
 *
 * Драйвер один — node-postgres: база живёт в своём контейнере рядом
 * с приложением (локально — `docker compose up -d db`, на бою — сервис `db`
 * в `docker-compose.prod.yml`). Облачных баз у проекта нет.
 */
export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * channel_binding=require ломает node-postgres: параметр понимает libpq,
 * а чистый JS-драйвер — нет.
 */
function stripUnsupportedParams(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Настройки TLS для node-postgres.
 *
 * Раньше здесь стояло `{ rejectUnauthorized: false }` — то есть канал
 * шифровался, но сертификат не проверялся вообще. Это защита от пассивного
 * прослушивания и НИКАКОЙ защиты от того, кто сумел встать посередине,
 * а по этому каналу ходят лицевые счета и адреса жильцов.
 *
 * Теперь по умолчанию сертификат проверяется системными корнями. Своя
 * УЦ-цепочка подкладывается через `NODE_EXTRA_CA_CERTS` — тем же способом,
 * каким в Dockerfile добавляется корневой сертификат Минцифры для MAX.
 * Отключить проверку можно только явно, переменной `DATABASE_SSL_INSECURE=1`,
 * и это видно в конфигурации, а не спрятано в коде.
 */
export function sslOptions(url: string): { rejectUnauthorized: boolean } | undefined {
  if (!url.includes('sslmode=require') && !url.includes('sslmode=verify')) return undefined;
  if (process.env.DATABASE_SSL_INSECURE === '1') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

let cached: Database | null = null;
let cachedPool: pg.Pool | null = null;

export function getDb(url = process.env.DATABASE_URL): Database {
  if (cached) return cached;
  if (!url) {
    throw new Error(
      'DATABASE_URL не задан. Локально: скопируйте .env.example в .env.local ' +
      'и поднимите базу через docker compose up -d db',
    );
  }

  cachedPool = new pg.Pool({
    connectionString: stripUnsupportedParams(url),
    ssl: sslOptions(url),
    max: 10,
  });
  cached = drizzle(cachedPool, { schema });
  return cached;
}

/** Куда подключились — для диагностики и логов старта. */
export function describeConnection(url = process.env.DATABASE_URL): string {
  if (!url) return 'не настроено';
  try {
    const { hostname, pathname } = new URL(url);
    return `node-postgres → ${hostname}${pathname}`;
  } catch {
    return 'некорректный DATABASE_URL';
  }
}

/** Закрыть пул. Нужно скриптам и тестам, чтобы процесс не висел. */
export async function closeDb(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
  }
  cached = null;
}
