import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDanger, dangerReply } from './emergency.ts';

/**
 * Опасность ловит код, а не модель: «пахнет газом в подъезде» маленькая
 * модель может принять за жалобу на запах, а цена такой ошибки — авария.
 */

test('опасные сообщения узнаются в живой речи', () => {
  assert.equal(detectDanger('пахнет газом в подъезде'), 'gas');
  assert.equal(detectDanger('Газом воняет на 3 этаже!!'), 'gas');
  assert.equal(detectDanger('утечка газа'), 'gas');
  assert.equal(detectDanger('в щитке искрит'), 'electric');
  assert.equal(detectDanger('розетка искрит у меня'), 'electric');
  assert.equal(detectDanger('бьёт током кран'), 'electric');
  assert.equal(detectDanger('пожар в подвале'), 'fire');
  assert.equal(detectDanger('дым из мусоропровода'), 'fire');
  assert.equal(detectDanger('нас топят сверху, вода льётся с потолка'), 'flood');
  assert.equal(detectDanger('прорвало трубу хлещет'), 'flood');
  assert.equal(detectDanger('застряли в лифте с ребенком'), 'lift');
  assert.equal(detectDanger('лифт застрял между этажами, внутри люди'), 'lift');
});

test('обычные жалобы опасными не считаются', () => {
  assert.equal(detectDanger('схуяли нет воды уже 15 дней'), null);
  assert.equal(detectDanger('нет горячей воды'), null);
  assert.equal(detectDanger('сколько платить за газ в этом месяце'), null);
  assert.equal(detectDanger('лифт не работает третий день'), null);
  assert.equal(detectDanger('не горит лампочка в подъезде'), null);
  assert.equal(detectDanger('счётчик газа как передать'), null);
});

test('ответ: сначала 112, у газа 104, телефоны дома своей службы', () => {
  const gas = dangerReply('gas', [{ kind: 'lift', title: 'Лифтёрская служба', phone: '200-00-01' }]);
  assert.match(gas, /^.*112/);
  assert.match(gas, /104/);
  assert.doesNotMatch(gas, /Лифтёрская/, 'при газе лифтёрская не нужна');

  const lift = dangerReply('lift', [
    { kind: 'lift', title: 'Лифтёрская служба', phone: '200-00-01' },
    { kind: 'intercom', title: 'Домофон', phone: '200-00-02' },
  ]);
  assert.match(lift, /Лифтёрская служба: 200-00-01/);
  assert.doesNotMatch(lift, /Домофон/);
});

test('человеку плохо — скорая, без модели', () => {
  for (const text of ['человеку плохо в подъезде', 'бабушка упала и не встает', 'сосед без сознания', 'ребенок не дышит', 'у мамы инсульт кажется'])
    assert.equal(detectDanger(text), 'medical', text);
  assert.match(dangerReply('medical', []), /103/);
  assert.match(dangerReply('medical', []), /112/);
  assert.equal(detectDanger('плохо убирают подъезд'), null);
});

test('драка, ломятся в дверь, угрозы — 112 и полиция', () => {
  for (const text of ['в подъезде драка', 'кто-то ломится в дверь', 'сосед угрожает ножом', 'напали на лестнице', 'грабят квартиру'])
    assert.equal(detectDanger(text), 'violence', text);
  assert.match(dangerReply('violence', []), /102/);
  assert.match(dangerReply('violence', []), /112/);
  assert.equal(detectDanger('бьёт током выключатель'), 'electric');
});
