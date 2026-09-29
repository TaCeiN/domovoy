import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuilder, coverageSnapshot, resetCoverageCache, type Snapshot, type SnapshotRow } from './snapshot.ts';
import type { Database } from '../../db/client.ts';

const row = (over: Partial<SnapshotRow>): SnapshotRow => ({
  houseKey: 'k', lat: null, lon: null,
  registryForm: null, humanForm: 'unknown', houseKind: null, garFlats: 0, flatCount: null, garMkd: null,
  orgInn: null, orgHasContact: false, orgHasCabinet: false, hasChairman: false, residents: 0,
  placeGuid: 'p-aksai', placeName: 'Аксай', placeType: 'г', districtName: 'Аксайский',
  streetGuid: 's-mira', streetName: 'Мира', streetType: 'ул',
  ...over,
});

function build(rows: SnapshotRow[]) {
  const builder = new SnapshotBuilder();
  for (const r of rows) builder.add(r);
  return builder.finish();
}

test('кэш: устаревший снимок отдаётся сразу, новый строится в фоне один раз', async (t) => {
  resetCoverageCache();
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const made: Snapshot[] = [];
  let release: () => void = () => {};
  const build = async () => {
    const snapshot = new SnapshotBuilder().finish();
    made.push(snapshot);
    if (made.length > 1) await new Promise<void>((resolve) => { release = resolve; });
    return snapshot;
  };
  const db = {} as Database;

  const first = await coverageSnapshot(db, '61', build);
  assert.equal(made.length, 1);
  assert.equal(await coverageSnapshot(db, '61', build), first, 'свежий — из кэша');

  t.mock.timers.setTime(11 * 60_000);
  assert.equal(await coverageSnapshot(db, '61', build), first, 'устаревший отдаётся без ожидания');
  assert.equal(await coverageSnapshot(db, '61', build), first);
  assert.equal(made.length, 2, 'пересборка одна на все запросы');

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await coverageSnapshot(db, '61', build), made[1]);
  resetCoverageCache();
});

test('населённый пункт: многоквартирные по уровням, частные и вероятно частные отдельно', () => {
  const snapshot = build([
    row({ houseKey: 'a', garMkd: true, orgInn: '1', orgHasContact: true, lat: 47.2, lon: 39.8, residents: 2 }),
    row({ houseKey: 'b', garMkd: true, lat: 47.4, lon: 39.6 }),
    row({ houseKey: 'c', registryForm: 'private' }),
    row({ houseKey: 'd' }),
    row({ houseKey: 'e', placeGuid: 'p-other', placeName: 'Ковалевка', placeType: 'п', streetGuid: 's-2', streetName: 'Центральная' }),
  ]);

  const aksai = snapshot.places.find((p) => p.guid === 'p-aksai')!;
  assert.equal(aksai.total, 4);
  assert.deepEqual(aksai.mkd, { total: 2, address: 0, kind: 1, contact: 1, agreed: 0 });
  assert.equal(aksai.private, 1);
  assert.equal(aksai.likely, 1);
  assert.equal(aksai.residents, 1, 'домов с жителями, а не людей');
  assert.deepEqual([aksai.lat, aksai.lon].map((x) => Number(x!.toFixed(2))), [47.3, 39.7], 'середина домов с точками');
  assert.equal(aksai.district, 'Аксайский');
  assert.equal(snapshot.places.length, 2);
});

test('улицы пункта считаются тем же правилом', () => {
  const snapshot = build([
    row({ houseKey: 'a', garMkd: true }),
    row({ houseKey: 'b', streetGuid: 's-lenina', streetName: 'Ленина', orgInn: '1', orgHasContact: true, houseKind: 'mkd' }),
  ]);
  const streets = snapshot.streets.get('p-aksai')!;
  assert.deepEqual(streets.map((s) => [s.name, s.mkd.contact, s.mkd.kind]).sort(), [['Ленина', 1, 0], ['Мира', 0, 1]]);
});

test('точки: только дома с координатами, выборка по прямоугольнику и с пределом', () => {
  const snapshot = build([
    row({ houseKey: 'in', lat: 47.25, lon: 39.85, garMkd: true, orgInn: '1', orgHasContact: true }),
    row({ houseKey: 'out', lat: 55.7, lon: 37.6 }),
    row({ houseKey: 'none' }),
  ]);
  const found = snapshot.points({ south: 47, west: 39, north: 48, east: 40 }, 100);
  assert.deepEqual(found.rows, [[47.25, 39.85, 2, 0, 0, 'in']]);
  assert.equal(found.truncated, false);
  assert.equal(snapshot.points({ south: 0, west: 0, north: 90, east: 90 }, 1).truncated, true);
});

test('дом без населённого пункта не теряется: он в итогах региона', () => {
  const snapshot = build([row({ houseKey: 'x', placeGuid: null, placeName: null, placeType: null }), row({ houseKey: 'y' })]);
  assert.equal(snapshot.totals.total, 2);
  assert.equal(snapshot.places.reduce((sum, p) => sum + p.total, 0), 1);
  assert.equal(snapshot.totals.withoutPlace, 1);
});
