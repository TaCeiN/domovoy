import { and, desc, eq } from 'drizzle-orm';
import { bill, property, userProperty, account, uk } from '../../db/schema.ts';
import { formatKopecks } from '../qr/receipt.ts';
import { accessLevel, canSeeOwn } from '../auth/access.ts';
import { broughtBy, isBringer } from './bringers.ts';
import type { Database } from '../../db/client.ts';

/**
 * Начисления и задолженность.
 *
 * ЧЕГО МЫ НЕ ЗНАЕМ — и это главное в этом файле.
 *
 * Прошёл платёж или нет, приложение выяснить не может. В платёжном QR по
 * ГОСТ Р 56042-2014 есть поле Sum — сумма к оплате на момент печати — и
 * больше ничего про оплату. Статус платежа живёт в трёх местах, и ни к
 * одному у нас нет доступа: биллинг управляющей компании, ГИС ЖКХ (туда
 * пускают только официальных участников) и банк-эквайер.
 *
 * Поэтому единственный честный источник — отметка самого жителя. Из этого
 * следуют два правила, которые нельзя нарушать в интерфейсе:
 *   1. Никогда не писать «оплачено» как факт — только «отмечено вами».
 *   2. Никогда не называть расчётную разницу «задолженностью перед УК» —
 *      это оценка по нашим данным, и настоящий долг может отличаться.
 *
 * Нарушение любого из них превращает подсказку в дезинформацию о деньгах:
 * человек решит, что долгов нет, и получит пени.
 */

/** До какого числа следующего месяца обычно ждут оплату. */
export const PAYMENT_DUE_DAY = 10;

export type BillStatus = 'paid' | 'due' | 'overdue';

export interface BillView {
  id: string;
  /** Кому платим: у квартиры несколько получателей, и суммы у них разные */
  provider: string;
  service: string;
  serviceLabel: string;
  period: string;
  periodLabel: string;
  sumKopecks: number;
  sum: string;
  status: BillStatus;
  statusLabel: string;
  paidAt: Date | null;
  paidKopecks: number | null;
  /** Кто поставил отметку: пока всегда житель */
  paidSource: string | null;
  /**
   * Можно ли отдать QR этой квитанции для оплаты в банке.
   * Только тому, кто сам её принёс: в строке QR фамилия и адрес плательщика.
   */
  hasQr: boolean;
  dueDate: Date;
}

const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export function periodLabel(period: string): string {
  const [year, month] = period.split('-');
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : period;
}

/** Крайний срок: обычно десятое число месяца, следующего за расчётным. */
export function dueDateFor(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  // Месяц в Date считается с нуля, поэтому просто month даёт следующий
  return new Date(Date.UTC(year, month, PAYMENT_DUE_DAY, 23, 59, 59));
}

/** Человеческие названия услуг: житель не обязан знать наши коды. */
export const SERVICE_LABEL: Record<string, string> = {
  housing: 'ЖКУ',
  electricity: 'Электроэнергия',
  gas: 'Газ',
  water: 'Вода',
  heat: 'Отопление',
  waste: 'Вывоз мусора',
  overhaul: 'Капремонт',
  other: 'Прочее',
};

export function statusOf(row: typeof bill.$inferSelect, now = new Date()): BillStatus {
  if (row.paidAt) return 'paid';
  return dueDateFor(row.period).getTime() < now.getTime() ? 'overdue' : 'due';
}

const STATUS_LABEL: Record<BillStatus, string> = {
  paid: 'отмечено оплаченным',
  due: 'к оплате',
  overdue: 'срок прошёл',
};

/**
 * Свои начисления видны и до подтверждения председателем: это квитанции,
 * которые человек сам и принёс. См. lib/auth/access.ts.
 */
const hasAccess = canSeeOwn;

/**
 * Насколько широко человеку открыт объект по деньгам.
 *
 * 'own'  — только начисления, которые он принёс сам (уровень 0);
 * 'all'  — все начисления квартиры (подтверждённый жилец);
 * null   — доступа нет вовсе.
 *
 * ЗАЧЕМ РАЗДЕЛЕНИЕ. `canSeeOwn` проверяет доступ к ОБЪЕКТУ, а начисления
 * принадлежат лицевому счёту, и счетов у объекта много. Обычно это одно
 * и то же: у квартиры свой объект, и все её счета — её. Но когда адрес
 * в квитанции напечатан без номера квартиры, `property.flat` пуста,
 * а объект уникален парой `(houseKey, flat)` — и весь дом складывается
 * в ОДИН объект.
 *
 * Аудит 11 сентября воспроизвёл это на живом стенде: три человека,
 * три лицевых счёта, все неподтверждённые; третий видел на главной
 * 17 070 ₽ вместо своих 7 770 и отметил чужое начисление на 4 100 ₽
 * оплаченным, получив код 200.
 *
 * Само слияние объектов — вопрос модели данных и отдельной работы.
 * Здесь закрыто то, что решения не требует: пока человека не подтвердил
 * живой человек, ему открыто РОВНО то, что он принёс. Ровно это обещает
 * комментарий к `accessLevel` в lib/auth/access.ts.
 */
async function moneyScope(
  db: Database,
  userId: string,
  propertyId: string,
): Promise<'own' | 'all' | null> {
  const level = await accessLevel(db, userId, propertyId);
  if (level === 'none') return null;
  return level === 'full' ? 'all' : 'own';
}

export interface BillsSummary {
  bills: BillView[];
  /** Сумма непогашенных начислений ПО НАШИМ ДАННЫМ */
  outstandingKopecks: number;
  outstanding: string;
  overdueCount: number;
  /**
   * Оговорка едет вместе с числами.
   *
   * Если оставить её на усмотрение вёрстки, она однажды потеряется —
   * и приложение начнёт утверждать про чужие деньги то, чего не знает.
   */
  disclaimer: string;
}

export async function listBills(
  db: Database,
  userId: string,
  propertyId: string,
  now = new Date(),
): Promise<BillsSummary | null> {
  const scope = await moneyScope(db, userId, propertyId);
  if (!scope) return null;

  /**
   * У квартиры несколько лицевых счетов: ЖКУ, свет, газ, вывоз мусора.
   * Начисления за один месяц приходят от разных организаций, и без имени
   * поставщика список выглядит как несколько одинаковых сумм подряд.
   *
   * До подтверждения список сужен до принесённого самим человеком —
   * см. moneyScope.
   */
  const rows = await db
    .select({ row: bill, provider: uk.name, service: account.service })
    .from(bill)
    .innerJoin(account, eq(bill.accountId, account.id))
    .innerJoin(uk, eq(account.ukId, uk.id))
    .where(scope === 'all'
      ? eq(bill.propertyId, propertyId)
      : and(eq(bill.propertyId, propertyId), broughtBy(userId)))
    .orderBy(desc(bill.period));

  /** QR картинкой — только тому, кто сам держал эту бумагу */
  const own = new Set<string>();
  for (const { row: r } of rows) {
    if (r.rawQr && await isBringer(db, r, userId)) own.add(r.id);
  }

  const bills: BillView[] = rows.map(({ row: r, provider, service }) => {
    const status = statusOf(r, now);
    return {
      id: r.id,
      provider,
      service,
      serviceLabel: SERVICE_LABEL[service] ?? 'Прочее',
      period: r.period,
      periodLabel: periodLabel(r.period),
      sumKopecks: r.sumKopecks,
      sum: formatKopecks(r.sumKopecks),
      status,
      statusLabel: STATUS_LABEL[status],
      paidAt: r.paidAt,
      paidKopecks: r.paidKopecks,
      paidSource: r.paidSource,
      hasQr: own.has(r.id),
      dueDate: dueDateFor(r.period),
    };
  });

  const unpaid = bills.filter((b) => b.status !== 'paid');
  const outstandingKopecks = unpaid.reduce((sum, b) => sum + b.sumKopecks, 0);

  return {
    bills,
    outstandingKopecks,
    outstanding: formatKopecks(outstandingKopecks),
    overdueCount: bills.filter((b) => b.status === 'overdue').length,
    disclaimer:
      'Приложение не знает, прошёл ли платёж: в квитанции такой информации нет, '
      + 'а к базе управляющей компании доступа у нас нет. Показано то, что вы '
      + 'отметили сами. Точную задолженность смотрите в квитанции или у УК.',
  };
}

export type MarkResult =
  | { ok: true; status: BillStatus }
  | { ok: false; reason: 'not_found' | 'no_access' | 'bad_amount' };

/**
 * Отметить начисление оплаченным — или снять отметку.
 *
 * Сумму разрешаем указать свою: жители платят частями, и подгонять
 * реальность под наши ожидания значит делать отметку бесполезной.
 */
export type BillQrResult =
  | { ok: true; raw: string; fileName: string }
  | { ok: false; reason: 'not_found' | 'no_access' | 'no_qr' };

/**
 * Строка QR квитанции — для картинки, которую житель сохранит и оплатит
 * в банке.
 *
 * Строже, чем чтение начислений: строки без автора (старые, до поля
 * `created_by`) не отдаются. В QR фамилия и адрес плательщика, и
 * приписать такую строку человеку, не видевшему бумагу, нельзя.
 */
export async function billQr(db: Database, userId: string, billId: string): Promise<BillQrResult> {
  const rows = await db
    .select({ row: bill })
    .from(bill)
    .where(eq(bill.id, billId))
    .limit(1);

  const found = rows[0]?.row;
  if (!found) return { ok: false, reason: 'not_found' };
  if (!(await moneyScope(db, userId, found.propertyId)) || !(await isBringer(db, found, userId))) {
    return { ok: false, reason: 'no_access' };
  }
  if (!found.rawQr) return { ok: false, reason: 'no_qr' };
  return { ok: true, raw: found.rawQr, fileName: `kvitanciya-${found.period}.png` };
}

/** Строка QR по одному id — для картинки по подписанной ссылке, где сессии нет */
export async function rawQrOf(db: Database, billId: string): Promise<string | null> {
  const rows = await db.select({ rawQr: bill.rawQr }).from(bill).where(eq(bill.id, billId)).limit(1);
  return rows[0]?.rawQr ?? null;
}

export async function markPaid(
  db: Database,
  userId: string,
  billId: string,
  input: { paid: boolean; kopecks?: number; at?: Date } = { paid: true },
): Promise<MarkResult> {
  const rows = await db
    .select({ row: bill, propertyId: property.id })
    .from(bill)
    .innerJoin(property, eq(bill.propertyId, property.id))
    .where(eq(bill.id, billId))
    .limit(1);

  if (!rows[0]) return { ok: false, reason: 'not_found' };

  /**
   * Отметка об оплате — это ЗАПИСЬ в чужие деньги, если начисление чужое.
   *
   * Проверка стояла та же, что на чтение, — доступ к объекту, — и при
   * слипшемся объекте (адрес без номера квартиры) неподтверждённый человек
   * отмечал соседское начисление оплаченным с кодом 200. Воспроизведено
   * на живом стенде 11 сентября: 4 100 ₽ чужих.
   */
  const scope = await moneyScope(db, userId, rows[0].propertyId);
  if (!scope) return { ok: false, reason: 'no_access' };
  if (scope === 'own'
    && rows[0].row.createdBy !== null
    && !(await isBringer(db, rows[0].row, userId))) {
    return { ok: false, reason: 'no_access' };
  }

  if (!input.paid) {
    await db
      .update(bill)
      .set({ paidAt: null, paidKopecks: null, paidSource: null })
      .where(eq(bill.id, billId));
    return { ok: true, status: statusOf({ ...rows[0].row, paidAt: null }) };
  }

  const kopecks = input.kopecks ?? rows[0].row.sumKopecks;
  if (!Number.isFinite(kopecks) || kopecks <= 0) return { ok: false, reason: 'bad_amount' };

  const paidAt = input.at ?? new Date();
  await db
    .update(bill)
    .set({ paidAt, paidKopecks: Math.round(kopecks), paidSource: 'resident' })
    .where(eq(bill.id, billId));

  return { ok: true, status: 'paid' };
}
