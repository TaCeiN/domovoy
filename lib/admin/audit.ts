import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { admin, adminAction, house, property } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { Database } from '../../db/client.ts';

/**
 * Журнал действий оператора.
 *
 * ОДНА ФУНКЦИЯ ЗАПИСИ на весь кабинет. Соблазн написать `insert` прямо
 * в маршруте велик, и однажды его напишут без записи в журнал — а журнал
 * с дырой хуже отсутствующего: он выглядит полным, и по нему делают
 * выводы.
 *
 * ЗАЧЕМ ОН ВООБЩЕ. У оператора есть право, которого нет ни у кого: снять
 * председателя, закрыть жителю доступ, поменять форму дома. Продукт при
 * этом стоит на доверии к записям — жалобу нельзя стереть. Без журнала
 * на вопрос «кто снял меня с должности» ответить нечем.
 */

export interface RecordActionInput {
  adminId: string;
  /** Машинное имя: 'chairman.create', 'house.form', 'binding.revoke' */
  action: string;
  targetKind: string;
  targetId: string;
  /**
   * Человекочитаемая строка по-русски — её и читают в журнале.
   *
   * Машинное имя годится для фильтра, но не для ответа на вопрос
   * «что здесь произошло», а отвечать на него будут через полгода.
   */
  summary: string;
  payload?: unknown;
}

export interface AuditRow {
  id: string;
  adminName: string;
  action: string;
  targetKind: string;
  targetId: string;
  /**
   * Над чем человеческими словами: адрес дома вместо ключа.
   *
   * Ключ (`556537cdc144…`) занимал половину ширины таблицы и не опознаётся
   * никем: оператор разбирает спор про конкретный дом, а адрес лежит
   * в базе рядом. Когда адреса нет нигде, здесь остаётся сам ключ —
   * врать про адрес нельзя, а запись обязана оставаться читаемой.
   */
  targetLabel: string;
  summary: string;
  createdAt: Date;
}

export async function recordAction(db: Database, input: RecordActionInput): Promise<void> {
  await db.insert(adminAction).values({
    id: newId('aac'),
    adminId: input.adminId,
    action: input.action,
    targetKind: input.targetKind,
    targetId: input.targetId,
    summary: input.summary,
    payload: input.payload ?? null,
  });
}

export const AUDIT_PAGE_SIZE = 50;

export interface AuditQuery {
  page?: number;
  /** 'ГГГГ-ММ-ДД' включительно */
  from?: string;
  /** 'ГГГГ-ММ-ДД' включительно: день считается целиком */
  to?: string;
  /** Машинное имя действия: 'chairman.create', 'house.form', … */
  action?: string;
}

/** Действие для фильтра: машинное имя и человеческая строка к нему. */
export interface AuditActionOption {
  action: string;
  label: string;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Чем можно фильтровать — по тому, что в журнале есть.
   *
   * Список не пишется руками: новое действие появится в фильтре само,
   * и никто не забудет его дописать.
   */
  actions: AuditActionOption[];
}

/**
 * Полночь названного дня или ничего.
 *
 * Даты приходят из адресной строки кабинета, и неразобранная дата
 * означает «фильтра нет», а не ошибку: журнал — последнее место,
 * где уместно падение, по нему разбирают как раз тогда, когда всё
 * остальное уже пошло не так.
 */
function dayStart(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Страница журнала: свежие первыми — разбирают всегда последнее.
 *
 * СТРАНИЦЫ, А НЕ ПОТОЛОК. Раньше отдавались 200 последних записей,
 * и всё, что старше, было недостижимо из кабинета вообще. Журнал
 * заведён ради разбора спора через полгода — то есть ответа в нём
 * не было ровно к тому сроку, ради которого он существует.
 *
 * Приём взят из раздела «База» (lib/admin/tables.ts): страница,
 * общее число и размер страницы в одном ответе.
 */
export async function listActions(db: Database, opts: AuditQuery = {}): Promise<AuditPage> {
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));

  const from = dayStart(opts.from);
  const to = dayStart(opts.to);
  // Верхняя граница — начало СЛЕДУЮЩЕГО дня: иначе «по 15 июля»
  // отрезало бы всё, что произошло 15 июля после полуночи
  const before = to === null ? null : new Date(to.getTime() + 24 * 60 * 60 * 1000);

  const action = (opts.action ?? '').trim();

  const conditions = [
    from === null ? undefined : gte(adminAction.createdAt, from),
    before === null ? undefined : lt(adminAction.createdAt, before),
    action ? eq(adminAction.action, action) : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length ? and(...conditions) : undefined;

  const found = await db
    .select({
      id: adminAction.id,
      adminName: admin.name,
      action: adminAction.action,
      targetKind: adminAction.targetKind,
      targetId: adminAction.targetId,
      summary: adminAction.summary,
      createdAt: adminAction.createdAt,
    })
    .from(adminAction)
    .innerJoin(admin, eq(adminAction.adminId, admin.id))
    .where(where)
    .orderBy(desc(adminAction.createdAt), desc(adminAction.id))
    .limit(AUDIT_PAGE_SIZE)
    .offset((page - 1) * AUDIT_PAGE_SIZE);

  // Счётчик считается по ТОМУ ЖЕ условию: иначе номер последней
  // страницы соврёт, и часть записей окажется за её пределами
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adminAction)
    .where(where);

  /**
   * Список действий для фильтра — из всего журнала, а не из страницы:
   * иначе выбранное действие пропадало бы из списка вместе с записями,
   * которые оно же и отфильтровало.
   */
  const actions = await db
    .selectDistinctOn([adminAction.action], {
      action: adminAction.action,
      label: adminAction.summary,
    })
    .from(adminAction)
    .orderBy(adminAction.action, desc(adminAction.createdAt));

  return {
    rows: await withTargetLabels(db, found),
    total: Number(counted?.n ?? 0),
    page,
    pageSize: AUDIT_PAGE_SIZE,
    actions,
  };
}

/**
 * Подставить адреса домов вместо ключей.
 *
 * Одним запросом на страницу, а не по строке: полсотни записей про один
 * дом иначе дали бы полсотни одинаковых походов в базу.
 */
async function withTargetLabels(
  db: Database,
  rows: Omit<AuditRow, 'targetLabel'>[],
): Promise<AuditRow[]> {
  const houseKeys = [...new Set(
    rows.filter((r) => r.targetKind === 'house').map((r) => r.targetId),
  )];
  if (houseKeys.length === 0) {
    return rows.map((r) => ({ ...r, targetLabel: r.targetId }));
  }

  const byKey = new Map<string, string>();

  // Сначала объекты жителей: их адрес человек и называет в разговоре
  const fromProperties = await db
    .select({ houseKey: property.houseKey, addressRaw: sql<string>`min(${property.addressRaw})` })
    .from(property)
    .where(inArray(property.houseKey, houseKeys))
    .groupBy(property.houseKey);
  for (const row of fromProperties) {
    byKey.set(row.houseKey, withoutFlat(row.addressRaw));
  }

  // Дом, куда ещё никто не заходил, известен только реестру
  const fromRegistry = await db
    .select({ houseKey: house.houseKey, addressRaw: house.addressRaw })
    .from(house)
    .where(inArray(house.houseKey, houseKeys));
  for (const row of fromRegistry) {
    if (row.addressRaw && !byKey.has(row.houseKey)) byKey.set(row.houseKey, withoutFlat(row.addressRaw));
  }

  return rows.map((r) => ({
    ...r,
    targetLabel: r.targetKind === 'house'
      ? byKey.get(r.targetId) ?? r.targetId
      : r.targetId,
  }));
}

/** Запись про дом целиком: квартира в подписи только сбивает. */
function withoutFlat(address: string): string {
  return address.replace(/,\s*кв\.?\s*[^,]+$/i, '');
}
