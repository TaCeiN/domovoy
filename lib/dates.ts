/**
 * Разбор даты, пришедшей от клиента.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. В пяти местах подряд стояло
 * `body.expiresAt ? new Date(body.expiresAt) : null`, и любая строка,
 * которую `Date` не разобрал, уезжала в Postgres как `Invalid Date`.
 * Драйвер падал, обработчик ошибок отвечал 500 и «Что-то пошло не так» —
 * то есть диспетчер видел поломку сервера вместо «проверьте поле даты».
 *
 * Пустое значение и отсутствие поля — это НЕ ошибка: срок у объявления
 * необязателен, окно мастера тоже. Поэтому «не передано» и «передано,
 * но не разбирается» разведены явно, а не сведены к одному `null`.
 */

export type ParsedDate =
  | { ok: true; date: Date | null }
  | { ok: false };

export function parseOptionalDate(raw: unknown): ParsedDate {
  if (raw === undefined || raw === null || raw === '') return { ok: true, date: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false };

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, date };
}

/** То же, но для мест, где `undefined` удобнее, чем `null`. */
export function parseOptionalDateOrUndefined(
  raw: unknown,
): { ok: true; date: Date | undefined } | { ok: false } {
  const parsed = parseOptionalDate(raw);
  return parsed.ok ? { ok: true, date: parsed.date ?? undefined } : { ok: false };
}
