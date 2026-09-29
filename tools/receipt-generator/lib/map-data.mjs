import { drizzle } from 'drizzle-orm/node-postgres';

import { coverageOf, coverageRows } from '../../../lib/coverage/levels.ts';

/**
 * Карта покрытия домов — данные для страницы /map.
 *
 * Уровни и их смысл живут в lib/coverage/levels.ts, а не здесь: этот же
 * подсчёт потом покажет кабинет оператора, и два разных «подключён»
 * в двух местах — ровно то, чего нельзя допускать.
 *
 * Координаты — из набора данных региона (`house.lat/lon`, OSM). Дом без
 * координат на карту не ложится, но в счётчиках есть: карта, умолчавшая
 * о том, чего не смогла разместить, соврала бы ровно там, где ей доверяют.
 */

export const LEVELS = ['address', 'kind', 'contact', 'agreed'];

export async function loadMapData(pool, regionCode = '61') {
  const db = drizzle(pool);
  const rows = await coverageRows(db, regionCode);

  if (rows.length === 0) {
    return { ready: false, reason: 'no_houses', command: `npm run dataset:load -- --region ${regionCode}` };
  }

  const { rows: regionRows } = await pool.query('select name, source from region where code = $1', [regionCode]);

  /**
   * Счётчики — по ВСЕМ домам, а не по тем, что легли на карту.
   * Многоквартирные и частные считаются раздельно: частный сектор
   * утопил бы процент покрытия домов, с которыми вообще есть о чём
   * договариваться.
   */
  const blank = () => ({ address: 0, kind: 0, contact: 0, agreed: 0, total: 0, onMap: 0, residents: 0 });
  const counts = { mkd: blank(), private: blank(), likely: blank() };

  // Точка: [lat, lon, уровень 0..3, группа 0 мкд · 1 частный · 2 вероятно частный, жители]
  const points = [];
  const keys = [];

  for (const row of rows) {
    const coverage = coverageOf(row);
    const group = coverage.isPrivate ? 'private' : coverage.privateLikely ? 'likely' : 'mkd';
    const bucket = counts[group];
    bucket[coverage.level]++;
    bucket.total++;
    if (row.residents > 0) bucket.residents++;

    if (row.lat === null || row.lon === null) continue;
    bucket.onMap++;
    points.push([
      row.lat, row.lon, LEVELS.indexOf(coverage.level),
      group === 'mkd' ? 0 : group === 'private' ? 1 : 2,
      row.residents,
    ]);
    keys.push(row.houseKey);
  }

  const byKey = new Map(rows.map((row) => [row.houseKey, row]));

  return {
    ready: true,
    meta: {
      regionName: regionRows[0]?.name ?? regionCode,
      source: regionRows[0]?.source ?? null,
      counts,
    },
    points,
    async detail(index) {
      const row = byKey.get(keys[index]);
      if (!row) return null;
      const { rows: orgs } = row.orgInn
        ? await pool.query(
          'select coalesce(short_name, name) as name, inn, phone, email, site, license_number as license from managing_org where inn = $1',
          [row.orgInn],
        )
        : { rows: [] };
      return {
        address: row.address,
        houseKey: row.houseKey,
        coverage: coverageOf(row),
        registryForm: row.registryForm,
        houseKind: row.houseKind,
        flats: row.flatCount ?? row.garFlats,
        residents: row.residents,
        hasChairman: row.hasChairman,
        org: orgs[0] ?? null,
      };
    },
  };
}
