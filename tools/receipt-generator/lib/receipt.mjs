/**
 * Сборка строки платёжного QR по ГОСТ Р 56042-2014.
 *
 * Модуль без зависимостей и без Node-специфики: его импортирует и сервер
 * инструмента, и сама страница в браузере. Одна реализация вместо двух —
 * иначе они разъедутся, и генератор начнёт выдавать не то, что показывает.
 *
 * Порядок полей взят с живых квитанций: сначала обязательные реквизиты
 * получателя, потом плательщик. Приложение читает поля по именам и порядку
 * не требует, но человек, который будет сравнивать строку с бумажкой,
 * ждёт привычной последовательности.
 */

/** Признак кодировки в служебном блоке: «1» — win-1251, «2» — UTF-8. */
export const ENCODINGS = [
  { flag: '1', label: 'windows-1251 (ST00011) — как печатают расчётные центры' },
  { flag: '2', label: 'UTF-8 (ST00012) — реже, но встречается' },
];

/**
 * Получатели платежа по умолчанию.
 *
 * ЭТО НЕ УПРАВЛЯЮЩИЕ КОМПАНИИ. Получатель платежа и организация,
 * обслуживающая дом, — разные лица: свет и газ идут ресурсникам напрямую,
 * а жилищную квитанцию печатает расчётный центр, которого в реестре
 * управляющих организаций нет вовсе. Приложение специально не выводит УК
 * из квитанции, и генератор обязан давать возможность это проверить.
 */
export const PAYEES = [
  {
    id: 'ivc',
    name: 'ГУП РО "ИВЦ ЖКХ"',
    inn: '6167110467',
    kpp: '616701001',
    purpose: 'Оплата за ЖКУ',
    note: 'расчётный центр: в реестре управляющих организаций его нет',
  },
  {
    id: 'energo',
    name: 'ООО "ТНС энерго Ростов-на-Дону"',
    inn: '6168002922',
    kpp: '616801001',
    purpose: 'Оплата за электроэнергию',
    note: 'энергосбыт: дом не обслуживает, заявку принять не может',
  },
  {
    id: 'gas',
    name: 'ООО "Газпром межрегионгаз Ростов-на-Дону"',
    inn: '6167049710',
    kpp: '616701001',
    purpose: 'Оплата за газ',
    note: 'поставщик газа',
  },
  {
    id: 'uk',
    name: 'ООО "УК Трианон"',
    inn: '6168108630',
    kpp: '616801001',
    purpose: 'Оплата за содержание жилья',
    note: 'настоящая управляющая организация из реестра',
  },
];

/**
 * Период в формате квитанции.
 *
 * Печатают его как MMYYYY. Разбор понимает и другие формы, но генератор
 * выдаёт самую частую — проверять надо обычный случай.
 */
export function formatPeriod(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${month}${date.getFullYear()}`;
}

/** Рубли с копейками в целые копейки: 3816.30 → 381630. */
export function toKopecks(rubles) {
  const value = Number(String(rubles).replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * Собрать строку.
 *
 * Пустые поля не пишем вовсе: в живых квитанциях расчётных центров нет
 * ни ФИО, ни адреса, и именно этот случай ломался дольше всего —
 * приложение должно спросить адрес у жителя, а не завести пустой объект.
 */
export function buildReceipt(input) {
  const {
    encoding = '1',
    payeeName,
    payeeInn,
    kpp,
    payeeAccount = '40702810952090030727',
    bankName = 'ПАО Сбербанк',
    bic = '046015602',
    corrAccount = '30101810600000000602',
    purpose,
    persAcc,
    address,
    lastName,
    firstName,
    middleName,
    sumKopecks,
    period,
  } = input;

  const parts = [`ST0001${encoding}`];

  const add = (key, value) => {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (text) parts.push(`${key}=${text}`);
  };

  add('Name', payeeName);
  add('PersonalAcc', payeeAccount);
  add('BankName', bankName);
  add('BIC', bic);
  add('CorrespAcc', corrAccount);
  add('PayeeINN', payeeInn);
  add('KPP', kpp);
  add('Purpose', purpose);

  add('lastName', lastName);
  add('firstName', firstName);
  add('middleName', middleName);
  add('payerAddress', address);
  add('persAcc', persAcc);

  if (sumKopecks !== null && sumKopecks !== undefined && sumKopecks !== '') {
    add('Sum', sumKopecks);
  }
  add('paymPeriod', period);

  return parts.join('|');
}

/**
 * Правдоподобный номер лицевого счёта.
 *
 * Пятнадцать цифр — как у расчётных центров. Генерируется из адреса
 * и квартиры, чтобы повторный запуск для того же адреса дал ТОТ ЖЕ номер:
 * иначе каждая генерация заводила бы в приложении новый счёт, и проверить
 * «повторный скан той же квитанции» стало бы невозможно.
 */
export function persAccFor(address, flat) {
  const source = `${address}|${flat ?? ''}`;
  let hash = 0x811c9dc5;

  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return String(hash).padStart(10, '0').slice(0, 10) + String(hash % 100000).padStart(5, '0');
}
