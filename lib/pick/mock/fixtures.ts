import type { MockFile } from './format.ts';

/** Образец файла заглушки ЖК — ФИКСТУРА тестов, а не данные приложения */
export const SAMPLE: MockFile = {
  version: 1,
  region: '61',
  builtAt: '2026-09-23',
  complexes: [{
    slug: 'novyy-selmash',
    name: 'ЖК «Новый Сельмаш»',
    address: 'ул. Студенческая, 8',
    microdistrict: 'мкр. Сельмаш',
    district: 'Первомайский район',
    lat: 47.27, lon: 39.7,
    developer: 'ГК «Зодчий»',
    priceFrom: 4500000,
    grocery: true,
    blurb: 'Супермаркет на первом этаже одной из башен',
    tags: ['3 башни по 20 этажей', '15 минут до центра'],
    reviews: [{ name: 'Павел', flat: '415', stars: 5, plus: 'Близко к центру', minus: 'Ждать лифт' }],
    src: { name: 'web', address: 'web', coords: 'osm', developer: 'web', priceFrom: 'mock', reviews: 'mock' },
  }],
};
