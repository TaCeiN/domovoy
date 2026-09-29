import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { house, region, managingOrg } from '../../db/schema.ts';
import { setHouseForm, markMultiFlat } from './form.ts';
import { wipeAppData } from '../../db/clear.ts';

/**
 * `db/clear.ts` живёт не под `lib/`, но тестового глоба у него нет
 * (`npm test` гоняет только `lib/**` и `server/**` — см. package.json),
 * поэтому проверка лежит здесь, рядом с `lib/house/form.ts`, которым
 * пользуется: правило частного дома зависит именно от таблицы `house`.
 */

const HOUSE = 'ростовская обл|аксайский р-н|садовая ул|17';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

/**
 * ДЕФЕКТ 4: `npm run db:clear` не чистил таблицу `house`.
 *
 * У неё нет внешних ключей, по которым её унесло бы каскадом с другими
 * таблицами (house_key — обычный текст, не FK), поэтому после очистки
 * оставались форма управления и признак многоквартирности домов, у которых
 * уже нет ни жителей, ни объектов. В частности, `multi_flat = true`
 * блокировал правило частного дома на следующем прогоне «с чистого листа».
 */
test('db:clear стирает форму дома и признак многоквартирности', async () => {
  const db = testDb();

  await setHouseForm(db, HOUSE, { form: 'tsj', source: 'operator', setBy: 'тест' });
  await markMultiFlat(db, HOUSE);

  const before = await db.select().from(house).where(eq(house.houseKey, HOUSE));
  assert.equal(before.length, 1, 'запись о доме должна была появиться');

  await wipeAppData(db);

  const after = await db.select().from(house).where(eq(house.houseKey, HOUSE));
  assert.equal(after.length, 0, 'house обязана очищаться вместе с остальными данными приложения');
});

/** Справочник адресов и реестр организаций очистка трогать не должна. */
test('db:clear не трогает справочник адресов и реестр организаций', async () => {
  const db = testDb();

  await db.insert(region).values({
    code: '61', name: 'Ростовская обл', status: 'loaded',
    source: 'тест', placeCount: 1, streetCount: 1, loadedAt: new Date(),
  }).onConflictDoNothing();
  const orgId = 'org_test_clear';
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000099', name: 'ООО УК «Справочник»', regionCode: '61',
  }).onConflictDoNothing();

  await wipeAppData(db);

  const regions = await db.select().from(region);
  const orgs = await db.select().from(managingOrg).where(eq(managingOrg.id, orgId));
  assert.equal(regions.length, 1, 'справочник адресов — не данные приложения');
  assert.equal(orgs.length, 1, 'реестр управляющих организаций — тоже');

  // Уборка за собой: эти строки — не то, что чистит resetTables другого теста
  await db.delete(managingOrg).where(eq(managingOrg.id, orgId));
});
