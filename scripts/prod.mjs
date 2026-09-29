/**
 * Управление боевым стендом одной командой.
 *
 * ЗАЧЕМ. Раньше в инструкции стояло `set -a; . ./.env.prod; set +a` — это
 * синтаксис POSIX-оболочки, и в PowerShell он не просто не работает,
 * а ругается непонятным «Не удается найти параметр -a». Строку подключения
 * приходилось собирать руками из четырёх переменных, и ошибиться в ней
 * значило уехать не в ту базу.
 *
 * Здесь то же самое делает Node: читает `.env.prod`, собирает `DATABASE_URL`
 * и запускает нужную команду. Node одинаков в PowerShell, cmd и bash,
 * поэтому инструкция наконец одна на все оболочки.
 *
 *   npm run prod:up        поднять стенд
 *   npm run prod:down      остановить (данные остаются в томах)
 *   npm run prod:health    проверить живость
 *   npm run prod:migrate   накатить схему
 *   npm run prod:clear     стереть данные приложения, справочники оставить
 *   npm run prod:uk        завести кабинет УК
 *   npm run prod:logs      логи приложения
 *   npm run prod:studio    Drizzle Studio на боевой базе
 *
 * Полный цикл «остановить, очистить, поднять заново» — в docs/commands.md.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = '.env.prod';
const COMPOSE = ['-f', 'docker-compose.prod.yml', '--env-file', ENV_FILE];

/**
 * Разбор `.env.prod`.
 *
 * Свой, а не `--env-file`: значения нужны ЗДЕСЬ, чтобы собрать из них строку
 * подключения, а не просто попасть в окружение дочернего процесса.
 */
function readEnv() {
  let text;
  try {
    text = readFileSync(join(root, ENV_FILE), 'utf8');
  } catch {
    fail(`Нет файла ${ENV_FILE}. Возьмите заготовку: cp .env.prod.example .env.prod`);
  }

  const env = {};
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return env;
}

/**
 * Строка подключения к боевой базе С ХОСТА.
 *
 * Порт 5434 — та самая петля из docker-compose.prod.yml. Наружу база
 * закрыта, но с самой машины доступна, поэтому миграции и импорт идут
 * обычным `node`, без входа внутрь контейнера.
 */
function databaseUrl(env) {
  const need = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) fail(`В ${ENV_FILE} не заполнено: ${missing.join(', ')}`);

  const e = encodeURIComponent;
  return `postgresql://${e(env.POSTGRES_USER)}:${e(env.POSTGRES_PASSWORD)}@127.0.0.1:5434/${env.POSTGRES_DB}`;
}

/**
 * Занятый порт объясняем по-человечески.
 *
 * drizzle-kit падает на нём необработанным EADDRINUSE со стектрейсом
 * на двадцать строк, и по нему не догадаться, что виноват второй Studio —
 * например, `npm run db:studio`, открытый на базе разработки. А выглядит
 * это так, будто «студия не работает».
 */
async function assertPortFree(port) {
  const busy = await new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });

  if (!busy) return;

  fail(
`Порт ${port} занят — скорее всего, Studio уже запущен.

Частый случай: открыт «npm run db:studio», а он смотрит в базу разработки
из .env.local, а не в боевую. Закройте то окно и запустите заново —
либо возьмите другой порт:
  npm run prod:studio -- --port ${port + 1}`,
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Оболочка не используется нигде, и это осознанно.
 *
 * С `shell: true` аргументы склеиваются пробелом БЕЗ кавычек — путь к Node
 * (`C:\Program Files\nodejs\node.exe`) развалился бы по пробелу, а Node 22
 * ещё и печатает предупреждение DEP0190 про экранирование. Обходиться без
 * оболочки можно: `docker` libuv находит по PATH с подстановкой `.exe`
 * сам, а свои скрипты запускаются абсолютным путём.
 */
function run(command, args, extraEnv = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (r.error) fail(`Не удалось запустить ${command}: ${r.error.message}`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const docker = (...args) => run('docker', ['compose', ...COMPOSE, ...args]);

const withDb = (script, args, env) =>
  run(process.execPath, [script, ...args], { DATABASE_URL: databaseUrl(env) });

/** Живость: сначала мимо TLS, потом по домену — так видно, что именно легло. */
async function health(env) {
  const domain = env.DOMAIN;
  const targets = [
    ['напрямую   ', 'http://127.0.0.1:3001/api/health'],
    ['по домену  ', domain ? `https://${domain}/api/health` : null],
  ];

  for (const [label, url] of targets) {
    if (!url) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      console.log(label, res.status, await res.text());
    } catch (e) {
      console.log(label, '—', e.message);
    }
  }
}

const [command, ...rest] = process.argv.slice(2);
const env = readEnv();

switch (command) {
  case 'up':
    docker('up', '-d', '--build');
    break;

  case 'down':
    // Без -v: тома с базой и сертификатом переживают остановку
    docker('down');
    break;

  case 'restart':
    docker('restart', ...(rest.length ? rest : ['caddy']));
    break;

  case 'ps':
    docker('ps');
    break;

  case 'logs':
    docker('logs', rest[0] ?? 'app', '--tail', '50');
    break;

  case 'migrate':
    withDb('db/migrate.ts', rest, env);
    break;

  case 'dataset':
    withDb('db/dataset-load.ts', rest, env);
    break;

  case 'mock':
    // Заглушка ЖК для подбора дома; --clear выключает её (docs/mock-complexes.md)
    withDb('db/mock-load.ts', rest, env);
    break;

  /**
   * Демо-дом — ВНУТРИ контейнера приложения: фото заявок пишутся
   * в том domovoy_uploads, который с хоста не виден. Обычно — кабинет
   * оператора → «Демо-дом»; это запасной путь.
   *   npm run prod:demo [-- clear | on | off]
   */
  case 'demo':
    docker('exec', '-T', 'app', 'node', 'db/demo.ts', ['clear', 'on', 'off'].includes(rest[0]) ? rest[0] : 'reset');
    break;

  /**
   * Генератор фейковых квитанций против БОЕВОГО реестра.
   *
   * Читает только справочники, ничего не пишет. Нужен, чтобы проверять
   * дома, которые есть в бою: сойдётся ли адрес из квитанции с адресом
   * из реестра ГИС ЖКХ — вопрос, на котором ломались все прошлые заходы.
   */
  case 'receipts':
    withDb('tools/receipt-generator/server.mjs', rest, env);
    break;

  case 'uk':
    withDb('db/dispatcher-add.ts', rest, env);
    break;

  /**
   * Кнопки бота на живом телефоне: доходит ли payload до мини-приложения.
   * Токен бота — боевой, из .env.prod: сообщение придёт от настоящего бота.
   */
  /**
   * Бот на бою: подписка вебхука (subscribe | unsubscribe | status)
   * и набор фраз против GigaChat (eval) — с ключами из .env.prod.
   */
  case 'bot':
    run(process.execPath, ['db/bot.ts', ...rest], {
      DATABASE_URL: databaseUrl(env),
      ...Object.fromEntries(Object.entries(env).filter(([k]) =>
        /^(DOMAIN|MAX_BOT_TOKEN|MAX_BOT_USERNAME|MAX_API_BASE|BOT_WEBHOOK_SECRET|GIGACHAT_.*)$/.test(k))),
    });
    break;

  case 'bot-test':
    run(process.execPath, ['db/bot-test-send.ts', ...rest], {
      DATABASE_URL: databaseUrl(env),
      MAX_BOT_TOKEN: env.MAX_BOT_TOKEN ?? '',
      MAX_BOT_USERNAME: env.MAX_BOT_USERNAME ?? '',
      MAX_API_BASE: env.MAX_API_BASE ?? '',
    });
    break;

  /**
   * Учётка оператора на БОЮ.
   *
   * Отдельная команда по той же причине, что и `uk`: обычный `admin:add`
   * читает `.env.local`, то есть всегда заводит оператора в базе
   * разработки. Пароль от боевого кабинета, заведённый не в той базе, —
   * это полчаса недоумения, почему он не подходит.
   */
  case 'admin':
    withDb('db/admin-add.ts', rest, env);
    break;

  case 'clear': {
    /**
     * Подтверждение обязательно, и вот почему.
     *
     * Предохранитель внутри db/clear.ts требует --force только для «чужой»
     * базы, а локальной считает адреса localhost, 127.0.0.1 и db. Боевая
     * видна как 127.0.0.1:5434 с хоста и как db:5432 изнутри контейнера —
     * то есть проходит проверку и стирается молча. Здесь это исправлено:
     * без --yes команда не сделает ничего.
     */
    if (!rest.includes('--yes')) {
      console.error(
        `Очистка сотрёт данные приложения боевой базы «${env.POSTGRES_DB}»:\n` +
        '  жителей, объекты, лицевые счета, начисления, счётчики, заявки,\n' +
        '  объявления, опросы, сессии и кабинеты УК с председателями.\n' +
        '\n' +
        'Реестр организаций и справочник адресов останутся — их сносит\n' +
        'только db:reset, после которого нужен часовой импорт заново.\n' +
        '\n' +
        'Если это действительно нужно:  npm run prod:clear -- --yes',
      );
      process.exit(1);
    }
    withDb('db/clear.ts', rest.filter((a) => a !== '--yes'), env);
    console.log('\nКабинет УК стёрт вместе с остальным. Завести заново:');
    console.log('  npm run prod:uk -- --inn 6168108630 --login uk-trianon');
    break;
  }

  case 'health':
    await health(env);
    break;

  /**
   * Drizzle Studio против БОЕВОЙ базы.
   *
   * ЗАЧЕМ ОТДЕЛЬНАЯ КОМАНДА. `npm run db:studio` читает `.env.local`,
   * то есть всегда открывает базу разработки. Чтобы посмотреть боевую,
   * приходилось собирать строку подключения руками из четырёх переменных
   * и не забыть подменить хост: внутри compose база видна как `db:5432`,
   * а с машины — как 127.0.0.1:5434. Ошибиться значило уехать не в ту базу
   * и решить, что данные пропали.
   */
  case 'studio': {
    const portArg = rest.indexOf('--port');
    const port = portArg >= 0 ? Number(rest[portArg + 1]) : 4983;
    await assertPortFree(port);

    console.log(`Studio смотрит в БОЕВУЮ базу «${env.POSTGRES_DB}» (127.0.0.1:5434).`);
    console.log('Правки применяются СРАЗУ, без подтверждения.');
    console.log('Открыть: https://local.drizzle.studio');
    console.log('');

    run(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'studio', ...rest], {
      DATABASE_URL: databaseUrl(env),
    });
    break;
  }

  default:
    console.log(`Боевой стенд. Запускать из корня проекта.

  npm run prod:up                поднять (сборка + запуск)
  npm run prod:down              остановить, данные оставить
  npm run prod:health            проверить живость
  npm run prod:ps                состояние контейнеров
  npm run prod:logs              логи приложения (или: -- caddy)
  npm run prod:restart           перезапустить caddy (или: -- app)
  npm run prod:studio            Drizzle Studio на боевой базе

  npm run prod:migrate           накатить схему
  npm run prod:clear -- --yes    стереть данные, справочники оставить
  npm run prod:uk -- --inn 6168108630 --login uk-trianon

  npm run prod:receipts          генератор квитанций по боевому реестру

  npm run prod:dataset -- --region 61    набор региона из релиза GitHub, минут пять
  npm run prod:mock [-- --clear]         заглушка ЖК подбора: залить из релиза / очистить
  npm run prod:demo [-- clear|on|off]    демо-дом для экспертов (обычно — кабинет оператора)`);
    if (command) process.exit(1);
}
