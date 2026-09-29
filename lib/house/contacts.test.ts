import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import {
  cleanPhone, saveContact, listContacts, findContact, removeContact, contactsForResident,
} from './contacts.ts';
import { appUser, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';

/**
 * Телефоны дома.
 *
 * Главное здесь — что на экран аварийных служб не попадёт мусор вместо
 * номера и что готовая служба в доме одна: две «лифтёрских» с разными
 * номерами хуже, чем ни одной.
 */

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';
const db = () => testDb();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await closeTestDb(); });

const HOUSE = 'house-contacts-test';
const by = { role: 'chairman' as const, by: 'chr_TEST' };

test('телефон: принимаем, как вписали, отсекаем мусор', () => {
  assert.equal(cleanPhone(' +7 (863) 200-00-00 '), '+7 (863) 200-00-00');
  assert.equal(cleanPhone('112'), '112');
  assert.equal(cleanPhone('8  800   100 00 00'), '8 800 100 00 00');
  assert.equal(cleanPhone('12'), null, 'меньше трёх цифр — не номер');
  assert.equal(cleanPhone('звоните Ивану'), null);
  assert.equal(cleanPhone('1234567890123456'), null, 'больше 15 цифр — не номер');
  assert.equal(cleanPhone(''), null);
});

test('готовая служба в доме одна: второй раз номер заменяется', { skip }, async () => {
  const first = await saveContact(db(), { houseKey: HOUSE, kind: 'lift', phone: '200-00-01', ...by });
  assert.equal(first.ok, true);
  const second = await saveContact(db(), {
    houseKey: HOUSE, kind: 'lift', phone: '200-00-02', note: 'круглосуточно', ...by,
  });
  assert.equal(second.ok, true);

  const list = await listContacts(db(), HOUSE);
  assert.equal(list.length, 1);
  assert.equal(list[0].phone, '200-00-02');
  assert.equal(list[0].title, 'Лифтёрская служба');
  assert.equal(list[0].note, 'круглосуточно');
});

test('ошибки ввода объясняются', { skip }, async () => {
  const badKind = await saveContact(db(), { houseKey: HOUSE, kind: 'police', phone: '02', ...by });
  assert.equal(badKind.ok, false);
  if (!badKind.ok) assert.equal(badKind.reason, 'bad_kind');

  const badPhone = await saveContact(db(), { houseKey: HOUSE, kind: 'lift', phone: 'нет', ...by });
  assert.equal(badPhone.ok, false);
  if (!badPhone.ok) assert.match(badPhone.message, /Проверьте номер/);

  const noLabel = await saveContact(db(), { houseKey: HOUSE, kind: 'other', phone: '123', ...by });
  assert.equal(noLabel.ok, false);
  if (!noLabel.ok) assert.equal(noLabel.reason, 'no_label');
});

test('своих номеров не больше пяти', { skip }, async () => {
  for (let i = 1; i <= 5; i++) {
    const r = await saveContact(db(), {
      houseKey: HOUSE, kind: 'other', label: `Служба ${i}`, phone: `20000${i}`, ...by,
    });
    assert.equal(r.ok, true);
  }
  const sixth = await saveContact(db(), {
    houseKey: HOUSE, kind: 'other', label: 'Шестая', phone: '2000006', ...by,
  });
  assert.equal(sixth.ok, false);
  if (!sixth.ok) assert.equal(sixth.reason, 'too_many');
});

test('порядок показа — как в справочнике, а не как вписали', { skip }, async () => {
  await saveContact(db(), { houseKey: HOUSE, kind: 'other', label: 'Бухгалтерия', phone: '111', ...by });
  await saveContact(db(), { houseKey: HOUSE, kind: 'intercom', phone: '222', ...by });
  await saveContact(db(), { houseKey: HOUSE, kind: 'lift', phone: '333', ...by });

  const kinds = (await listContacts(db(), HOUSE)).map((c) => c.kind);
  assert.deepEqual(kinds, ['lift', 'intercom', 'other']);
});

test('удаление убирает номер', { skip }, async () => {
  const saved = await saveContact(db(), { houseKey: HOUSE, kind: 'lift', phone: '333', ...by });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal((await findContact(db(), saved.id))?.houseKey, HOUSE);
  await removeContact(db(), saved.id);
  assert.equal(await findContact(db(), saved.id), null);
});

test('житель видит номера своего дома; без своего адреса — нет', { skip }, async () => {
  await saveContact(db(), { houseKey: HOUSE, kind: 'lift', phone: '333', ...by });

  const userId = newId('usr');
  await db().insert(appUser).values({ id: userId, fullName: 'Житель' });
  const propertyId = newId('prp');
  await db().insert(property).values({
    id: propertyId, houseKey: HOUSE, addressRaw: 'ул Тестовая, д 1, кв 1', flat: '1',
  });
  const bindingId = newId('ubd');
  await db().insert(userProperty).values({
    id: bindingId, userId, propertyId, role: 'member', status: 'pending', addressFromUser: false,
  });

  // Адрес поднят нами по номеру счёта — человеку он неизвестен, как и телефон УК
  assert.deepEqual(await contactsForResident(db(), userId, propertyId), []);

  await db().update(userProperty).set({ addressFromUser: true }).where(eq(userProperty.id, bindingId));
  const seen = await contactsForResident(db(), userId, propertyId);
  assert.equal(seen?.length, 1);
  assert.equal(seen?.[0].phone, '333');

  assert.equal(await contactsForResident(db(), newId('usr'), propertyId), null, 'чужой объект');
});
