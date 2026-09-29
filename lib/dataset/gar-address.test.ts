import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress } from '../address/normalize.ts';
import { garHouseAddress } from './gar-address.ts';
import type { GarHouse, GarObject } from './gar.ts';

let nextId = 1;
const obj = (level: number, type: string, name: string): GarObject =>
  ({ objectId: nextId++, guid: `g${nextId}`, level, type, name });

const house = (num: string, extra: Partial<GarHouse> = {}): GarHouse => ({
  objectId: nextId++, guid: `h${nextId}`, num, houseType: 2,
  add1: null, addType1: null, add2: null, addType2: null, ...extra,
});

const region = obj(1, 'обл.', 'Ростовская');

/**
 * Ожидания — живые `formattedAddress` портала ГИС ЖКХ без индекса.
 * Нынешние дома реестра записаны именно так, и ключи квартир, уже
 * привязанных к ним, обязаны сохраниться.
 */
const cases: { title: string; chain: GarObject[]; house: GarHouse; portal: string }[] = [
  {
    title: 'посёлок в районе',
    chain: [region, obj(2, 'р-н', 'Аксайский'), obj(6, 'п.', 'Ковалевка'), obj(8, 'ул.', 'Центральная')],
    house: house('2'),
    portal: '346709, обл Ростовская, р-н Аксайский, п Ковалевка, ул Центральная, д. 2',
  },
  {
    title: 'город в районе, корпус',
    chain: [region, obj(2, 'р-н', 'Аксайский'), obj(5, 'г.', 'Аксай'), obj(8, 'ул', 'Объездная')],
    house: house('7', { add1: '1', addType1: 1 }),
    portal: '346720, обл Ростовская, р-н Аксайский, г Аксай, ул Объездная, д. 7, к. 1',
  },
  {
    title: 'областной город, дробь',
    chain: [region, obj(5, 'г.', 'Ростов-на-Дону'), obj(8, 'ул.', 'Большая Садовая')],
    house: house('5/12'),
    portal: '344082, обл Ростовская, г Ростов-на-Дону, ул Большая Садовая, д. 5/12',
  },
  {
    title: 'переулок',
    chain: [region, obj(5, 'г.', 'Волгодонск'), obj(8, 'пер.', 'Зеленый')],
    house: house('1'),
    portal: '347375, обл Ростовская, г Волгодонск, пер Зеленый, д. 1',
  },
];

for (const c of cases) {
  test(`адрес дома из ГАР даёт тот же ключ, что и адрес портала: ${c.title}`, () => {
    const built = garHouseAddress(c.chain, c.house);
    assert.equal(built, c.portal.replace(/^\d{6}, /, ''));
    assert.equal(parseAddress(built).houseKey, parseAddress(c.portal).houseKey);
    assert.ok(parseAddress(built).houseKey, 'ключ не пустой');
  });
}

test('строение пишется «стр.», муниципальные уровни пропускаются', () => {
  const built = garHouseAddress(
    [region, obj(3, 'м.р-н', 'Аксайский'), obj(4, 'г.п.', 'Аксайское'), obj(5, 'г.', 'Аксай'), obj(8, 'ул', 'Мира')],
    house('3', { add1: '2', addType1: 2 }),
  );
  assert.equal(built, 'обл Ростовская, г Аксай, ул Мира, д. 3, стр. 2');
});

test('садовое товарищество сохраняет точку внутри типа', () => {
  const built = garHouseAddress(
    [region, obj(2, 'р-н', 'Аксайский'), obj(7, 'тер. СНТ', 'Мечта'), obj(8, 'ул.', 'Садовая')],
    house('14'),
  );
  assert.equal(built, 'обл Ростовская, р-н Аксайский, тер. СНТ Мечта, ул Садовая, д. 14');
});
