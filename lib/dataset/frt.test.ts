import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  parseFrtRegions, parseFrtExports, matchFrtRegion, parseCsv, unzipFirst,
  frtHouses, frtOrgs, registryFormOf, type FrtOrg,
} from './frt.ts';

/** Фрагменты живой страницы аис.фрт.рф/opendata, 16.09.2026 */
const REGIONS_HTML = `
  <option value="2352709">Республика Северная Осетия-Алания</option>
  <option value="2353101">Республика Татарстан</option>
  <option value="2310204">Ростовская область</option>
  <option value="2281101">город Москва</option>
  <option value="2208163">Кемеровская область - Кузбасс</option>`;

const EXPORTS_HTML = `
  <div class="lh-27 f-28 fw-500 mt-48">Реестр домов по Ростовской области</div>
  <a href="/opendata/export/129">Экспорт</a>
  <div class="lh-27 f-28 fw-500 mt-48">Реестр управляющих организаций по Ростовской области</div>
  <a href="/opendata/export/44">Экспорт</a>`;

const HEADER = 'id;region_id;area_id;city_id;street_id;shortname_region;formalname_region;shortname_area;formalname_area;shortname_city;formalname_city;shortname_street;formalname_street;house_number;building;block;letter;address;houseguid;management_organization_id;built_year;exploitation_start_year;project_type;house_type;is_alarm;method_of_forming_overhaul_fund;floor_count_max;floor_count_min;entrance_count;elevators_count;energy_efficiency;quarters_count;living_quarters_count';

/** Строки живой выгрузки export-reestrmkd-61-20260901.csv, обрезанные по living_quarters_count */
const HOUSES_CSV = `﻿${HEADER}
8926596;f10763dc-63e3-48db-83e1-9c566fe3092b;;a216cad5-7027-40b8-b1a1-d64abefbd5cd;39af5484-6bba-42f1-8119-d3920613c270;обл.;Ростовская;;;г.;Азов;с-к;А.Невского;2;;;;"обл. Ростовская, г. Азов, с-к. А.Невского, д. 2";e8923b56-67b7-46ad-9f07-f27a96812eb5;7364182;1951;1951;-;"Многоквартирный дом";Нет;"Не заполнено";2;0;1;0;D;8;8
7374784;f10763dc-63e3-48db-83e1-9c566fe3092b;;a216cad5-7027-40b8-b1a1-d64abefbd5cd;deb31cd0-b437-4818-9490-c4b7b7dcfa61;обл.;Ростовская;;;г.;Азов;ул.;Дзержинского;47;;;;"обл. Ростовская, г. Азов, ул. Дзержинского, д. 47";573629b4-2163-4484-aaa6-d367c05a7b6f;;;;"индивидуальный проект";"Жилой дом блокированной застройки";Нет;"Не заполнено";1;;1;0;"Не заполнено";4;
6939026;;;;;;;;;;;;;"г Белая Калитва ул Энгельса д.40";;;;"д. г Белая Калитва ул Энгельса д.40";ea70561b-2a91-2e7b-bbe3-1fdef7a880a3;7375701;1979;1979;кирпичный;"Не заполнено";Нет;"На счете регионального оператора";9;9;1;1;"Не присвоен";54;54
`;

const ORGS_CSV = `﻿id;subject_rf;name_full;name_short;name_employee;inn;orn;legal_address;actual_address;phone;email;site;count_mkd;area_total;w_summ
8866701;"Ростовская область";"Некоммерческая организация товарищества собственников жилья ""Прогресс""";"Некоммерческая организация ТСЖ ""Прогресс""";"Людмила Викторовна Комлацкая";6102017830;1036102003618;"г. Аксай, ул. Мира, д. 2";"г. Аксай, ул. Мира, д. 2";+79286185189;b-tsg-progress@mail.ru;;1;3070,70;27,50
8778265;"Ростовская область";"Общество с органиченной ответственностью Управляющая компания ""Стадионный""";"OOO УК ""Стадионный""";"Роман Александрович Насонов";6141045453;1146181000460;"г. Батайск, пер. Стадионный, д. 25";"г. Батайск, пер. Стадионный, д. 25";"(988)568-22-77, (918)521-72-72";stadionnii@mail.ru;www.refotmagkh.ru;2;13560,80;32,00
`;

test('регионы и выгрузки находятся на страницах открытых данных', () => {
  const regions = parseFrtRegions(REGIONS_HTML);
  assert.deepEqual(regions[2], { gid: '2310204', name: 'Ростовская область' });
  assert.deepEqual(parseFrtExports(EXPORTS_HTML), [
    { id: '129', title: 'Реестр домов по Ростовской области' },
    { id: '44', title: 'Реестр управляющих организаций по Ростовской области' },
  ]);
});

test('имя субъекта из ГАР сопоставляется с именем ФРТ', () => {
  const regions = parseFrtRegions(REGIONS_HTML);
  assert.equal(matchFrtRegion(regions, 'обл. Ростовская')?.gid, '2310204');
  assert.equal(matchFrtRegion(regions, 'Респ. Татарстан')?.gid, '2353101');
  assert.equal(matchFrtRegion(regions, 'г. Москва')?.gid, '2281101');
  assert.equal(matchFrtRegion(regions, 'обл. Кемеровская область - Кузбасс')?.gid, '2208163');
  assert.equal(matchFrtRegion(regions, 'обл. Выдуманная'), null);
});

test('CSV: точка с запятой, кавычки, удвоенные кавычки и перевод строки внутри поля', () => {
  assert.deepEqual(parseCsv('a;"b;c";"d ""e"""\n"f\ng";h\n'), [['a', 'b;c', 'd "e"'], ['f\ng', 'h']]);
});

test('дома ФРТ: GUID, тип, организация и квартиры', () => {
  const houses = frtHouses(HOUSES_CSV);
  assert.equal(houses.length, 3);
  assert.deepEqual(houses[0], {
    frtId: '8926596', fiasGuid: 'e8923b56-67b7-46ad-9f07-f27a96812eb5',
    address: 'обл. Ростовская, г. Азов, с-к. А.Невского, д. 2',
    place: 'Азов', street: 'с-к А.Невского', number: '2', orgFrtId: '7364182',
    kind: 'mkd', flats: 8, floors: 2, builtYear: 1951,
    entrances: 1, elevators: 0, wallMaterial: null, gas: null, emergency: false,
  });
  assert.equal(houses[1].kind, 'blocked');
  assert.equal(houses[1].orgFrtId, null);
  assert.equal(houses[1].flats, null, 'пустое поле — не ноль');
  assert.equal(houses[2].kind, null, '«Не заполнено» — тип неизвестен');
});

test('литера через дефис или пробел прилипает к номеру, как в ГАР', () => {
  const csv = HOUSES_CSV.replace(';А.Невского;2;;;;', ';А.Невского;81-Б;;;;').replace(';Дзержинского;47;;;;', ';Дзержинского;81 а;;;;');
  const [a, b] = frtHouses(csv);
  assert.equal(a.number, '81Б');
  assert.equal(b.number, '81а');
});

test('организации ФРТ: ИНН, ОГРН, контакты; пустой сайт — null', () => {
  const orgs = frtOrgs(ORGS_CSV);
  assert.deepEqual(orgs[0], {
    frtId: '8866701', inn: '6102017830', ogrn: '1036102003618',
    name: 'Некоммерческая организация товарищества собственников жилья "Прогресс"',
    shortName: 'Некоммерческая организация ТСЖ "Прогресс"',
    phone: '+79286185189', email: 'b-tsg-progress@mail.ru', site: null,
  });
  assert.equal(orgs[1].site, 'www.refotmagkh.ru');
});

test('способ управления: лицензия, товарищество, кооператив, общество, блокированная застройка', () => {
  const [tsj, ooo] = frtOrgs(ORGS_CSV);
  const org = (name: string): FrtOrg => ({ ...tsj, name, shortName: name });

  assert.equal(registryFormOf(tsj, false, 'mkd'), 'tsj');
  assert.equal(registryFormOf(ooo, false, 'mkd'), 'uk', 'латинские OOO в названии тоже общество');
  assert.equal(registryFormOf(tsj, true, 'mkd'), 'uk', 'лицензия сильнее названия');
  assert.equal(registryFormOf(org('ЖСК "Темп"'), false, 'mkd'), 'zhsk');
  assert.equal(registryFormOf(org('Жилищный кооператив № 5'), false, 'mkd'), 'zhsk');
  assert.equal(registryFormOf(org('ТСН "ТСЖ Антарес"'), false, 'mkd'), 'tsj');
  assert.equal(registryFormOf(org('МП "УК-ЖИЛСЕРВИС"'), false, 'mkd'), 'uk', 'муниципальное предприятие управляет по договору');
  assert.equal(registryFormOf(org('Администрация поселения'), false, 'mkd'), 'unknown');
  assert.equal(registryFormOf(null, false, 'blocked'), 'private');
  assert.equal(registryFormOf(null, false, 'mkd'), 'unknown');
});

test('первый файл zip распаковывается в текст без BOM', async () => {
  const name = Buffer.from('export.csv');
  const data = deflateRawSync(Buffer.from('﻿id;inn\n1;2\n'));
  const raw = Buffer.from('﻿id;inn\n1;2\n');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);

  const cdOffset = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  const zip = Buffer.concat([local, name, data, central, name, eocd]);
  assert.equal(await unzipFirst(zip), 'id;inn\n1;2\n');
});

test('паспорт дома: стены, газ и аварийность из колонок фонда', () => {
  const header = `${HEADER};wall_material;gas_type`;
  const csv = `${header}
1;;;;;;;;;;Азов;ул.;Мира;1;;;;"г. Азов, ул. Мира, д. 1";aaaaaaaa-0000-0000-0000-000000000001;;1970;;;"Многоквартирный дом";Да;;5;5;4;2;;60;60;Панельные;Центральное
2;;;;;;;;;;Азов;ул.;Мира;2;;;;"г. Азов, ул. Мира, д. 2";aaaaaaaa-0000-0000-0000-000000000002;;1970;;;"Многоквартирный дом";Нет;;5;5;4;0;;60;60;"Не заполнено";Отсутствует
`;
  const [a, b] = frtHouses(csv);
  assert.equal(a.wallMaterial, 'Панельные');
  assert.equal(a.gas, true, 'центральное газоснабжение — газ есть');
  assert.equal(a.emergency, true);
  assert.equal(a.entrances, 4);
  assert.equal(a.elevators, 2);
  assert.equal(b.wallMaterial, null, '«Не заполнено» — пусто, а не текст');
  assert.equal(b.gas, false, '«Отсутствует» — газа нет');
  assert.equal(b.emergency, false);
});
