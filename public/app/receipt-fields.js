/**
 * Что человек видит в своей квитанции — прямо из строки QR, без сервера.
 *
 * Сервер адрес из базы до подтверждения не отдаёт: иначе по ответам
 * перебирались бы чужие счета (server/routes/auth.test.ts, «адрес до
 * подтверждения не отдаём»). Но строку QR человек принёс сам — показать
 * ему её же поля не значит ничего раскрыть. Так форма «Проверьте данные»
 * не переспрашивает то, что уже напечатано в квитанции.
 *
 * Формат — ГОСТ Р 56042-2014: `ST0001x|Ключ=Значение|…`. Разбор нарочно
 * мягкий: не нашлось поля — null, форма спросит сама. Проверку строки
 * делает сервер (lib/qr/receipt.ts), здесь её не повторяем.
 */
export function receiptFields(qr) {
  const empty = { fullName: null, address: null, flat: null, persAcc: null, payeeName: null, regionCode: null };
  if (typeof qr !== 'string' || !/^﻿?ST\d{5}\|/.test(qr.trim())) return empty;

  const fields = new Map();
  for (const chunk of qr.trim().split('|').slice(1)) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const value = chunk.slice(eq + 1).trim();
    // Регистр имён полей у разных расчётных центров гуляет
    if (value) fields.set(chunk.slice(0, eq).trim().toLowerCase(), value);
  }
  const get = (...keys) => keys.map((k) => fields.get(k.toLowerCase())).find(Boolean) ?? null;

  const fullName = [get('lastName'), get('firstName'), get('middleName')].filter(Boolean).join(' ') || null;
  const address = get('payerAddress');
  // Квартира: отдельное поле у части расчётных центров, иначе — «кв. 27» в адресе
  const flat = get('flat', 'apartment')
    ?? address?.match(/(?:кв\.?|квартира)\s*(\d+[а-яa-z]?)/i)?.[1] ?? null;

  return {
    fullName,
    address,
    flat,
    persAcc: get('persAcc'),
    payeeName: unquote(get('Name')),
    regionCode: regionFromInn(get('PayeeINN')),
  };
}

/** Внешние кавычки вокруг всего названия — как unquote в lib/qr/receipt.ts */
function unquote(value) {
  if (!value) return null;
  for (const [open, close] of [['"', '"'], ["'", "'"], ['«', '»']]) {
    if (value.length > 1 && value.startsWith(open) && value.endsWith(close)) {
      const inner = value.slice(1, -1).trim();
      if (inner && !inner.includes(open) && !inner.includes(close)) return inner;
    }
  }
  return value;
}

/**
 * Регион по ИНН получателя — то же правило, что regionCodeFromInn
 * в lib/address/registry.ts: первые две цифры ИНН юрлица. Нужен форме
 * «Адрес не мой», чтобы искать улицы в том же справочнике, что и сервер.
 */
function regionFromInn(inn) {
  if (!inn || !/^\d{10}$|^\d{12}$/.test(inn)) return null;
  const code = inn.slice(0, 2);
  return code === '00' || code === '99' || code === '98' ? null : code;
}
