/**
 * Проверка фактов в ответе модели.
 *
 * Модель пишет ответ сама, но данные жителя — деньги, номера заявок,
 * телефоны, даты, показания — она получает только из инструментов.
 * Здесь код находит такие данные в готовом тексте и ищет каждое в том,
 * что вернули инструменты этого ответа, и в сообщении самого жителя.
 * Не нашлось — ответ не уходит, вместо него шаблон кода
 * (lib/bot/handle.ts). Так модель может сказать что угодно, а соврать
 * про чужие деньги или выдумать телефон УК — нет.
 *
 * Числа законов («не больше 14 дней», «ст. 157 ЖК РФ») и экстренные
 * номера (112) проверка не трогает: это не данные жителя.
 */

const MONTHS = 'январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр';

const PATTERNS: RegExp[] = [
  // деньги: число рядом с ₽ или «руб»
  /(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:₽|руб)/gi,
  // номер заявки: «№ 12», «заявка 12», «заявка № 12»
  /(?:№\s*|заявк[а-я]*\s+(?:№\s*)?)(\d{1,8})/gi,
  // телефон: +7 или 8 и ещё 10 цифр в любом написании
  /((?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})/g,
  // дата цифрами: 15.10, 15.10.2026
  /(\b\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)(?!\d)/g,
  // дата словами: 15 октября
  new RegExp(`(\\b\\d{1,2})\\s+(?:${MONTHS})`, 'gi'),
  // показание: дробное число рядом с единицами
  /(\d+[.,]\d+)\s*(?:куб|м³|м3|квт)/gi,
];

const digits = (s: string) => s.replace(/\D/g, '');
const trimZeros = (s: string) => s.replace(/^0+(?=\d)/, '');

export interface FactCheck {
  ok: boolean;
  /** Найденные в ответе данные, которых нет в источниках */
  unknown: string[];
}

export function checkFacts(reply: string, sources: string[]): FactCheck {
  // Числа источников по отдельности и слитно: «4 850,00 ₽» → 4, 850, 00 и 485000
  const numbers = new Set<string>();
  const joined: string[] = [];
  for (const s of sources) {
    for (const n of s.split(/\D+/).filter(Boolean)) numbers.add(trimZeros(n));
    for (const group of s.match(/\d[\d\s.,()+-]*\d|\d/g) ?? []) joined.push(digits(group));
  }

  const unknown: string[] = [];
  for (const rx of PATTERNS) {
    for (const m of reply.matchAll(rx)) {
      const found = trimZeros(digits(m[1]));
      if (!found) continue;
      // Записано в источнике так же — подтверждено: «4.6» рейтинга — не дата 4 июня
      // (только с точкой или запятой либо от 4 цифр: короткое «86» нашлось бы внутри «(863)»)
      const literal = m[1].trim();
      if ((/[.,]/.test(literal) || found.length >= 4) && sources.some((s) => s.includes(literal))) continue;
      // Короткое число ищем только целиком: «86» не должно найтись внутри телефона
      const known = numbers.has(found) || (found.length >= 4 && joined.some((j) => j.includes(found)));
      if (!known) unknown.push(m[0].trim().replace(/[\s]+/g, ' '));
    }
  }
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}
