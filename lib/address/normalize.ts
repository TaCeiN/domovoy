import { createHash } from 'node:crypto';

/**
 * Нормализация адреса из payerAddress и вычисление ключа дома.
 *
 * ЗАЧЕМ. Соседи, объявления дома и опросы работают только если система
 * понимает, что два человека живут в одном доме. Адрес в QR не формализован:
 * каждая УК печатает его по-своему — «пр-кт Ленина» и «проспект Ленина»,
 * «д. 85» и «дом 85», «к. 3» и «корп 3». Без приведения к канону соседи
 * окажутся в разных домах, и половина функций умрёт молча.
 *
 * ЭТО САМОЕ ВЕРОЯТНОЕ МЕСТО ПОЛОМКИ. Тесты нужны на живых квитанциях
 * пилотного дома, а не на придуманных строках.
 */

export interface ParsedAddress {
  postalCode: string | null;
  region: string | null;
  /**
   * Район субъекта: «р-н Аксайский».
   *
   * Отдельное поле, а не часть улицы. Пока его не было, сегмент
   * не подходил ни под один шаблон и падал в последнюю ветку разбора,
   * где становился УЛИЦЕЙ, — а настоящая улица, идущая следом, молча
   * терялась. Последствий было два, и оба тяжёлые: дома на разных улицах
   * одного района получали одинаковый ключ, а реестровый адрес
   * «обл Ростовская, р-н Аксайский, ст-ца Старочеркасская, ул Советская»
   * разбирался со сдвигом на поле — район уезжал в город, станица
   * в улицу — и с квитанцией не сходился никогда.
   */
  district: string | null;
  city: string | null;
  /**
   * Микрорайон или квартал, когда следом идёт настоящая улица.
   *
   * «г Азов, мкр Солнечный, ул Мира, д. 1»: адресный элемент здесь —
   * улица Мира, а микрорайон уточняет её расположение. Пока побеждал
   * первый подошедший сегмент, улицей становился микрорайон, и все
   * дома с одинаковым номером внутри него сливались в один.
   */
  subplace: string | null;
  street: string | null;
  house: string | null;
  block: string | null;
  building: string | null;
  flat: string | null;
  /** Канонический адрес дома без квартиры — основа houseKey */
  canonical: string;
  /** Стабильный ключ дома: одинаков у всех жильцов одного подъездного адреса */
  houseKey: string;
  raw: string;
}

/**
 * Нижний регистр и «ё» к «е» — одной функцией на весь разбор.
 *
 * ЗАЧЕМ «Ё». Ключ дома считался с сохранением «ё», и «ул Щёлковская»
 * с «ул Щелковская» давали РАЗНЫЕ ключи. Соседи расходились по двум
 * лентам одного дома, а дом не находился в реестре — в зависимости от
 * того, как букву напечатал расчётный центр. Ровно тот же симптом,
 * что был с регионом, и та же цена.
 *
 * В файле уже была `searchName` с этой нормализацией и с объяснением,
 * зачем она нужна, — но применялась только к поиску улиц в справочнике,
 * а не к вычислению ключа.
 */
function lower(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

/** Тип улицы: сокращение → канон */
const STREET_TYPES: Record<string, string> = {
  'ул': 'улица', 'улица': 'улица', 'ул-ца': 'улица',
  'пр-кт': 'проспект', 'пр-т': 'проспект', 'просп': 'проспект',
  'пр': 'проспект', 'проспект': 'проспект',
  'пер': 'переулок', 'переулок': 'переулок',
  'б-р': 'бульвар', 'бул': 'бульвар', 'бульвар': 'бульвар',
  'ш': 'шоссе', 'шос': 'шоссе', 'шоссе': 'шоссе',
  'наб': 'набережная', 'набережная': 'набережная',
  'пл': 'площадь', 'площадь': 'площадь',
  'туп': 'тупик', 'тупик': 'тупик',
  'проезд': 'проезд', 'пр-д': 'проезд',
  'аллея': 'аллея', 'ал': 'аллея',
  'линия': 'линия',
  'мкр': 'микрорайон', 'мкрн': 'микрорайон', 'микрорайон': 'микрорайон',
  'кв-л': 'квартал', 'квартал': 'квартал',
  'тракт': 'тракт',
  'въезд': 'въезд',
};

/**
 * Типы, которые обозначают НЕ улицу, а часть населённого пункта.
 *
 * «мкр Солнечный, д. 5» — это адрес: микрорайон здесь единственный
 * адресный элемент. «мкр Солнечный, ул Мира, д. 5» — уже нет: адрес
 * задаёт улица, а микрорайон её уточняет. Отличить можно только тем,
 * есть ли рядом настоящая улица, поэтому эти типы помечены отдельно
 * и уступают ей, если она нашлась.
 */
const PLACE_LIKE_STREET_TYPES = new Set(['микрорайон', 'квартал']);

/** Тип района субъекта. Разбираем по токенам — граница слова \b на кириллице не работает. */
const DISTRICT_TYPES = new Set(['р-н', 'рн', 'район', 'района']);

/** Тип населённого пункта */
const CITY_TYPES = new Set([
  'г', 'гор', 'город', 'пгт', 'рп', 'п', 'пос', 'посёлок', 'поселок',
  'с', 'село', 'ст-ца', 'станица', 'х', 'хутор', 'д', 'деревня', 'аул',
]);

/**
 * Маркеры региона. Разбираем по токенам, а не регуляркой с \b:
 * в JS граница слова опирается на ASCII, поэтому «\bобл\b» с кириллицей
 * не срабатывает никогда. Из-за этого регион не опознавался, «Ростовская обл»
 * уезжала в город, город — в улицу, и адрес разъезжался целиком.
 */
const REGION_TYPES = new Set([
  'обл', 'область', 'край', 'края', 'респ', 'республика', 'ао', 'округ',
]);

function looksLikeRegion(tokens: string[]): boolean {
  return tokens.some((t) => REGION_TYPES.has(t) || t.startsWith('автономн'));
}

/**
 * Канон региона: сначала название, потом тип.
 *
 * Порядок слов в источниках разный. Квитанция печатает «Ростовская обл»,
 * реестр ГИС ЖКХ — «обл Ростовская», а в справочниках встречается и
 * «Ростовская область». Пока порядок сохранялся как есть, один и тот же
 * дом получал разные ключи, и связка «дом из реестра ↔ дом из квитанции»
 * не срабатывала вовсе.
 */
const REGION_KIND_CANON: Record<string, string> = {
  'обл': 'область', 'область': 'область',
  'респ': 'республика', 'республика': 'республика',
  'край': 'край', 'края': 'край',
  'ао': 'ао', 'округ': 'округ', 'аобл': 'область',
};

/**
 * Канон района: только название, без слова «район».
 *
 * Тип отбрасываем целиком, а не канонизируем: в источниках он стоит
 * и до названия («р-н Аксайский»), и после («Аксайский район»), и это
 * единственное различие. Само название и так уникально внутри субъекта.
 */
function canonicaliseDistrict(part: string): string {
  return clean(part)
    .split(' ')
    .map(token)
    .filter((word) => word && !DISTRICT_TYPES.has(word))
    .join(' ');
}

function canonicaliseRegion(part: string): string {
  const words = clean(part).split(' ').map(token).filter(Boolean);

  const kinds: string[] = [];
  const name: string[] = [];

  for (const word of words) {
    const kind = REGION_KIND_CANON[word];
    if (kind) kinds.push(kind);
    // «автономный», «автономная» — часть типа, а не названия
    else if (word.startsWith('автономн')) kinds.push(word);
    else name.push(word);
  }

  return [...name, ...kinds].join(' ');
}

/**
 * Префиксы номеров.
 *
 * Два правила, без которых регулярки врут:
 *
 * 1. Альтернативы идут ОТ ДЛИННОГО К КОРОТКОМУ. Регекс берёт первую
 *    подошедшую ветку, поэтому в «к|кор|корп|корпус» на строке «корп. 3»
 *    срабатывает «к», и номером корпуса становится «орп.3».
 *
 * 2. После префикса обязателен разделитель — точка, пробел или сразу цифра.
 *    Иначе «кв-л 5» (квартал) распознаётся как квартира.
 */
const SEP = String.raw`(?:\.|\s|(?=\d))\s*`;

const HOUSE_RE = new RegExp(`^(?:дом|владение|влд|двлд|участок|уч|д)${SEP}(\\S.*)$`, 'i');
const BLOCK_RE = new RegExp(`^(?:корпус|корп|кор|к)${SEP}(\\S.*)$`, 'i');
const BUILDING_RE = new RegExp(`^(?:строение|сооружение|соор|стр)${SEP}(\\S.*)$`, 'i');
const FLAT_RE = new RegExp(
  `^(?:квартира|кв|офис|оф|помещение|пом|комната|ком)${SEP}(\\S.*)$`,
  'i',
);

function clean(part: string): string {
  return part.replace(/\s+/g, ' ').trim();
}

/** Убирает точки у сокращений и приводит к нижнему регистру для сравнения. */
function token(word: string): string {
  return lower(word.replace(/\.+$/, ''));
}

/**
 * Приводит «пр-кт Ленина» и «Ленина проспект» к «проспект ленина».
 * Тип улицы может стоять и до, и после названия — встречается и так, и так.
 */
function canonicaliseStreet(part: string): string {
  const words = clean(part).split(' ');
  if (words.length === 0) return '';

  const firstType = STREET_TYPES[token(words[0])];
  if (firstType && words.length > 1) {
    return `${firstType} ${lower(words.slice(1).join(' '))}`;
  }

  const lastType = STREET_TYPES[token(words[words.length - 1])];
  if (lastType && words.length > 1) {
    return `${lastType} ${lower(words.slice(0, -1).join(' '))}`;
  }

  return lower(clean(part));
}

function stripCityType(part: string): string {
  const words = clean(part).split(' ');
  if (words.length > 1 && CITY_TYPES.has(token(words[0]))) {
    return words.slice(1).join(' ');
  }
  if (words.length > 1 && CITY_TYPES.has(token(words[words.length - 1]))) {
    return words.slice(0, -1).join(' ');
  }
  return clean(part);
}

/** Номер квартиры: «15», «15а» — регистр и пробелы не должны разводить соседей. */
function canonicaliseNumber(value: string): string {
  return normaliseChars(value);
}

/**
 * Латиница, неотличимая от кириллицы на вид.
 *
 * «15A» латинской буквой и «15А» кириллической — один и тот же дом, но
 * для машины это разные строки. Так пишут и распознаватели фотографий,
 * и люди с включённой раскладкой; без сведения соседи разъезжаются
 * по разным домам, и никто не понимает почему.
 */
const LOOKALIKE: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м',
  o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

function normaliseChars(value: string): string {
  return lower(value)
    .replace(/[abcehkmoptxy]/g, (ch) => LOOKALIKE[ch] ?? ch)
    .replace(/\s+/g, '')
    .replace(/[.,]+$/g, '')
    .replace(/\.(?=\S)/g, '');
}

/**
 * Тип адресуемого объекта.
 *
 * Владение, домовладение и здание — это НЕ дом с тем же номером.
 * «Владение 33» и «дом 33» на одной улице могут стоять рядом и быть
 * разными объектами; пока тип отбрасывался, их жильцы оказывались
 * соседями по одной ленте.
 */
const HOUSE_KINDS: Record<string, string> = {
  'двлд': 'двлд', 'домовладение': 'двлд',
  'влд': 'влд', 'вл': 'влд', 'владение': 'влд',
  'зд': 'зд', 'здание': 'зд',
  'соор': 'соор', 'сооружение': 'соор',
  'стр': 'стр', 'строение': 'стр',
  'уч': 'уч', 'участок': 'уч',
  'гар': 'гар', 'гараж': 'гар',
};

export interface HouseNumber {
  /** Номер с буквой и дробью: «15», «15а», «4б/1» */
  number: string;
  /** Литера, записанная словом: «литера А» */
  letter: string | null;
  /** Корпус, если он слит с номером: «12к1» */
  block: string | null;
  /** Строение или сооружение, слитое с номером: «8астр54» */
  building: string | null;
  /** Тип объекта, если это не обычный дом */
  kind: string | null;
}

/**
 * Разбор номера дома во всех формах, которыми его пишут в России.
 *
 * Формы взяты не из головы, а из КЛАДР: на 34 миллионах номеров это
 * 70% просто цифры, 8% цифра с буквой, 5% со строением, 3% дробь,
 * остальное — владения, литеры и их сочетания вроде «41/1литер1».
 *
 * Главное требование — устойчивость ключа: «12к1» и «12, к. 1» обязаны
 * дать один дом, потому что это одна и та же запись двумя способами.
 * А вот дробь «4/1» корпусом НЕ считается: на пересечении улиц так
 * нумеруют самостоятельные дома, и слить их значило бы поселить
 * чужих людей в одну ленту.
 */
export function parseHouseNumber(raw: string): HouseNumber {
  let rest = normaliseChars(raw);
  let kind: string | null = null;

  /**
   * Тип объекта в начале: «влд33», «двлд4», «зд221».
   *
   * Обычный дом («дом 15», «д. 15») типа не получает: он и так подавляющее
   * большинство, и добавлять его в ключ значило бы развести «д. 15» и «15»,
   * записанные в разных квитанциях одного дома.
   */
  const kindMatch = /^(домовладение|двлд|владение|влд|вл|здание|зд|сооружение|соор|строение|стр|участок|уч|гараж|гар|дом|д)(?=\d)/.exec(rest);
  if (kindMatch) {
    kind = HOUSE_KINDS[kindMatch[1]] ?? null;
    rest = rest.slice(kindMatch[1].length);
  }

  // Разбираем с конца: сначала строение, потом корпус, потом литера
  let building: string | null = null;
  const buildingMatch = /(?:строение|стр|сооружение|соор)(\d+[а-я]?)$/.exec(rest);
  if (buildingMatch) {
    building = buildingMatch[1];
    rest = rest.slice(0, buildingMatch.index);
  }

  let block: string | null = null;
  const blockMatch = /(?:корпус|корп|кор|к)(\d+[а-я]?)$/.exec(rest);
  if (blockMatch) {
    block = blockMatch[1];
    rest = rest.slice(0, blockMatch.index);
  }

  let letter: string | null = null;
  const letterMatch = /(?:литера|литер|лит)([0-9а-я]+)$/.exec(rest);
  if (letterMatch) {
    letter = letterMatch[1];
    rest = rest.slice(0, letterMatch.index);
  }

  /**
   * Дробь — это корпус: «85/3» и «85, к. 3» один дом.
   *
   * Раньше было наоборот, и по осознанной причине: на пересечении улиц
   * дробью нумеруют самостоятельные дома, поэтому слияние грозило поселить
   * чужих людей в одну ленту. Ключ оставался строгим, а написания сводил
   * только поиск по реестру — houseKeyCandidates.
   *
   * Проверка на живых квитанциях перевесила. У одной квартиры их четыре:
   * ЖКУ, свет, газ, мусор. В двух дом напечатан через дробь, в двух через
   * корпус — и это НОРМА, а не исключение: организации берут адрес из
   * разных источников. Пока написания считались разными домами, человек
   * с четырьмя квитанциями получал два «адреса», сумма за квартиру не
   * складывалась, а соседи расходились по двум лентам одного дома.
   *
   * Размен принят сознательно: редкий угловой дом, разделённый дробью,
   * теперь сольётся с соседним. Это лечится реестром — там дом записан
   * один раз, — а рассыпающаяся квартира не лечится ничем.
   */
  if (!block) {
    const fraction = /^(\d+[а-я]?)\/(\d+[а-я]?)$/.exec(rest);
    if (fraction) {
      rest = fraction[1];
      block = fraction[2];
    }
  }

  return { number: rest, letter, block, building, kind };
}

/**
 * Каноническая запись номера дома для ключа.
 *
 * Тип объекта попадает в ключ, литера тоже: «литера А» и «литера Б» —
 * разные дома, и пока литера молча отбрасывалась, они сливались в один.
 */
function houseToken(parsed: HouseNumber): string {
  return [parsed.kind ? `${parsed.kind}:` : '', parsed.number, parsed.letter ?? '']
    .join('');
}

export function parseAddress(raw: string): ParsedAddress {
  const source = clean(raw ?? '');

  let postalCode: string | null = null;
  let region: string | null = null;
  let district: string | null = null;
  let city: string | null = null;
  let subplace: string | null = null;
  let street: string | null = null;
  let house: string | null = null;
  let block: string | null = null;
  let building: string | null = null;
  let flat: string | null = null;

  /** Всё, что похоже на улицу. Кто из них ею станет — решаем после разбора. */
  const streetCandidates: { value: string; rank: 'real' | 'place' | 'unknown' }[] = [];

  const parts = source.split(',').map(clean).filter(Boolean);

  for (const part of parts) {
    if (!postalCode && /^\d{6}$/.test(part)) {
      postalCode = part;
      continue;
    }

    const flatMatch = FLAT_RE.exec(part);
    if (flatMatch) {
      flat = canonicaliseNumber(flatMatch[1]);
      continue;
    }

    const blockMatch = BLOCK_RE.exec(part);
    if (blockMatch) {
      block = canonicaliseNumber(blockMatch[1]);
      continue;
    }

    // «литера А» отдельным сегментом: часть номера дома, а не отдельное поле
    const literaMatch = /^(?:литера|литер|лит)(?:\.|\s)\s*([0-9а-яa-z]+)$/i.exec(part);
    if (literaMatch && house !== null) {
      house += normaliseChars(literaMatch[1]);
      continue;
    }

    const buildingMatch = BUILDING_RE.exec(part);
    if (buildingMatch) {
      building = canonicaliseNumber(buildingMatch[1]);
      continue;
    }

    // «д. 85» — дом. Но «д Иваново» — деревня: отличаем по наличию цифры.
    const houseMatch = HOUSE_RE.exec(part);
    if (houseMatch && /\d/.test(houseMatch[1])) {
      // Разбираем сегмент целиком: в префиксе прячется тип объекта,
      // а «владение 33» и «дом 33» — разные адреса на одной улице
      const parsed = parseHouseNumber(part);
      house = houseToken(parsed);
      // Корпус и строение бывают слиты с номером: «12к1», «8астр54».
      // Записанные отдельным сегментом, они разберутся своей веткой выше
      if (parsed.block && !block) block = parsed.block;
      if (parsed.building && !building) building = parsed.building;
      continue;
    }

    const words = clean(part).split(' ');
    const tokens = words.map(token);

    if (!region && looksLikeRegion(tokens)) {
      region = canonicaliseRegion(part);
      continue;
    }

    /**
     * Район субъекта. Раньше этой ветки не было: сегмент «р-н Аксайский»
     * не подходил ни под один шаблон, падал в последнюю ветку и становился
     * улицей — а настоящая улица следом просто исчезала.
     */
    if (!district && tokens.some((t) => DISTRICT_TYPES.has(t))) {
      district = canonicaliseDistrict(part);
      continue;
    }

    const looksLikeCity =
      CITY_TYPES.has(tokens[0]) || CITY_TYPES.has(tokens[tokens.length - 1]);
    if (!city && looksLikeCity) {
      city = lower(stripCityType(part));
      continue;
    }

    const streetType = STREET_TYPES[tokens[0]] ?? STREET_TYPES[tokens[tokens.length - 1]];
    if (streetType !== undefined) {
      streetCandidates.push({
        value: canonicaliseStreet(part),
        rank: PLACE_LIKE_STREET_TYPES.has(streetType) ? 'place' : 'real',
      });
      continue;
    }

    /**
     * Голый номер без префикса: «85» или «влд 33» отдельным сегментом.
     *
     * Требуем, чтобы сегмент начинался с цифры или с известного типа
     * объекта: иначе номером дома станет любое непонятое слово.
     */
    if (!house && /^(?:\d|двлд|влд|вл|зд|соор|стр|уч|гар|дом|владение)/i.test(part) && /\d/.test(part)) {
      const parsed = parseHouseNumber(part);
      house = houseToken(parsed);
      if (parsed.block && !block) block = parsed.block;
      if (parsed.building && !building) building = parsed.building;
      continue;
    }

    // Остаток: если города ещё нет — считаем городом, иначе слабым кандидатом в улицу
    if (!city) city = lower(clean(part));
    else streetCandidates.push({ value: canonicaliseStreet(part), rank: 'unknown' });
  }

  /**
   * Кто из кандидатов станет улицей.
   *
   * Раньше побеждал ПЕРВЫЙ подошедший, и это ломалось в обе стороны:
   * «мкр Солнечный, ул Мира» отдавало улицей микрорайон, а настоящая
   * улица терялась. Теперь порядок предпочтений явный:
   *
   *   1. Настоящая улица — последняя из встреченных. На угловых адресах
   *      источники перечисляют обе, и выбор должен быть хотя бы устойчивым.
   *   2. Микрорайон или квартал — если настоящей улицы нет вовсе,
   *      он и есть адресный элемент («кв-л Северный, д. 5»).
   *   3. Непонятый сегмент — как и раньше, только первый и только
   *      когда больше взять нечего.
   *
   * Микрорайон, уступивший улице, не выбрасывается: он уточняет адрес
   * и входит в строгий ключ.
   */
  const lastOf = (rank: 'real' | 'place') => {
    const list = streetCandidates.filter((c) => c.rank === rank);
    return list.length > 0 ? list[list.length - 1] : null;
  };

  const chosenStreet =
    lastOf('real')
    ?? lastOf('place')
    ?? streetCandidates.find((c) => c.rank === 'unknown')
    ?? null;

  street = chosenStreet?.value ?? null;
  subplace = streetCandidates
    .filter((c) => c.rank === 'place' && c !== chosenStreet)
    .map((c) => c.value)
    .join(' ') || null;

  /**
   * БЕЗ НОМЕРА ДОМА КЛЮЧА НЕТ.
   *
   * Раньше условием было `city || street || house`, и адрес с номером
   * дома, который не разобрался («д. abc», «д. -», просто опечатка),
   * получал непустой ключ, посчитанный из города и улицы. Предохранитель
   * `if (!address.houseKey) return null` в привязке при этом НЕ срабатывал:
   * ключ-то есть. В итоге вся улица становилась одним «домом», а квартиры
   * с одинаковым номером на ней — одним объектом: общие начисления,
   * общая лента, общий собственник.
   *
   * Дом — обязательная часть адреса дома. Нет его — нет и ключа,
   * и вызывающий код честно скажет, что адрес разобрать не удалось.
   *
   * Позиционная запись обязательна: filter(Boolean) склеивал бы
   * «корпус 2» и «строение 2» в один и тот же ключ.
   */
  const canonical = house
    ? [
        `r:${region ?? ''}`,
        `d:${district ?? ''}`,
        `c:${city ?? ''}`,
        `p:${subplace ?? ''}`,
        `s:${street ?? ''}`,
        `h:${house}`,
        `k:${block ?? ''}`,
        `b:${building ?? ''}`,
      ].join('|')
    : '';

  return {
    postalCode,
    region,
    district,
    city,
    subplace,
    street,
    house,
    block,
    building,
    flat,
    canonical,
    houseKey: hashHouseKey(canonical),
    raw: source,
  };
}

/**
 * Ключ дома. Квартира в него НЕ входит — иначе каждый жилец окажется
 * в собственном «доме» и соседские функции не заработают.
 */
/**
 * Ключи, по которым ищем дом в реестре.
 *
 * Сейчас он всегда один: «Ленина 85/3» и «Ленина 85, к. 3» дают
 * одинаковый ключ, потому что дробь разбирается как корпус — см.
 * parseHouseNumber.
 *
 * Раньше здесь был мост. Ключ считался строгим, дробь корпусом не
 * признавалась, и написания сводились только на ПОИСКЕ: функция отдавала
 * несколько кандидатов, дом находился при любом написании, но в базе
 * оставался под своим. Мост держался на предположении, что дом всегда
 * есть в реестре, — а квартира с четырьмя квитанциями разных написаний
 * рассыпалась на два адреса ещё до всякого поиска.
 *
 * Функция оставлена, а не вырезана: вызывающему коду по-прежнему удобно
 * получать список, и если правила снова разойдутся, мост вернётся сюда же.
 */
/**
 * Ключ дома БЕЗ региона.
 *
 * ЗАЧЕМ. Регион печатают не все. Живая квитанция начинается сразу
 * с города — «г Ростов-на-Дону, пр-кт Ленина, д.85 корп. 3, кв.27», —
 * а реестр ГИС ЖКХ тот же дом пишет с регионом. Строгие ключи у них
 * разные, дом не находится: житель остаётся без управляющей компании,
 * а компания не видит жителя. Ровно это и случилось на пилотном доме.
 *
 * Обратное встречается тоже: часть адресов САМОГО реестра региона
 * не содержит — «346780, г Азов, ул Мира».
 *
 * Строгий ключ при этом остаётся главным. Этот — запасной, для поиска
 * по реестру, и только когда совпадение ЕДИНСТВЕННОЕ: город, улица
 * и номер дома повторяются в разных субъектах (Советск, Кировск,
 * улица Ленина, дом 1), и молча выбирать из нескольких нельзя.
 */
export function looseHouseKey(raw: string): string {
  const parsed = parseAddress(raw);
  if (!parsed.canonical) return '';

  /**
   * Отбрасываем ровно то, что источники печатают непоследовательно:
   * регион, район субъекта и микрорайон. Город, улица, дом, корпус
   * и строение остаются — иначе ключ перестал бы что-либо различать.
   *
   * Район добавлен сюда вместе с самим полем: реестр ГИС ЖКХ по сельским
   * адресам пишет «обл Ростовская, р-н Аксайский, ст-ца Старочеркасская,
   * ул Советская, д. 1», а квитанция того же дома — «Ростовская обл,
   * ст-ца Старочеркасская, ул Советская, д. 1». Строгие ключи у них
   * разные по построению, и сойтись они могут только здесь.
   */
  return hashHouseKey([
    'r:',
    'd:',
    `c:${parsed.city ?? ''}`,
    'p:',
    `s:${parsed.street ?? ''}`,
    `h:${parsed.house ?? ''}`,
    `k:${parsed.block ?? ''}`,
    `b:${parsed.building ?? ''}`,
  ].join('|'));
}

export function houseKeyCandidates(raw: string): string[] {
  const parsed = parseAddress(raw);
  return parsed.houseKey ? [parsed.houseKey] : [];
}

export function hashHouseKey(canonical: string): string {
  if (!canonical) return '';
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Короткая подпись адреса для интерфейса: «ул. Заречная 24, кв. 15». */
export function shortAddress(a: ParsedAddress): string {
  const street = a.street ? capitaliseWords(a.street) : '';
  const house = [a.house, a.block ? `к${a.block}` : null].filter(Boolean).join('');
  const flat = a.flat ? `кв. ${a.flat}` : '';
  return [ [street, house].filter(Boolean).join(' '), flat ].filter(Boolean).join(', ');
}

function capitaliseWords(value: string): string {
  return value.replace(/(^|[\s-])([а-яёa-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Ключ для поиска по справочнику: нижний регистр, «ё» сведена к «е».
 *
 * «Ё» обязательна: в КЛАДР улица записана как «Щёлковская», а человек
 * набирает «щелковская» — без сведения поиск молча ничего не находит,
 * и справочник выглядит неполным.
 */
export function searchName(value: string): string {
  return lower(value).replace(/\s+/g, ' ').trim();
}
