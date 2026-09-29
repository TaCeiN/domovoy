import { and, asc, eq } from 'drizzle-orm';
import { account, bill, meter, meterReading, property, userProperty } from '../../db/schema.ts';
import { formatKopecks } from '../qr/receipt.ts';
import { SERVICE_LABEL } from '../bills/service.ts';
import { METER_LABEL, METER_UNIT, type MeterKind } from '../meters/service.ts';
import { accessLevel } from '../auth/access.ts';
import { broughtBy } from '../bills/bringers.ts';
import { visibleMeters } from '../meters/service.ts';
import type { Database } from '../../db/client.ts';

/**
 * Аналитика потребления.
 *
 * Строится на настоящих данных: суммы берутся из квитанций, объёмы —
 * из переданных показаний. Никаких выдуманных рядов: если человек
 * отсканировал одну квитанцию, графика не будет, и это честно.
 *
 * Пустая аналитика — не поломка, а повод доскать прошлые квитанции.
 * Поэтому в ответе всегда есть подсказка, что делать.
 */

export interface Point {
  period: string;
  label: string;
  value: number;
}

/** Одна квитанция в разбивке последнего месяца. */
export interface LatestPart {
  label: string;
  persAcc: string;
  kopecks: number;
  formatted: string;
}

const MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

function periodLabel(period: string): string {
  const [, month] = period.split('-');
  return MONTHS[Number(month) - 1] ?? period;
}

export async function consumptionAnalytics(
  db: Database,
  userId: string,
  propertyId: string,
) {
  // Своя аналитика — из своих же квитанций, подтверждения не требует
  const level = await accessLevel(db, userId, propertyId);
  if (level === 'none') return null;
  /**
   * До подтверждения — только принесённое самим.
   *
   * Здесь условия не было, хотя комментарий выше его обещал: аудит
   * 26 сентября нашёл неподтверждённого жителя, который на главной видел
   * 0 ₽, а в аналитике — 7 633 ₽ всей квартиры, включая чужой газ.
   */
  const own = level !== 'full';

  /* ── начисления по месяцам ────────────────────────────────── */

  /**
   * Складываем по МЕСЯЦУ, а не отдаём строками `bill`.
   *
   * У квартиры столько лицевых счетов, сколько квитанций приходит:
   * ЖКУ и свет — разные деньги разным организациям. Пока строки шли
   * как есть, месяц с двумя квитанциями рисовал два столбца с одной
   * подписью, «изменение» сравнивало ЖКУ со светом («снизилось
   * на 48%», хотя не снизилось ничего), а прогноз считался по смеси
   * счетов. С одной квитанцией ошибки не было видно — со второй
   * она появляется на первый же месяц.
   */
  const bills = await db
    .select({
      period: bill.period,
      sumKopecks: bill.sumKopecks,
      persAcc: account.persAcc,
      service: account.service,
    })
    .from(bill)
    .innerJoin(account, eq(bill.accountId, account.id))
    .where(own
      ? and(eq(bill.propertyId, propertyId), broughtBy(userId))
      : eq(bill.propertyId, propertyId))
    .orderBy(asc(bill.period));

  const byPeriod = new Map<string, { total: number; parts: LatestPart[] }>();
  for (const b of bills) {
    const month = byPeriod.get(b.period) ?? { total: 0, parts: [] };
    month.total += b.sumKopecks;
    month.parts.push({
      label: SERVICE_LABEL[b.service] ?? 'Начисление',
      persAcc: b.persAcc,
      kopecks: b.sumKopecks,
      formatted: formatKopecks(b.sumKopecks),
    });
    byPeriod.set(b.period, month);
  }

  const periods = [...byPeriod.keys()].sort();
  const payments: Point[] = periods.map((period) => ({
    period,
    label: periodLabel(period),
    value: byPeriod.get(period)!.total,
  }));

  /**
   * Из чего сложилась сумма последнего месяца.
   *
   * Одна цифра без разбивки оставляет вопрос «почему так много»,
   * а `partial` закрывает вторую половину той же лжи: месяц, где
   * отсканирована не каждая квитанция, иначе выглядит как «стало
   * дешевле».
   */
  // Сколько счетов у квартиры — столько, сколько человеку можно видеть
  const accounts = own
    ? [...new Set(bills.map((b) => b.persAcc))]
    : await db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.propertyId, propertyId));

  const lastPeriod = periods[periods.length - 1];
  const latest = lastPeriod === undefined ? null : {
    period: lastPeriod,
    parts: [...byPeriod.get(lastPeriod)!.parts].sort((a, b) => b.kopecks - a.kopecks),
    accountsTotal: accounts.length,
    partial: byPeriod.get(lastPeriod)!.parts.length < accounts.length,
  };

  /* ── расход по счётчикам ──────────────────────────────────── */
  const meters = await visibleMeters(db, userId, propertyId, level);

  const series = await Promise.all(meters.map(async (m) => {
    const readings = await db
      .select()
      .from(meterReading)
      .where(eq(meterReading.meterId, m.id))
      .orderBy(asc(meterReading.period));

    // Расход — это разница между соседними показаниями, а не само показание
    const points: Point[] = [];
    for (let i = 1; i < readings.length; i++) {
      const delta = Number(readings[i].value) - Number(readings[i - 1].value);
      if (Number.isFinite(delta) && delta >= 0) {
        points.push({
          period: readings[i].period,
          label: periodLabel(readings[i].period),
          value: Number(delta.toFixed(2)),
        });
      }
    }

    const kind = m.kind as MeterKind;
    return {
      meterId: m.id,
      kind,
      label: METER_LABEL[kind] ?? m.kind,
      unit: METER_UNIT[kind] ?? '',
      points,
      change: changePercent(points),
    };
  }));

  /* ── прогноз ──────────────────────────────────────────────── */
  const forecast = forecastNext(payments);

  return {
    payments: {
      points: payments.map((p) => ({ ...p, formatted: formatKopecks(p.value) })),
      change: changePercent(payments),
      months: payments.length,
      latest,
    },
    meters: series.filter((s) => s.points.length > 0),
    forecast: forecast === null ? null : {
      kopecks: forecast,
      formatted: formatKopecks(forecast),
      basis: payments.length >= 3
        ? 'среднее за последние три месяца с поправкой на тренд'
        : 'слишком мало данных, показан последний известный платёж',
    },
    // Пустая аналитика должна объяснять себя, а не выглядеть поломкой
    hint: payments.length < 2
      ? 'Отсканируйте квитанции за прошлые месяцы, чтобы увидеть динамику. ' +
        'Каждая новая квитанция уточняет прогноз.'
      : null,
    tips: buildTips(series, payments),
  };
}

/** Изменение к прошлому месяцу в процентах. */
function changePercent(points: Point[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1].value;
  const prev = points[points.length - 2].value;
  if (prev === 0) return null;
  return Math.round(((last - prev) / prev) * 100);
}

/**
 * Прогноз следующего начисления.
 *
 * Считаем среднее за три месяца и добавляем половину наблюдаемого тренда:
 * брать чистый тренд слишком оптимистично, брать чистое среднее — слепо.
 * Это оценка, и в интерфейсе она подписана как оценка.
 */
function forecastNext(points: Point[]): number | null {
  if (points.length === 0) return null;
  if (points.length < 3) return points[points.length - 1].value;

  const recent = points.slice(-3).map((p) => p.value);
  const average = recent.reduce((a, b) => a + b, 0) / recent.length;
  const trend = (recent[recent.length - 1] - recent[0]) / (recent.length - 1);

  return Math.max(0, Math.round(average + trend / 2));
}

function buildTips(
  series: { label: string; unit: string; change: number | null }[],
  payments: Point[],
): { title: string; body: string }[] {
  const tips: { title: string; body: string }[] = [];

  for (const s of series) {
    if (s.change !== null && s.change >= 30) {
      tips.push({
        title: `${s.label}: расход вырос на ${s.change}%`,
        body: 'Проверьте, нет ли подтекающего крана или бачка — за месяц это до 3 м³ впустую.',
      });
    }
  }

  if (payments.length >= 2) {
    const change = changePercent(payments);
    if (change !== null && change >= 15) {
      tips.push({
        title: `Начисление выросло на ${change}%`,
        body: 'Сверьте детализацию: рост может быть из-за начала отопительного сезона или перерасчёта.',
      });
    }
  }

  /**
   * Адресат назван прямо. Без него совет читался как «передавайте их нам»,
   * хотя приложение показания только хранит: своего приёма у него нет.
   */
  tips.push({
    title: 'Передайте показания в управляющую компанию',
    body: 'Здесь они только хранятся: своего приёма показаний у приложения нет. ' +
      'Без переданных показаний начисляют по нормативу, и это почти всегда ' +
      'дороже фактического расхода.',
  });

  return tips;
}
