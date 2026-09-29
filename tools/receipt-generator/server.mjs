import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { parseAddress, looseHouseKey } from '../../lib/address/normalize.ts';
import { pickHouse, addressWithFlat } from '../../lib/address/pick-house.ts';
import { effectiveHouse } from '../../lib/house/form.ts';
import { loadMapData } from './lib/map-data.mjs';

/**
 * Генератор фейковых квитанций.
 *
 * ЗАЧЕМ. В бою вход жителя работает только внутри MAX — строку QR туда
 * не вставишь, её надо ОТСКАНИРОВАТЬ. А чтобы проверить, как приложение
 * ведёт себя на разных домах, квитанций нужно много и по разным адресам.
 * Печатать их неоткуда: настоящие приходят раз в месяц и по одному адресу.
 *
 * Инструмент даёт выбрать дом из НАСТОЯЩЕГО реестра ГИС ЖКХ, собирает
 * строку по ГОСТ Р 56042-2014 и рисует сканируемый код на экран.
 *
 * ГЛАВНОЕ ЗДЕСЬ — не сам QR, а предсказание. Прежде чем сканировать,
 * страница показывает, что приложение сделает с этим адресом: какой
 * получится ключ дома, найдётся ли дом в реестре и какая организация
 * за ним закреплена. Половина прошлых поломок выглядела как «отсканировал,
 * а дома нет» — теперь это видно ДО сканирования.
 *
 * Инструмент читает базу НАПРЯМУЮ и только на чтение. В образ приложения
 * он не попадает (см. .dockerignore) и в бою не запускается.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.RECEIPT_TOOL_PORT ?? 3010);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error([
    'DATABASE_URL не задан.',
    '',
    'Локальная база:',
    '  npm run receipts',
    '',
    'Боевая (только чтение, порт на петле):',
    '  npm run receipts:prod',
  ].join('\n'));
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

/* ─────────────── данные ─────────────── */

/**
 * Поиск дома в реестре лицензий.
 *
 * ПО СЛОВАМ, А НЕ ПО ФРАЗЕ. Человек набирает «Ленина 85», а в реестре
 * записано «344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина,
 * д. 85/3»: между словами запятая, «д.» и пробелы, и поиск подстрокой
 * не находит ничего. Поэтому каждое слово ищется отдельно, и подходят
 * дома, где встретились ВСЕ слова — в любом порядке.
 *
 * Ключ дома для поиска не годится: это хеш, набрать его невозможно.
 */
async function searchHouses(query, limit = 25) {
  const words = query.split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return [];

  const conditions = words.map((_, i) => `h.address_raw ilike $${i + 1}`).join(' and ');
  const params = words.map((word) => `%${word.replace(/[\\%_]/g, '\\$&')}%`);
  params.push(limit);

  const { rows } = await pool.query(
    `select h.address_raw as address,
            h.house_key   as "houseKey",
            h.flat_count  as "flatCount",
            h.registry_form as "registryForm",
            coalesce(mo.short_name, mo.name) as "orgName",
            mo.inn as "orgInn"
       from house h
       left join managing_org mo on mo.id = h.registry_org_id
      where h.address_raw is not null and ${conditions}
      order by length(h.address_raw), h.address_raw
      limit $${words.length + 1}`,
    params,
  );
  return rows;
}

/**
 * Что приложение сделает с этим адресом.
 *
 * Повторяем ту же логику, что и привязка: строгий ключ, запасной без
 * региона, выбор дома при нескольких кандидатах. Импортируем настоящие
 * модули приложения, а не переписываем — иначе предсказание разойдётся
 * с поведением, и инструмент начнёт врать.
 */
async function previewAddress(addressRaw, flat) {
  const withFlat = flat ? addressWithFlat(addressRaw, flat) : addressRaw;
  const parsed = parseAddress(withFlat);

  if (!parsed.houseKey) {
    return {
      addressRaw: withFlat,
      parsed,
      verdict: 'no_key',
      message: 'Адрес не разбирается: нет номера дома. Приложение откажет.',
    };
  }

  const strict = await pool.query(
    `select h.house_key as "houseKey", h.address_raw as address,
            h.form, h.org_id as "orgId", h.multi_flat as "multiFlat", h.registry_form as "registryForm",
            h.registry_org_id as "registryOrgId", h.gar_flats as "garFlats",
            mo.license_number as "registryLicense", mo.gis_status as "gisStatus"
       from house h left join managing_org mo on mo.id = h.registry_org_id
      where h.address_raw is not null and h.house_key = $1`,
    [parsed.houseKey],
  );

  let found = strict.rows;
  let via = 'strict';

  if (found.length === 0) {
    const loose = looseHouseKey(withFlat);
    if (loose) {
      const byLoose = await pool.query(
        `select h.house_key as "houseKey", h.address_raw as address,
            h.form, h.org_id as "orgId", h.multi_flat as "multiFlat", h.registry_form as "registryForm",
            h.registry_org_id as "registryOrgId", h.gar_flats as "garFlats",
            mo.license_number as "registryLicense", mo.gis_status as "gisStatus"
       from house h left join managing_org mo on mo.id = h.registry_org_id
          where h.address_raw is not null and h.house_key_loose = $1
          limit 2`,
        [loose],
      );
      // Запасной путь принимается, только если совпадение единственное
      if (byLoose.rows.length === 1) {
        found = byLoose.rows;
        via = 'loose';
      } else if (byLoose.rows.length > 1) {
        via = 'ambiguous';
      }
    }
  }

  // Организация дома — по тем же правилам, что у приложения (lib/house/form.ts)
  const withOrg = found.map((row) => ({ ...row, ...effectiveHouse(row) }));
  const managed = pickHouse(withOrg, parsed.houseKey);
  const orgRow = managed?.orgId
    ? (await pool.query('select coalesce(short_name, name) as name, gis_status as "gisStatus" from managing_org where id = $1', [managed.orgId])).rows[0]
    : null;

  return {
    addressRaw: withFlat,
    parsed: {
      region: parsed.region,
      district: parsed.district,
      city: parsed.city,
      subplace: parsed.subplace,
      street: parsed.street,
      house: parsed.house,
      block: parsed.block,
      building: parsed.building,
      flat: parsed.flat,
      houseKey: parsed.houseKey,
    },
    via,
    verdict: managed ? (orgRow ? 'found' : 'found_no_org') : (via === 'ambiguous' ? 'ambiguous' : 'not_in_registry'),
    form: managed?.form ?? null,
    org: orgRow ? { name: orgRow.name, gisStatus: orgRow.gisStatus } : null,
    registryAddress: managed?.address ?? null,
    message: managed && !orgRow
      ? `Дом найден (${managed.form === 'private' ? 'частный дом' : 'организация неизвестна'}), `
        + 'но обслуживающей организации нет — заявку разберёт оператор.'
      : managed
      ? via === 'loose'
        ? `Дом найден ЗАПАСНЫМ ключом (без региона): «${orgRow.name}». `
          + 'В реестре он записан иначе — приложение возьмёт реестровое написание.'
        : `Дом найден: «${orgRow.name}». Заявку будет принимать она.`
      : via === 'ambiguous'
        ? 'Без региона нашлось несколько домов — приложение откажется выбирать '
          + 'и оставит квартиру без управляющей организации.'
        : 'Дома нет в реестре. Житель войдёт, но заявку отправлять будет некому.',
  };
}

/* ─────────────── HTTP ─────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Leaflet отдаём прямо из node_modules, а не вендорим копией.
 *
 * Фронт ПРИЛОЖЕНИЯ вендорят потому, что в бою node_modules рядом нет
 * (scripts/vendor-zxing.mjs). Инструмент разработки боевую машину
 * не видит никогда, и копия библиотеки была бы просто ещё одним файлом,
 * который однажды разъедется с package-lock.
 */
const LEAFLET = normalize(join(HERE, '../../node_modules/leaflet/dist'));

async function sendFile(path, res) {
  const body = await readFile(path).catch(() => null);
  if (!body) { res.writeHead(404).end('не найдено'); return; }

  res.writeHead(200, {
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(url, res) {
  // Два адреса без имени файла: генератор и карта
  let rel = url;
  if (url === '/') rel = '/index.html';
  if (url === '/map') rel = '/map.html';

  if (rel.startsWith('/vendor/leaflet/')) {
    const file = normalize(join(LEAFLET, rel.slice('/vendor/leaflet/'.length)));
    if (!file.startsWith(LEAFLET)) { res.writeHead(403).end('нет'); return; }
    return sendFile(file, res);
  }

  // Кодировщик QR живёт в lib/qr проекта: им рисует квитанции и сервер
  // приложения. Переадресация из ./lib ведёт браузер сюда
  if (rel.startsWith('/lib/qr/')) {
    const root = normalize(join(HERE, '../../lib/qr'));
    const file = normalize(join(root, rel.slice('/lib/qr/'.length)));
    if (!file.startsWith(root)) { res.writeHead(403).end('нет'); return; }
    return sendFile(file, res);
  }

  // Остальное — из двух мест: страницы из public, модули из lib —
  // те же самые, что использует тест кодировщика
  const base = rel.startsWith('/lib/') ? HERE : join(HERE, 'public');
  const path = normalize(join(base, rel));

  if (!path.startsWith(HERE)) {
    res.writeHead(403).end('нет');
    return;
  }

  return sendFile(path, res);
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Считается один раз при первом обращении к карте: 14 тысяч сопоставлений
 * и запрос всего реестра. Держать это в старте сервера значит заставить
 * ждать и того, кто пришёл просто за квитанцией.
 */
let mapData = null;
const mapReady = async () => (mapData ??= await loadMapData(pool, process.env.MAP_REGION ?? '61'));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/api/houses') {
      const query = (url.searchParams.get('q') ?? '').trim();
      if (query.length < 2) return json(res, 200, { houses: [] });
      return json(res, 200, { houses: await searchHouses(query) });
    }

    if (url.pathname === '/api/preview') {
      const address = (url.searchParams.get('address') ?? '').trim();
      const flat = (url.searchParams.get('flat') ?? '').trim();
      if (!address) return json(res, 400, { error: 'нужен адрес' });
      return json(res, 200, await previewAddress(address, flat));
    }

    if (url.pathname === '/api/stats') {
      const { rows } = await pool.query(
        `select (select count(*) from house where address_raw is not null) as houses,
                (select count(*) from managing_org) as orgs,
                (select count(*) from address_object where level in (7, 8)) as streets`,
      );
      return json(res, 200, rows[0]);
    }

    if (url.pathname.startsWith('/api/map/')) {
      const data = await mapReady();

      if (url.pathname === '/api/map/data') {
        // Пустая выгрузка — не ошибка: страница показывает, чем её собрать
        if (!data.ready) return json(res, 200, data);

        // Подробности дома остаются на сервере: карте при открытии нужны только точки
        const { meta, points } = data;
        return json(res, 200, { ready: true, meta, points });
      }

      if (!data.ready) return json(res, 409, data);

      if (url.pathname === '/api/map/point') {
        const detail = await data.detail(Number(url.searchParams.get('i')));
        return json(res, detail ? 200 : 404, detail ?? { error: 'нет такого дома' });
      }

    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const { hostname, port, pathname } = new URL(DATABASE_URL);
  console.log('Генератор квитанций → http://127.0.0.1:' + PORT);

  /**
   * «База не отвечает» и «реестр пуст» — два разных ответа.
   *
   * Здесь стояло `.catch(() => ({ rows: [{ houses: 0 }] }))`: любая ошибка,
   * включая незапущенную базу, превращалась в «домов в реестре: 0»
   * и совет запустить часовой импорт. 15 сентября так и вышло: после
   * перезагрузки компьютера дев-база не поднялась (в docker-compose.yml
   * нет `restart:`), генератор объявил реестр пустым, а импорт упал
   * с тем же ECONNREFUSED — при том что 14 221 дом лежал в томе целым.
   */
  let houses;
  try {
    const { rows } = await pool.query('select count(*)::int as houses from house where address_raw is not null');
    houses = rows[0].houses;
  } catch (error) {
    const reason = error?.code ?? error?.errors?.[0]?.code ?? (error instanceof Error ? error.message : String(error));
    console.log(`База ${hostname}:${port}${pathname} НЕ ОТВЕЧАЕТ (${reason}).`);
    /**
     * Лежащая база выглядит по-разному. Упавший контейнер (перезагрузка
     * компьютера, Exited 255) — это ECONNREFUSED. А просто остановленный
     * даёт «Connection terminated unexpectedly»: Docker Desktop держит
     * проброшенный порт открытым и рвёт соединение уже после приёма.
     * Проверено 15 сентября на обоих случаях.
     */
    const down = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(reason)
      || /Connection terminated/i.test(reason);
    if (down) {
      console.log('Скорее всего, контейнер базы не запущен — обычно после перезагрузки компьютера.');
      console.log('Поднять: docker compose up -d db   (импорт реестра заново НЕ нужен, данные в томе)');
    }
    return;
  }

  console.log(`База: ${hostname}${pathname}, домов в реестре: ${houses}`);
  if (houses === 0) {
    console.log('Реестр пуст — поиск дома ничего не найдёт. Загрузить: npm run dataset:load -- --region 61');
  }
});
