import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  account, appUser, bill, meter, meterReading, property, uk, userProperty,
} from '../../db/schema.ts';
import { dueDateFor } from '../bills/service.ts';
import { METER_LABEL, METER_UNIT, currentPeriod, type MeterKind } from '../meters/service.ts';
import type { Database } from '../../db/client.ts';

/**
 * Сводка по дому для председателя совета.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ — это не техническое решение, а юридическое.
 *
 * ОПЛАТА ПОКВАРТИРНО, БЕЗ ИМЁН. «Кв. 27 не оплачена» — этого хватает,
 * чтобы поговорить с должником на собрании. Пофамильный список долгов
 * не нужен: оператор персональных данных — управляющая компания,
 * а председатель постороннее физлицо, и права на биллинг у совета дома
 * по ЖК РФ нет. Поквартирная разбивка снимает бо́льшую часть риска —
 * но не весь: в доме на сорок квартир номер косвенно указывает на семью.
 * Размен осознанный.
 *
 * СОСТАВ ЖИЛЬЦОВ ВИДЕН. Здесь никакой новой утечки: человек сам называет
 * председателю имя и квартиру в заявке на доступ — иначе тот не смог бы
 * его подтвердить. Показывать то же имя дальше ничего не добавляет.
 *
 * ЛИЦЕВЫЕ СЧЕТА ВИДНЫ. Это номер договора с ресурсником, а не тайна:
 * он напечатан на квитанции, которая лежит в почтовом ящике.
 */

export type PaymentState = 'paid' | 'due' | 'overdue' | 'unknown';

export interface FlatOverview {
  propertyId: string;
  flat: string;
  address: string;
  /** Кто живёт: имя из заявки, потому что в MAX фамилии часто нет */
  residents: { name: string; role: string; viaMax: boolean }[];
  /** Номера лицевых счетов и кому платят */
  accounts: { persAcc: string; service: string; provider: string }[];
  /** Оплата за последний период, по которому вообще есть начисления */
  payment: {
    state: PaymentState;
    period: string | null;
    /** Сколько квитанций за период отмечено оплаченными из скольких */
    paidCount: number;
    totalCount: number;
  };
  /** Показания: что передано за текущий период, где просрочена поверка */
  meters: {
    kind: string;
    label: string;
    unit: string;
    lastValue: string | null;
    lastPeriod: string | null;
    submittedThisPeriod: boolean;
  }[];
}

export interface HouseOverview {
  houseKey: string;
  address: string;
  flats: FlatOverview[];
  totals: {
    flats: number;
    /** Сколько квартир вообще пришло в приложение */
    registered: number;
    paid: number;
    /**
     * Начисление есть, отметки нет, срок ещё не вышел.
     *
     * Без этой графы сумма плиток не сходилась с числом квартир,
     * и председатель считал разницу должниками: на доме в 60 квартир
     * «42 оплачено, 0 просрочено» оставляло 18 квартир необъяснёнными.
     */
    due: number;
    overdue: number;
    /** Начислений нет — сказать «не оплачено» про такую квартиру нельзя */
    unknown: number;
    metersSubmitted: number;
  };
  period: string;
  /**
   * Оговорка едет вместе с числами.
   *
   * Прошёл платёж или нет, приложение не знает: в квитанции этого нет,
   * а доступа к биллингу УК у нас тоже нет. Показано то, что жители
   * отметили сами. Если оставить это на усмотрение вёрстки, оговорка
   * однажды потеряется, и председатель пойдёт разговаривать с человеком,
   * который на самом деле заплатил.
   */
  disclaimer: string;
}

export async function houseOverview(db: Database, houseKey: string): Promise<HouseOverview> {
  const flats = await db
    .select({
      id: property.id,
      flat: property.flat,
      addressRaw: property.addressRaw,
    })
    .from(property)
    .where(eq(property.houseKey, houseKey))
    .orderBy(property.flat);

  if (flats.length === 0) {
    return {
      houseKey,
      address: '',
      flats: [],
      totals: {
        flats: 0, registered: 0, paid: 0, due: 0, overdue: 0, unknown: 0,
        metersSubmitted: 0,
      },
      period: currentPeriod(),
      disclaimer: DISCLAIMER,
    };
  }

  const ids = flats.map((f) => f.id);

  /* ── жильцы ─────────────────────────────────────────────── */

  const residents = await db
    .select({
      propertyId: userProperty.propertyId,
      name: appUser.fullName,
      claimName: userProperty.claimName,
      role: userProperty.role,
      maxUserId: appUser.maxUserId,
    })
    .from(userProperty)
    .innerJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(and(inArray(userProperty.propertyId, ids), eq(userProperty.status, 'active')));

  /* ── лицевые счета ──────────────────────────────────────── */

  const accounts = await db
    .select({
      propertyId: account.propertyId,
      persAcc: account.persAcc,
      service: account.service,
      provider: uk.name,
    })
    .from(account)
    .innerJoin(uk, eq(account.ukId, uk.id))
    .where(inArray(account.propertyId, ids));

  /* ── начисления ─────────────────────────────────────────── */

  const bills = await db
    .select()
    .from(bill)
    .where(inArray(bill.propertyId, ids))
    .orderBy(desc(bill.period));

  /* ── счётчики и показания ───────────────────────────────── */

  const meters = await db
    .select()
    .from(meter)
    .where(inArray(meter.propertyId, ids));

  const readings = meters.length === 0 ? [] : await db
    .select()
    .from(meterReading)
    .where(inArray(meterReading.meterId, meters.map((m) => m.id)))
    .orderBy(desc(meterReading.period));

  /* ── сборка ─────────────────────────────────────────────── */

  const now = new Date();
  const period = currentPeriod(now);

  const result: FlatOverview[] = flats.map((f) => {
    const flatBills = bills.filter((b) => b.propertyId === f.id);
    const lastPeriod = flatBills[0]?.period ?? null;
    const forPeriod = flatBills.filter((b) => b.period === lastPeriod);
    const paidCount = forPeriod.filter((b) => b.paidAt !== null).length;

    /**
     * Состояние оплаты за последний известный период.
     *
     * `unknown` — не «не заплатил», а «начислений мы не видели». Разница
     * принципиальная: сказать человеку «вы должник», не имея его квитанции,
     * значит обвинить наугад.
     */
    let state: PaymentState = 'unknown';
    if (lastPeriod) {
      if (paidCount === forPeriod.length) state = 'paid';
      else state = dueDateFor(lastPeriod).getTime() < now.getTime() ? 'overdue' : 'due';
    }

    const flatMeters = meters.filter((m) => m.propertyId === f.id).map((m) => {
      const mine = readings.filter((r) => r.meterId === m.id);
      const kind = m.kind as MeterKind;
      return {
        kind: m.kind,
        label: METER_LABEL[kind] ?? m.kind,
        unit: METER_UNIT[kind] ?? '',
        lastValue: mine[0]?.value ?? null,
        lastPeriod: mine[0]?.period ?? null,
        submittedThisPeriod: mine.some((r) => r.period === period),
      };
    });

    return {
      propertyId: f.id,
      flat: f.flat,
      address: f.addressRaw,
      residents: residents
        .filter((r) => r.propertyId === f.id)
        .map((r) => ({
          name: r.claimName?.trim() || r.name,
          role: r.role,
          viaMax: r.maxUserId !== null,
        })),
      accounts: accounts
        .filter((a) => a.propertyId === f.id)
        .map((a) => ({ persAcc: a.persAcc, service: a.service, provider: a.provider })),
      payment: {
        state,
        period: lastPeriod,
        paidCount,
        totalCount: forPeriod.length,
      },
      meters: flatMeters,
    };
  });

  /**
   * Порядок по номеру квартиры, а не по строке.
   *
   * Квартиры бывают «15а» и «4/1»: `Number` на них даёт NaN, компаратор
   * возвращает NaN, и порядок становится неопределённым — председатель
   * ищет квартиру глазами в перемешанном списке.
   */
  const order = (flat: string) => {
    const match = /^(\d+)(.*)$/.exec(flat.trim());
    return match
      ? { n: Number(match[1]), rest: match[2] }
      : { n: Number.MAX_SAFE_INTEGER, rest: flat };
  };
  result.sort((a, b) => {
    const left = order(a.flat);
    const right = order(b.flat);
    return left.n - right.n || left.rest.localeCompare(right.rest, 'ru');
  });

  return {
    houseKey,
    address: (flats[0].addressRaw ?? '').replace(/,\s*кв\.?\s*[^,]+$/i, ''),
    flats: result,
    totals: {
      flats: result.length,
      registered: result.filter((f) => f.residents.length > 0).length,
      paid: result.filter((f) => f.payment.state === 'paid').length,
      due: result.filter((f) => f.payment.state === 'due').length,
      overdue: result.filter((f) => f.payment.state === 'overdue').length,
      unknown: result.filter((f) => f.payment.state === 'unknown').length,
      metersSubmitted: result.filter((f) => f.meters.some((m) => m.submittedThisPeriod)).length,
    },
    period,
    disclaimer: DISCLAIMER,
  };
}

const DISCLAIMER =
  'Отметки об оплате ставят сами жители: прошёл платёж или нет, приложение '
  + 'не знает — в квитанции этого нет, а доступа к базе управляющей компании '
  + 'тоже. «Не оплачено» здесь означает «житель не отметил», а не «должник». '
  + 'Показания жители записывают здесь для себя, а передают их в управляющую '
  + 'компанию сами: «нет записи» не значит «не передал».';
