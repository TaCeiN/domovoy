import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAddress, listingLinks } from './links.ts';

test('адрес для поиска объявлений: без области и района, без «г» и «д.»', () => {
  assert.equal(
    searchAddress('обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3'),
    'Ростов-на-Дону, пр-кт Ленина, 85, к. 3',
  );
  assert.equal(searchAddress('обл Ростовская, р-н Аксайский, х Черюмкин, д. 7'), 'х Черюмкин, 7');
});

test('четыре площадки, все по https, у Авито адрес в запросе', () => {
  const links = listingLinks('обл Ростовская, г Аксай, ул Мира, д. 1');
  assert.deepEqual(links.map((l) => l.site), ['avito', 'cian', 'domclick', 'yandex']);
  for (const l of links) assert.match(l.url, /^https:\/\//);
  assert.ok(links[0].url.includes(encodeURIComponent('Аксай, ул Мира, 1')));
});
