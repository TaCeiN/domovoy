/**
 * Создание баз и накат схемы одной командой.
 *
 *   npm run db:setup
 *
 * ЗАЧЕМ. Быстрый старт выглядел так:
 * `docker compose up -d db` → `npm run db:migrate` → `npm run dev`.
 * Но compose создаёт только одну базу, а тестовой `domovoy_test`
 * (и базы под другим именем из `.env.local`) не создавал никто,
 * ни compose, ни один скрипт проекта.
 *
 * Что получал следующий разработчик, скопировав папку целиком:
 *   — `db:migrate` падал с «database "…" does not exist»;
 *   — `npm test` не находил тестовую базу и МОЛЧА пропускал больше
 *     половины набора, выходя с кодом 0.
 *
 * Эта команда закрывает разрыв: читает адреса из окружения, создаёт
 * недостающие базы и накатывает схему в обе.
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { sslOptions } from './client.ts';

interface Target {
  label: string;
  url: string;
}

function parse(url: string) {
  const parsed = new URL(url);
  return {
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    adminUrl: new URL('/postgres', parsed).toString(),
  };
}

/** Создать базу, если её нет. Существующую не трогаем. */
async function ensureDatabase({ label, url }: Target): Promise<'создана' | 'уже была'> {
  const { database, adminUrl } = parse(url);

  const admin = new pg.Client({ connectionString: adminUrl, ssl: sslOptions(adminUrl) });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      'select 1 from pg_database where datname = $1',
      [database],
    );
    if (rows.length > 0) return 'уже была';

    /**
     * Имя базы нельзя передать параметром: CREATE DATABASE не принимает
     * плейсхолдеры. Поэтому проверяем его сами, а не надеемся на драйвер.
     */
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) {
      throw new Error(`Недопустимое имя базы «${database}» — только буквы, цифры и подчёркивание`);
    }
    await admin.query(`CREATE DATABASE "${database}"`);
    return 'создана';
  } finally {
    await admin.end();
  }
}

/** Накат миграций отдельным процессом: тот же код, что и `npm run db:migrate`. */
function migrate(url: string): void {
  const result = spawnSync(process.execPath, ['db/migrate.ts'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main() {
  const main = process.env.DATABASE_URL;
  if (!main) {
    console.error(
      'DATABASE_URL не задан.\n' +
      'Локально: docker compose up -d db, затем скопируйте .env.example в .env.local',
    );
    process.exit(1);
  }

  /**
   * Адрес тестовой базы берём из окружения, а если его нет — выводим
   * из рабочего добавлением `_test`. Так одна команда работает и на машине
   * с настроенным `.env.local`, и на чистой.
   */
  const test = process.env.TEST_DATABASE_URL ?? (() => {
    const parsed = new URL(main);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}_test`;
    return parsed.toString();
  })();

  const targets: Target[] = [
    { label: 'рабочая', url: main },
    { label: 'тестовая', url: test },
  ];

  for (const target of targets) {
    const { database } = parse(target.url);
    const what = await ensureDatabase(target);
    console.log(`База ${target.label} «${database}»: ${what}`);
  }

  for (const target of targets) {
    console.log(`\nСхема в ${target.label}:`);
    migrate(target.url);
  }

  console.log('\nГотово. Проверить: npm run check');
}

await main();
