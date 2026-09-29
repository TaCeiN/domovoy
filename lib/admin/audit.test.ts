import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { admin, adminAction, managingOrg, property } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { recordAction, listActions, AUDIT_PAGE_SIZE } from './audit.ts';

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

async function seedAdmin() {
  const db = testDb();
  const id = newId('adm');
  await db.insert(admin).values({
    id, login: 'operator', passwordHash: 'не важно', name: 'Оператор Ольга',
  });
  return id;
}

test('запись хранит и машинное имя, и человеческую строку', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  await recordAction(db, {
    adminId,
    action: 'chairman.create',
    targetKind: 'house',
    targetId: HOUSE,
    summary: 'Назначен председатель: Петров Пётр',
    payload: { userId: 'usr_1' },
  });

  const { rows } = await listActions(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'chairman.create');
  assert.equal(rows[0].summary, 'Назначен председатель: Петров Пётр');
  assert.equal(rows[0].adminName, 'Оператор Ольга', 'видно, кто сделал');
  assert.equal(rows[0].targetId, HOUSE);
});

test('журнал отдаёт свежие первыми', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  for (const summary of ['первое', 'второе', 'третье']) {
    await recordAction(db, {
      adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE, summary,
    });
  }

  const { rows } = await listActions(db);
  assert.deepEqual(rows.map((r) => r.summary), ['третье', 'второе', 'первое']);
});

/**
 * Учётку оператора не удаляют, а выключают. Если бы записи уходили
 * вместе с ней, журнал стирался бы ровно тогда, когда он нужнее всего —
 * при разборе того, что натворил выключенный.
 */
test('журнал переживает выключение оператора', async () => {
  const db = testDb();
  const adminId = await seedAdmin();
  await recordAction(db, {
    adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE,
    summary: 'Форма дома: непосредственное управление',
  });

  await db.update(admin).set({ disabledAt: new Date() }).where(eq(admin.id, adminId));

  const { rows } = await listActions(db);
  assert.equal(rows.length, 1, 'записи остаются');
  assert.equal(rows[0].adminName, 'Оператор Ольга', 'и имя тоже');
});

/**
 * ЖУРНАЛ БЕЗ СТАРЫХ ЗАПИСЕЙ — ЭТО НЕ ЖУРНАЛ.
 *
 * Он заведён ради разбора спора через полгода: «кто снял меня
 * с должности», «кто закрыл жителю доступ». Жёсткий потолок в 200 строк
 * делал записи старше недостижимыми из кабинета вообще, никаким
 * способом, — то есть ровно к сроку, ради которого журнал существует,
 * ответа в нём уже не было.
 */
test('вторая страница отдаёт то, чего нет на первой', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  for (let i = 1; i <= 120; i++) {
    await recordAction(db, {
      adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE,
      summary: `запись ${String(i).padStart(3, '0')}`,
    });
  }

  const first = await listActions(db);
  assert.equal(first.rows.length, AUDIT_PAGE_SIZE);
  assert.equal(first.total, 120, 'всего записей столько, сколько их есть');
  assert.equal(first.page, 1);
  assert.equal(first.rows[0].summary, 'запись 120', 'свежие первыми');

  const second = await listActions(db, { page: 2 });
  assert.equal(second.rows.length, AUDIT_PAGE_SIZE);
  assert.equal(second.total, 120, 'счётчик не зависит от страницы');
  assert.equal(second.rows[0].summary, 'запись 070');

  const third = await listActions(db, { page: 3 });
  assert.equal(third.rows.length, 20, 'последняя страница короче');
  assert.equal(third.rows.at(-1)?.summary, 'запись 001', 'самая старая достижима');

  const seen = new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.id));
  assert.equal(seen.size, 120, 'страницы не повторяют и не теряют записи');
});

test('фильтр по датам сужает и выдачу, и счётчик', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  for (const [day, summary] of [
    ['2026-06-10', 'июньская'],
    ['2026-07-15', 'июльская'],
    ['2026-08-20', 'августовская'],
  ] as const) {
    await recordAction(db, {
      adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE, summary,
    });
    await db.update(adminAction)
      .set({ createdAt: new Date(`${day}T12:00:00Z`) })
      .where(eq(adminAction.summary, summary));
  }

  const july = await listActions(db, { from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(july.rows.map((r) => r.summary), ['июльская']);
  assert.equal(july.total, 1, 'счётчик считает по тому же условию, что и выдача');

  // Верхняя граница включает названный день целиком, а не его полночь
  const tillJuly15 = await listActions(db, { to: '2026-07-15' });
  assert.deepEqual(tillJuly15.rows.map((r) => r.summary), ['июльская', 'июньская']);

  const sinceJuly = await listActions(db, { from: '2026-07-01' });
  assert.deepEqual(sinceJuly.rows.map((r) => r.summary), ['августовская', 'июльская']);
});

/**
 * Параметры приходят из адресной строки кабинета. Журнал — последнее
 * место, где уместна ошибка 500: разбирают по нему как раз тогда,
 * когда всё остальное уже пошло не так.
 */
test('мусор в параметрах не роняет журнал', async () => {
  const db = testDb();
  const adminId = await seedAdmin();
  await recordAction(db, {
    adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE, summary: 'одна',
  });

  const page = await listActions(db, { page: -3 });
  assert.equal(page.page, 1, 'страница не бывает нулевой или отрицательной');
  assert.equal(page.rows.length, 1);

  const dates = await listActions(db, { from: 'вчера', to: '31 августа' });
  assert.equal(dates.rows.length, 1, 'неразобранная дата — это отсутствие фильтра');
  assert.equal(dates.total, 1);
});

/**
 * ХЭШ ДОМА ЧЕЛОВЕК НЕ ОПОЗНАЁТ.
 *
 * Колонка «Над чем» показывала `house: 556537cdc144…` и занимала половину
 * ширины таблицы. Оператор разбирает спор про конкретный дом, и адрес
 * лежит в базе рядом — показывать вместо него ключ значит заставлять
 * его лезть в SQL.
 */
test('журнал показывает адрес дома вместо ключа', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  await db.insert(property).values({
    id: newId('prp'),
    addressRaw: 'Ростов-на-Дону, пр-кт Ленина, д. 85/3, кв. 12',
    houseKey: HOUSE,
    flat: '12',
  });

  await recordAction(db, {
    adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE,
    summary: 'Форма дома: непосредственное управление',
  });

  const { rows } = await listActions(db);
  assert.equal(rows[0].targetLabel, 'Ростов-на-Дону, пр-кт Ленина, д. 85/3',
    'адрес без квартиры: запись про дом целиком');
  assert.equal(rows[0].targetId, HOUSE, 'ключ остаётся — его показывают подсказкой');
});

test('дом из реестра тоже опознаётся', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6168108630', name: 'ООО УК «Трианон»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE,
    orgId,
    regionCode: '61',
    addressRaw: '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3',
  });

  await recordAction(db, {
    adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE,
    summary: 'Форма дома: ТСЖ',
  });

  const { rows } = await listActions(db);
  assert.match(rows[0].targetLabel, /Ленина/, 'адрес взят из реестра');
});

/** Врать про адрес нельзя, а запись обязана остаться читаемой. */
test('неизвестный дом показывается ключом, а не пустотой', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  await recordAction(db, {
    adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE,
    summary: 'Форма дома: ЖСК',
  });

  const { rows } = await listActions(db);
  assert.equal(rows[0].targetLabel, HOUSE);
});

test('фильтр по действию сужает выдачу и счётчик', async () => {
  const db = testDb();
  const adminId = await seedAdmin();

  await recordAction(db, {
    adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE,
    summary: 'Форма дома: ТСЖ',
  });
  await recordAction(db, {
    adminId, action: 'chairman.create', targetKind: 'house', targetId: HOUSE,
    summary: 'Назначен председатель: Петров Пётр',
  });

  const filtered = await listActions(db, { action: 'chairman.create' });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].action, 'chairman.create');

  /**
   * Список действий для фильтра собирается из того, что в журнале есть:
   * новое действие появится в выпадающем списке само, без правки кода.
   */
  assert.deepEqual(
    filtered.actions.map((a) => a.action).sort(),
    ['chairman.create', 'house.form'],
    'список действий не зависит от выбранного фильтра',
  );
  const chairman = filtered.actions.find((a) => a.action === 'chairman.create');
  assert.match(chairman?.label ?? '', /председатель/i, 'в списке человеческая строка');
});
