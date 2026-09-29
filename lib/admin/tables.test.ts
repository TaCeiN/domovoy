import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { admin, appUser, dispatcher, managingOrg } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { createSession } from '../auth/session.ts';
import { ADMIN_TABLES, SECRET_COLUMNS, PAGE_SIZE, readTable, listTables } from './tables.ts';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

async function seedUsers(n: number) {
  const db = testDb();
  for (let i = 0; i < n; i += 1) {
    await db.insert(appUser).values({ id: newId('usr'), fullName: `Житель ${i}` });
  }
}

test('таблица отдаётся страницами и с колонками', async () => {
  const db = testDb();
  await seedUsers(60);

  const first = await readTable(db, 'app_user', { page: 1 });
  assert.equal(first.rows.length, PAGE_SIZE);
  assert.equal(first.total, 60);
  assert.ok(first.columns.includes('full_name'));

  const second = await readTable(db, 'app_user', { page: 2 });
  assert.equal(second.rows.length, 10);
});

/**
 * ГЛАВНАЯ ПРОВЕРКА РАЗДЕЛА.
 *
 * Просмотр таблиц не должен превращаться в выгрузку учёток: хеш пароля
 * годится для перебора офлайн, а хеш токена — это действующий ключ
 * от чужой сессии. Проверяем ВСЕ таблицы, а не одну: забыть можно
 * ровно ту, о которой не подумали.
 */
test('ни один хеш и ни один токен не уходят наружу', async () => {
  const db = testDb();

  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Житель' });
  await createSession(db, userId, 'web');

  await db.insert(admin).values({
    id: newId('adm'), login: 'operator', passwordHash: 'секретный-хеш', name: 'Оператор',
  });
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000001', name: 'ООО УК', regionCode: '61',
  });
  await db.insert(dispatcher).values({
    id: newId('dsp'), orgId, login: 'disp', passwordHash: 'секретный-хеш', name: 'Диспетчер',
  });

  for (const name of ADMIN_TABLES) {
    const { columns, rows } = await readTable(db, name, { page: 1 });
    for (const secret of SECRET_COLUMNS) {
      assert.equal(columns.includes(secret), false, `${name}.${secret} попал в колонки`);
      for (const row of rows) {
        assert.equal(secret in row, false, `${name}.${secret} попал в строку`);
      }
    }
    for (const row of rows) {
      assert.equal(JSON.stringify(row).includes('секретный-хеш'), false,
        `${name}: хеш просочился под другим именем`);
    }
  }
});

test('неизвестная таблица отвергается, а не подставляется в запрос', async () => {
  const db = testDb();
  await assert.rejects(
    () => readTable(db, 'app_user; drop table app_user', { page: 1 }),
    /неизвестная таблица/i,
  );

  // И база на месте: запрос до неё не дошёл
  const still = await readTable(db, 'app_user', { page: 1 });
  assert.equal(still.total, 0);
});

test('поиск идёт по текстовым колонкам', async () => {
  const db = testDb();
  await db.insert(appUser).values({ id: newId('usr'), fullName: 'Петров Пётр' });
  await db.insert(appUser).values({ id: newId('usr'), fullName: 'Иванова Мария' });

  const found = await readTable(db, 'app_user', { page: 1, q: 'петров' });
  assert.equal(found.rows.length, 1);
  assert.equal(found.total, 1);
});

test('список таблиц берётся из схемы и считает строки', async () => {
  const db = testDb();
  await seedUsers(3);

  const tables = await listTables(db);
  const users = tables.find((t) => t.name === 'app_user');
  assert.ok(users, 'app_user в списке');
  assert.equal(users.rows, 3);

  assert.ok(tables.some((t) => t.name === 'house'),
    'таблица из свежей работы попала в список сама — список берётся из схемы');
});
