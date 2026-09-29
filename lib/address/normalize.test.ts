import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, parseHouseNumber, shortAddress, looseHouseKey } from './normalize.ts';

const REAL = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3, кв. 27';

test('реальный адрес с квитанции разбирается по частям', () => {
  const a = parseAddress(REAL);
  assert.equal(a.postalCode, '344038');
  assert.equal(a.region, 'ростовская область');
  assert.equal(a.city, 'ростов-на-дону');
  assert.equal(a.street, 'проспект ленина');
  assert.equal(a.house, '85');
  assert.equal(a.block, '3');
  assert.equal(a.flat, '27');
});

test('квартира НЕ входит в ключ дома — иначе соседей не будет', () => {
  const flat27 = parseAddress(REAL);
  const flat54 = parseAddress(REAL.replace('кв. 27', 'кв. 54'));

  assert.equal(flat27.houseKey, flat54.houseKey, 'соседи должны попасть в один дом');
  assert.notEqual(flat27.flat, flat54.flat);
});

test('разные записи одного дома дают один ключ', () => {
  const variants = [
    '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3, кв. 27',
    'Ростовская область, город Ростов-на-Дону, проспект Ленина, дом 85, корпус 3, кв 27',
    '344038, Ростовская обл., г. Ростов-на-Дону, просп. Ленина, д 85, корп. 3, квартира 27',
  ];

  const keys = variants.map((v) => parseAddress(v).houseKey);
  assert.equal(new Set(keys).size, 1, `ожидали один ключ, получили: ${JSON.stringify(keys)}`);
});

test('тип улицы распознаётся и до, и после названия', () => {
  const before = parseAddress('г Москва, ул Тверская, д 1');
  const after = parseAddress('г Москва, Тверская ул, д 1');
  assert.equal(before.street, 'улица тверская');
  assert.equal(after.street, 'улица тверская');
  assert.equal(before.houseKey, after.houseKey);
});

test('соседние дома разводятся по разным ключам', () => {
  const h85 = parseAddress('г Ростов-на-Дону, пр-кт Ленина, д 85');
  const h87 = parseAddress('г Ростов-на-Дону, пр-кт Ленина, д 87');
  assert.notEqual(h85.houseKey, h87.houseKey);
});

test('корпус разводит дома', () => {
  const k3 = parseAddress('г Ростов-на-Дону, пр-кт Ленина, д 85, к 3');
  const k4 = parseAddress('г Ростов-на-Дону, пр-кт Ленина, д 85, к 4');
  const noBlock = parseAddress('г Ростов-на-Дону, пр-кт Ленина, д 85');
  assert.notEqual(k3.houseKey, k4.houseKey);
  assert.notEqual(k3.houseKey, noBlock.houseKey);
});

test('регистр и лишние пробелы не разводят соседей', () => {
  const a = parseAddress('г РОСТОВ-НА-ДОНУ,   ПР-КТ ЛЕНИНА,  д 85А');
  const b = parseAddress('г ростов-на-дону, пр-кт ленина, д 85а');
  assert.equal(a.houseKey, b.houseKey);
  assert.equal(a.house, '85а');
});

test('«д Иваново» — деревня, а не дом', () => {
  const a = parseAddress('Московская обл, д Иваново, ул Полевая, д 5');
  assert.equal(a.house, '5', 'домом должен стать 5, а не «Иваново»');
  assert.match(a.canonical, /иваново/);
});

test('строение отличается от корпуса', () => {
  const k = parseAddress('г Москва, ул Тверская, д 1, к 2');
  const s = parseAddress('г Москва, ул Тверская, д 1, стр 2');
  assert.equal(k.block, '2');
  assert.equal(s.building, '2');
  assert.notEqual(k.houseKey, s.houseKey);
});

test('офис и помещение считаются как квартира и не влияют на дом', () => {
  const flat = parseAddress('г Москва, ул Тверская, д 1, кв 5');
  const office = parseAddress('г Москва, ул Тверская, д 1, оф 5');
  assert.equal(office.flat, '5');
  assert.equal(flat.houseKey, office.houseKey);
});

test('дом без префикса тоже находится', () => {
  const a = parseAddress('г Москва, ул Тверская, 12');
  assert.equal(a.house, '12');
});

test('короткая подпись для интерфейса', () => {
  assert.equal(shortAddress(parseAddress(REAL)), 'Проспект Ленина 85к3, кв. 27');
  assert.equal(
    shortAddress(parseAddress('г Москва, ул Заречная, д 24, кв 15')),
    'Улица Заречная 24, кв. 15',
  );
});

test('пустой адрес не роняет разбор', () => {
  const a = parseAddress('');
  assert.equal(a.houseKey, '');
  assert.equal(a.house, null);
});

test('порядок альтернатив в регулярках: «корп» не режется до «к»', () => {
  for (const v of ['к 3', 'к. 3', 'кор 3', 'корп. 3', 'корпус 3', 'к3']) {
    const a = parseAddress(`г Москва, ул Тверская, д 1, ${v}`);
    assert.equal(a.block, '3', `не разобрался вариант «${v}»`);
  }
  for (const v of ['д 85', 'д. 85', 'дом 85', 'д85']) {
    const a = parseAddress(`г Москва, ул Тверская, ${v}`);
    assert.equal(a.house, '85', `не разобрался вариант «${v}»`);
  }
  for (const v of ['кв 27', 'кв. 27', 'квартира 27', 'кв27']) {
    const a = parseAddress(`г Москва, ул Тверская, д 1, ${v}`);
    assert.equal(a.flat, '27', `не разобрался вариант «${v}»`);
  }
});

test('«кв-л» — это квартал, а не квартира', () => {
  const a = parseAddress('г Москва, кв-л Северный, д 5');
  assert.equal(a.flat, null);
  assert.equal(a.street, 'квартал северный');
});

/* ─────────────── номера домов во всех формах ─────────────── */

/**
 * Формы взяты из КЛАДР, а не придуманы: на 34 миллионах номеров это
 * 70% просто цифры, 8% цифра с буквой, 5% со строением, 3% дробь,
 * остальное — владения, литеры и их сочетания.
 */
const address = (tail: string) => `346780, Ростовская обл, г Азов, ул Мира, ${tail}`;

test('одинаковый дом, записанный по-разному, даёт один ключ', () => {
  const same: [string, string, string][] = [
    ['латиница вместо кириллицы', 'д. 15A', 'д. 15А'],
    ['пробел перед буквой', 'д. 15 А', 'д. 15А'],
    ['корпус слитно и отдельно', 'д. 12к1', 'д. 12, к. 1'],
    ['корпус словом', 'д. 12 корпус 1', 'д. 12, к. 1'],
    ['дробь и корпус', 'д. 4/1', 'д. 4, к. 1'],
    ['дробь и корпус с буквой', 'д. 4Б/1', 'д. 4Б, к. 1'],
    ['дробь и корпус, живой дом', 'д. 85/3', 'д. 85, к. 3'],
    ['строение слитно и отдельно', 'д. 8А стр 54', 'д. 8А, стр. 54'],
    ['с префиксом «д.» и без', 'д. 15', '15'],
    ['разный регистр', 'д. 15б', 'д. 15Б'],
  ];

  for (const [label, left, right] of same) {
    assert.equal(
      parseAddress(address(left)).houseKey,
      parseAddress(address(right)).houseKey,
      `${label}: «${left}» и «${right}» — один дом`,
    );
  }
});

/**
 * Ключ без региона: квитанции его часто не печатают.
 *
 * Живой случай — квитанция начинается сразу с города:
 * «г Ростов-на-Дону, пр-кт Ленина, д.85 корп. 3, кв.27». Реестр ГИС ЖКХ
 * тот же дом пишет с регионом. Строгий ключ у них разный, и дом
 * не находился: житель оставался без управляющей компании, а в кабинете
 * компании не было жителя.
 *
 * Обратное тоже бывает: часть адресов САМОГО реестра региона не содержит
 * («346780, г Азов, ул Мира»).
 */
test('ключ без региона сводит квитанцию и реестр', () => {
  const receipt = 'г Ростов-на-Дону, пр-кт Ленина, д.85 корп. 3, кв.27';
  const registry = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3';

  assert.notEqual(
    parseAddress(receipt).houseKey,
    parseAddress(registry).houseKey,
    'строгие ключи разные: в квитанции региона нет',
  );

  assert.equal(
    looseHouseKey(receipt),
    looseHouseKey(registry),
    'без региона — один и тот же дом',
  );
});

test('ключ без региона не сливает разные дома', () => {
  const base = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, ';

  assert.notEqual(looseHouseKey(base + 'д. 85, к. 3'), looseHouseKey(base + 'д. 85, к. 4'));
  assert.notEqual(looseHouseKey(base + 'д. 85'), looseHouseKey(base + 'д. 86'));
  assert.notEqual(
    looseHouseKey(base + 'д. 85'),
    looseHouseKey('344038, обл Ростовская, г Ростов-на-Дону, ул Мира, д. 85'),
  );
  assert.notEqual(
    looseHouseKey(base + 'д. 85'),
    looseHouseKey('346780, обл Ростовская, г Азов, пр-кт Ленина, д. 85'),
    'разные города остаются разными',
  );
});

test('разные дома не слипаются в один', () => {
  const different: [string, string, string][] = [
    ['владение и дом', 'влд 33', 'д. 33'],
    ['домовладение и дом', 'двлд 4', 'д. 4'],
    ['литера А и литера Б', 'д. 12, литера А', 'д. 12, литера Б'],
    ['корпус и строение', 'д. 12, к. 1', 'д. 12, стр. 1'],
    ['буква и без буквы', 'д. 15А', 'д. 15'],
    ['разные дроби', 'д. 4/1', 'д. 4/2'],
  ];

  for (const [label, left, right] of different) {
    assert.notEqual(
      parseAddress(address(left)).houseKey,
      parseAddress(address(right)).houseKey,
      `${label}: «${left}» и «${right}» — разные дома`,
    );
  }
});

test('номер дома разбирается на части', () => {
  assert.deepEqual(parseHouseNumber('15'), {
    number: '15', letter: null, block: null, building: null, kind: null,
  });
  assert.deepEqual(parseHouseNumber('8Астр54'), {
    number: '8а', letter: null, block: null, building: '54', kind: null,
  });
  assert.deepEqual(parseHouseNumber('39к1'), {
    number: '39', letter: null, block: '1', building: null, kind: null,
  });
  assert.deepEqual(parseHouseNumber('влд33'), {
    number: '33', letter: null, block: null, building: null, kind: 'влд',
  });
  assert.deepEqual(parseHouseNumber('41/1литер1'), {
    number: '41', letter: '1', block: '1', building: null, kind: null,
  });

  /**
   * Дробь — это корпус.
   *
   * Проверено на четырёх живых квитанциях одной квартиры: в двух дом
   * напечатан через дробь, в двух через корпус. Пока написания считались
   * разными домами, один человек с четырьмя квитанциями оказывался
   * жильцом двух разных домов, а соседи — в двух разных лентах.
   */
  assert.deepEqual(parseHouseNumber('4Б/1'), {
    number: '4б', letter: null, block: '1', building: null, kind: null,
  });
  assert.deepEqual(parseHouseNumber('24/1А'), {
    number: '24', letter: null, block: '1а', building: null, kind: null,
  });
  assert.deepEqual(parseHouseNumber('85/3'), {
    number: '85', letter: null, block: '3', building: null, kind: null,
  });
});

test('частный дом без квартиры разбирается целиком', () => {
  const parsed = parseAddress('346780, Ростовская обл, х Красный, ул Садовая, д. 15А');

  assert.equal(parsed.house, '15а');
  assert.equal(parsed.flat, null, 'у частного дома квартиры нет');
  assert.ok(parsed.houseKey, 'но ключ дома обязан быть');
});

/* ─────────────── разломы, найденные аудитом 25 августа ─────────────── */

/**
 * Номер дома, который не разобрался, обязан ОТМЕНЯТЬ ключ, а не выпадать
 * из него.
 *
 * Условие построения ключа было `city || street || house`, поэтому «д. abc»
 * давало непустой ключ, посчитанный из города и улицы. Предохранитель
 * `if (!address.houseKey) return null` в привязке не срабатывал — ключ-то
 * есть, — и вся улица становилась одним домом: квартиры с одинаковым
 * номером сливались в один объект с общими начислениями и общим владельцем.
 */
test('дом без цифр не даёт ключа вовсе', () => {
  for (const bad of ['д. abc', 'д. -', 'д. —', 'дом', 'д. .']) {
    const parsed = parseAddress(`г Азов, ул Мира, ${bad}, кв. 5`);
    assert.equal(parsed.houseKey, '', `«${bad}» не должен давать ключ дома`);
  }

  assert.notEqual(
    parseAddress('г Азов, ул Мира, д. 1, кв. 5').houseKey,
    '',
    'нормальный дом ключ по-прежнему получает',
  );
});

/**
 * «Ё» и «е» — один дом.
 *
 * Ключ считался с сохранением «ё», а расчётные центры печатают букву
 * как придётся. Соседи расходились по двум лентам одного дома, а дом
 * не находился в реестре. Тот же симптом, что был с регионом.
 */
test('«ё» и «е» в названии улицы дают один дом', () => {
  const withYo = parseAddress('г Ростов-на-Дону, ул Щёлковская, д. 5, кв. 1');
  const withE = parseAddress('г Ростов-на-Дону, ул Щелковская, д. 5, кв. 1');

  assert.equal(withYo.houseKey, withE.houseKey);
  assert.equal(withYo.street, 'улица щелковская');
});

/**
 * Район субъекта — отдельное поле, а не улица.
 *
 * Пока его не было, «р-н Ворошиловский» не подходил ни под один шаблон
 * и падал в последнюю ветку разбора, где становился улицей. Настоящая
 * улица следом просто терялась, и все дома с одним номером в районе
 * получали одинаковый ключ.
 */
test('район не занимает место улицы', () => {
  const parsed = parseAddress('г Ростов-на-Дону, р-н Ворошиловский, ул Королёва, д. 10, кв. 1');

  assert.equal(parsed.district, 'ворошиловский');
  assert.equal(parsed.street, 'улица королева', 'улица не должна теряться');
  assert.equal(parsed.house, '10');
});

test('разные улицы одного района — разные дома', () => {
  const first = 'г Ростов-на-Дону, р-н Ворошиловский, ул Королёва, д. 10';
  const second = 'г Ростов-на-Дону, р-н Ворошиловский, ул Добровольского, д. 10';

  assert.notEqual(parseAddress(first).houseKey, parseAddress(second).houseKey);
});

/**
 * Реестр ГИС ЖКХ по сельским адресам печатает район, квитанция — нет.
 * Строгие ключи у них разные по построению, сойтись они обязаны запасным.
 */
test('дом с районом в реестре находится по квитанции без района', () => {
  const registry = 'обл Ростовская, р-н Аксайский, ст-ца Старочеркасская, ул Советская, д. 1';
  const receipt = 'Ростовская обл, ст-ца Старочеркасская, ул Советская, д. 1';

  const parsedRegistry = parseAddress(registry);
  assert.equal(parsedRegistry.city, 'старочеркасская', 'станица — населённый пункт, а не улица');
  assert.equal(parsedRegistry.street, 'улица советская');

  assert.equal(looseHouseKey(registry), looseHouseKey(receipt));
});

/**
 * Микрорайон уступает настоящей улице.
 *
 * «мкр Солнечный, д. 5» — микрорайон и есть адрес. «мкр Солнечный,
 * ул Мира, д. 5» — адрес задаёт улица. Пока побеждал первый подошедший
 * сегмент, улицей становился микрорайон, и дома с одним номером внутри
 * него сливались в один.
 */
test('микрорайон уступает улице, но не пропадает', () => {
  const parsed = parseAddress('г Азов, мкр Солнечный, ул Мира, д. 1, кв. 5');

  assert.equal(parsed.street, 'улица мира');
  assert.equal(parsed.subplace, 'микрорайон солнечный');
});

test('разные улицы одного микрорайона — разные дома', () => {
  assert.notEqual(
    parseAddress('г Азов, мкр Солнечный, ул Мира, д. 1').houseKey,
    parseAddress('г Азов, мкр Солнечный, ул Ленина, д. 1').houseKey,
  );
});

test('микрорайон без улицы остаётся адресным элементом', () => {
  const parsed = parseAddress('г Азов, мкр Солнечный, д. 5');

  assert.equal(parsed.street, 'микрорайон солнечный');
  assert.equal(parsed.subplace, null);
  assert.notEqual(parsed.houseKey, '');
});

/** Микрорайон различает дома: «мкр Солнечный, д. 5» и «ул Мира, д. 5» — разное. */
test('микрорайон входит в строгий ключ', () => {
  assert.notEqual(
    parseAddress('г Азов, мкр Солнечный, ул Мира, д. 1').houseKey,
    parseAddress('г Азов, ул Мира, д. 1').houseKey,
  );
});
