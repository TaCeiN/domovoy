import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  request, requestEvent, requestPhoto, rating, property, userProperty, appUser,
} from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { slaDueAt, slaState, slaLabel } from './sla.ts';
import { notify } from '../notify/index.ts';
import { propertyIdsFor } from '../auth/access.ts';
import { listAttachments } from './attachments.ts';
import { addresseeForProperty, numberScopeFor, type Addressee } from './addressee.ts';
import type { Database } from '../../db/client.ts';

/**
 * Заявки: создание жителем, ведение диспетчером, история изменений.
 *
 * Статусы намеренно шире, чем «принято / в работе / выполнено». В ЖКХ
 * значительная часть обращений упирается в «это не зона ответственности УК»
 * или «нужны уточнения» — без этих состояний диспетчер вынужден врать,
 * закрывая заявку как выполненную.
 */

export const STATUSES = ['new', 'in_work', 'need_info', 'done', 'rejected'] as const;
export type RequestStatus = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<RequestStatus, string> = {
  // Не «принято»: пока УК не взяла заявку, её никто не принимал (аудит 26.09)
  new: 'отправлено',
  in_work: 'в работе',
  need_info: 'нужны уточнения',
  done: 'выполнено',
  rejected: 'отклонено',
};

/**
 * Разрешённые переходы диспетчера. Закрытую он не переоткрывает; вернуть
 * выполненную в работу может только житель — `disputeDone`.
 */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  new: ['in_work', 'need_info', 'rejected'],
  in_work: ['need_info', 'done', 'rejected'],
  need_info: ['in_work', 'rejected'],
  done: [],
  rejected: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface CreateRequestInput {
  userId: string;
  /** Имя жителя — попадёт в историю заявки рядом с его репликами */
  userName?: string;
  propertyId: string;
  kind: 'complaint' | 'master';
  category: string;
  title: string;
  description: string;
  photoUrls?: string[];
  masterSlotStart?: Date;
  masterSlotEnd?: Date;
}

export type CreateResult =
  | { ok: true; id: string; number: number }
  | { ok: false; reason: 'no_access' | 'empty_description' };

/**
 * Что честно написать первой строкой истории обращения.
 *
 * Три случая, три разных правды: заявку прочитает диспетчер, её прочитает
 * совет дома, её пока не прочитает никто — но она записана с датой,
 * и это ядро продукта.
 */
export function firstEventText(who: Addressee): string {
  if (who.kind === 'org') {
    return who.hasCabinet
      ? 'Заявка принята диспетчером'
      : `Обращение записано. У организации «${who.name}» пока нет кабинета в сервисе — `
        + 'запись хранится с датой и станет видна ей, как только кабинет появится';
  }
  if (who.kind === 'chairman') {
    return 'Обращение записано, его увидит совет дома';
  }
  return 'Обращение записано с датой. За домом пока никто не закреплён — '
    + 'запись дождётся того, кто возьмётся за дом';
}

export async function createRequest(
  db: Database,
  input: CreateRequestInput,
): Promise<CreateResult> {
  if (input.description.trim().length < 8) {
    return { ok: false, reason: 'empty_description' };
  }

  /**
   * Жалоба НЕ ЖДЁТ подтверждения председателя.
   *
   * Это ядро продукта: у жителя должно остаться доказательство, что он
   * пожаловался, и оно должно лечь в неудаляемый архив УК. Ставить перед
   * этим чужое одобрение — особенно председателя, которого у дома может
   * не быть вовсе, — значит закрыть продукт на замок.
   *
   * Поэтому здесь достаточно, чтобы человек предъявил квитанцию по этой
   * квартире. Диспетчер увидит пометку «адрес не сверен» и решит сам.
   */
  const access = await db
    .select({ ukId: property.managingOrgId, houseKey: property.houseKey, status: userProperty.status })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(and(
      eq(userProperty.userId, input.userId),
      eq(userProperty.propertyId, input.propertyId),
    ))
    .limit(1);

  if (!access[0] || access[0].status === 'revoked') return { ok: false, reason: 'no_access' };

  const who = await addresseeForProperty(db, input.propertyId);
  const ukId = who.kind === 'org' ? who.orgId : null;
  const scope = numberScopeFor(ukId, access[0].houseKey);

  const id = newId('req');

  /**
   * Номер заявки сквозной в пределах области нумерации — так его называют
   * по телефону. Область — организация либо, если её нет, сам дом
   * (см. `numberScopeFor`).
   *
   * ПОЧЕМУ ТРАНЗАКЦИЯ С БЛОКИРОВКОЙ. Раньше номер считался как
   * `max(number) + 1` отдельным запросом, а потом вставлялся другим.
   * Между ними ничего не мешало второму запросу прочитать тот же максимум:
   * на паре `(number_scope, number)` стоит уникальный индекс, поэтому
   * вторая заявка не портила данные — она ПАДАЛА. Проверено: из пяти
   * одновременных заявок проходили две, три отвечали 500. И это не про
   * толпу жильцов, а про обычный двойной тап по кнопке «Отправить».
   *
   * Консультативная блокировка по области выстраивает нумерацию в очередь,
   * не трогая остальные организации и дома. Заявка и первое событие её
   * истории пишутся одной транзакцией: заявка без строчки «принята»
   * выглядела бы в ленте пустой.
   */
  const number = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope}))`);

    const last = await tx
      .select({ n: sql<number>`coalesce(max(${request.number}), 0)` })
      .from(request)
      .where(eq(request.numberScope, scope));
    const next = Number(last[0]?.n ?? 0) + 1;

    await tx.insert(request).values({
      id,
      number: next,
      propertyId: input.propertyId,
      orgId: ukId,
      numberScope: scope,
      authorId: input.userId,
      kind: input.kind,
      category: input.category,
      title: input.title.slice(0, 120),
      description: input.description,
      status: 'new',
      /**
       * Срок реакции ставим, только когда есть кому реагировать.
       *
       * Это время, за которое адресат обязан ответить. Когда кабинета
       * у организации нет (14 213 домов области из 14 221) или адресата
       * нет вовсе, обязываться некому — а таймер всё равно тикал
       * и через сутки показывал жителю красное «Срок вышел · просрочено».
       * Обвинение выставлялось компании, которая о заявке не знает.
       *
       * `null` здесь — законное значение: `slaState` и `slaLabel`
       * (lib/requests/sla.ts) его умеют, кабинет УК тоже.
       */
      slaDueAt: who.kind === 'org' && who.hasCabinet ? slaDueAt(input.category) : null,
      masterSlotStart: input.masterSlotStart ?? null,
      masterSlotEnd: input.masterSlotEnd ?? null,
    });

    await tx.insert(requestEvent).values({
      id: newId('evt'),
      requestId: id,
      type: 'created',
      /**
       * Первая строка истории обязана быть правдой.
       *
       * «Заявка принята диспетчером» писалась безусловно — в том числе
       * дому, у чьей организации нет кабинета (14 213 домов области
       * из 14 221, измерено 11 сентября) и дому, у которого адресата
       * нет вовсе. Житель читает именно ленту событий, полей карточки
       * он не видит, — и первое же, что он читал, было выдумкой.
       */
      text: firstEventText(who),
      actor: 'system',
      actorName: null,
    });

    for (const url of input.photoUrls ?? []) {
      await tx.insert(requestPhoto).values({ id: newId('pht'), requestId: id, url });
    }

    return next;
  });

  return { ok: true, id, number };
}

export interface ChangeStatusInput {
  requestId: string;
  to: RequestStatus;
  /** Кто меняет: диспетчер или система */
  actor: 'dispatcher' | 'system';
  comment?: string;
  assigneeName?: string;
  rejectReason?: string;
  /** Имя диспетчера: житель должен видеть, с кем он разговаривает */
  actorName?: string;
  /** УК диспетчера — чтобы нельзя было трогать чужие заявки */
  ukId?: string;
}

export type ChangeResult =
  | { ok: true; notified: boolean }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'bad_transition' };

export async function changeStatus(
  db: Database,
  input: ChangeStatusInput,
): Promise<ChangeResult> {
  const rows = await db.select().from(request).where(eq(request.id, input.requestId)).limit(1);
  const current = rows[0];
  if (!current) return { ok: false, reason: 'not_found' };

  if (input.ukId && current.orgId !== input.ukId) {
    return { ok: false, reason: 'forbidden' };
  }
  if (!canTransition(current.status as RequestStatus, input.to)) {
    return { ok: false, reason: 'bad_transition' };
  }

  await db
    .update(request)
    .set({
      status: input.to,
      assigneeName: input.assigneeName ?? current.assigneeName,
      rejectReason: input.to === 'rejected' ? (input.rejectReason ?? null) : current.rejectReason,
      closedAt: input.to === 'done' || input.to === 'rejected' ? new Date() : null,
    })
    .where(eq(request.id, input.requestId));

  /**
   * Факт и слова — двумя событиями (просьба владельца 29.09, «как в Telegram»).
   *
   * Вопрос диспетчера, причина отказа и комментарий склеивались с фактом
   * смены статуса в одну строку и рисовались плашкой по центру — слова
   * человека выглядели системной отметкой. Теперь факт остаётся плашкой,
   * а слова уходят сообщением диспетчера. Уведомление — по-прежнему одной
   * строкой: в мессенджере это одно сообщение.
   */
  const fact = statusFact(input);
  const said = input.actor === 'dispatcher' ? dispatcherWords(input) : null;
  /**
   * Время обоим событиям — явно, с разницей в миллисекунду: порядок не
   * должен зависеть от now() в Postgres. Не секунда, как у ответа жителя:
   * житель, ответивший быстрее секунды, оказался бы «раньше» вопроса,
   * и очередь УК решила бы, что последним писал диспетчер.
   */
  const at = Date.now();

  await db.insert(requestEvent).values({
    id: newId('evt'),
    requestId: input.requestId,
    createdAt: new Date(at),
    type: 'status',
    // Слова диспетчера уходят отдельным сообщением; у системы — как раньше, одной строкой
    text: input.actor === 'dispatcher' ? fact : [fact, input.comment?.trim()].filter(Boolean).join('. '),
    actor: input.actor,
    actorName: input.actorName ?? null,
  });
  if (said) {
    await db.insert(requestEvent).values({
      id: newId('evt'),
      requestId: input.requestId,
      createdAt: new Date(at + 1),
      type: 'comment',
      text: said.slice(0, 2000),
      actor: 'dispatcher',
      actorName: input.actorName ?? null,
    });
  }

  // Уведомление не должно ронять смену статуса
  const result = await notify(db, {
    userId: current.authorId,
    kind: input.to === 'in_work' && input.assigneeName ? 'request_assigned' : 'request_status',
    title: `Заявка № ${String(current.number).padStart(5, '0')}: ${STATUS_LABEL[input.to]}`,
    body: said ? `${fact}. ${said}` : fact,
    deepLinkPayload: `req_${current.number}`,
  }).catch(() => ({ sent: false }));

  return { ok: true, notified: result.sent };
}

/**
 * Факт смены статуса — словами, не только плашкой статуса. «Работы
 * выполнены» не говорило, что заявка ЗАКРЫТА (просьба владельца 27.09):
 * переписку читают глазами, плашку — нет.
 */
function statusFact(input: ChangeStatusInput): string {
  switch (input.to) {
    case 'in_work':
      return input.assigneeName
        ? `Заявка взята в работу, назначен мастер: ${input.assigneeName}`
        : 'Заявка взята в работу';
    case 'need_info':
      return 'Диспетчер запросил уточнения';
    case 'done':
      return 'Заявка закрыта: работы выполнены';
    case 'rejected':
      return 'Заявка закрыта без выполнения';
    default:
      return `Статус изменён на «${STATUS_LABEL[input.to]}»`;
  }
}

/**
 * Что диспетчер сказал жителю: причина отказа и комментарий. Совпадают —
 * один раз; оба есть — через перевод строки. Пусто — сообщения нет.
 */
function dispatcherWords(input: ChangeStatusInput): string | null {
  const reason = input.to === 'rejected' ? input.rejectReason?.trim() : '';
  const comment = input.comment?.trim();
  const parts = [reason, comment && comment !== reason ? comment : ''].filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

/* ─────────────── ответ жителя ─────────────── */

export type CommentResult =
  | { ok: true; status: RequestStatus; reopened: boolean }
  | { ok: false; reason: 'not_found' | 'closed' | 'empty' };

/**
 * Реплика жителя по своей заявке.
 *
 * Без неё статус «нужны уточнения» был тупиком: диспетчер задавал вопрос,
 * а ответить житель мог только звонком в УК — то есть ровно тем способом,
 * от которого приложение должно избавлять.
 *
 * Ответ на вопрос сам возвращает заявку в работу: «ждём жителя» кончилось
 * ровно в этот момент, и заставлять диспетчера переключать статус руками
 * значит держать заявку в неверном состоянии до тех пор, пока он до неё
 * не дойдёт.
 */
export async function addResidentComment(
  db: Database,
  input: { userId: string; userName?: string; requestId: string; text: string },
): Promise<CommentResult> {
  const text = input.text.trim();
  if (text.length < 2) return { ok: false, reason: 'empty' };

  const rows = await db
    .select({ req: request })
    .from(request)
    .where(eq(request.id, input.requestId))
    .limit(1);

  const current = rows[0]?.req;
  if (!current) return { ok: false, reason: 'not_found' };

  // Писать можно только в то обращение, которое человеку и так видно
  const scope = await requestScope(db, input.userId);
  if (!scopeAllows(scope, current, input.userId)) return { ok: false, reason: 'not_found' };

  const status = current.status as RequestStatus;
  if (status === 'done' || status === 'rejected') return { ok: false, reason: 'closed' };

  await db.insert(requestEvent).values({
    id: newId('evt'),
    requestId: current.id,
    type: 'comment',
    text: text.slice(0, 2000),
    actor: 'resident',
    actorName: input.userName ?? null,
  });

  if (status !== 'need_info') return { ok: true, status, reopened: false };

  await db.update(request).set({ status: 'in_work' }).where(eq(request.id, current.id));
  await db.insert(requestEvent).values({
    id: newId('evt'),
    requestId: current.id,
    // Секунда вперёд: два события пишутся разными запросами, и без явного
    // сдвига их порядок в ленте зависит от разрешения now() в Postgres
    createdAt: new Date(Date.now() + 1000),
    type: 'status',
    text: 'Ответ получен — заявка вернулась в работу',
    actor: 'system',
    actorName: null,
  });

  return { ok: true, status: 'in_work', reopened: true };
}

export type DisputeResult =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'not_found' | 'not_done' | 'too_late' };

/** Сколько после закрытия житель может сказать «не решено» */
export const DISPUTE_DAYS = 30;

/**
 * «Проблема не решена» — вернуть выполненную заявку в работу.
 *
 * ЗАЧЕМ. УК жала «Выполнено», и у жителя оставалось только «заведите
 * новую»: срок начинался заново, а прежняя заявка числилась выполненной
 * (аудит 26 сентября). Для жалобы это значит, что закрыть её можно,
 * ничего не сделав. Теперь её возвращает тот, кто её видит, — с
 * объяснением, без которого диспетчер не поймёт, что не так. Срок
 * реакции идёт заново от возврата.
 *
 * Только «выполнено», а не «отклонено»: отказ — это решение с причиной,
 * спорить с ним новой заявкой честнее. И только месяц после закрытия.
 */
export async function disputeDone(
  db: Database,
  input: { userId: string; userName?: string; requestId: string; text: string; now?: Date },
): Promise<DisputeResult> {
  const text = input.text.trim();
  if (text.length < 3) return { ok: false, reason: 'empty' };

  const [current] = await db.select().from(request).where(eq(request.id, input.requestId)).limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  const scope = await requestScope(db, input.userId);
  if (!scopeAllows(scope, current, input.userId)) return { ok: false, reason: 'not_found' };
  if (current.status !== 'done') return { ok: false, reason: 'not_done' };

  const now = input.now ?? new Date();
  if (current.closedAt && now.getTime() - current.closedAt.getTime() > DISPUTE_DAYS * 86_400_000) {
    return { ok: false, reason: 'too_late' };
  }

  await db.update(request)
    .set({
      status: 'in_work',
      closedAt: null,
      slaDueAt: current.slaDueAt ? slaDueAt(current.category, now) : null,
    })
    .where(eq(request.id, current.id));

  await db.insert(requestEvent).values([
    {
      id: newId('evt'), requestId: current.id, type: 'comment',
      text: text.slice(0, 2000), actor: 'resident', actorName: input.userName ?? null,
    },
    {
      id: newId('evt'), requestId: current.id, type: 'status',
      createdAt: new Date(now.getTime() + 1000),
      text: 'Житель: проблема не решена — заявка вернулась в работу',
      actor: 'system', actorName: null,
    },
  ]);

  return { ok: true };
}

/* ─────────────── чтение ─────────────── */

/**
 * Кому какие обращения видны.
 *
 * ОБРАЩЕНИЕ ПРИНАДЛЕЖИТ КВАРТИРЕ, А НЕ ДОМУ. Внутри квартиры его видят
 * все подтверждённые — муж должен видеть заявку жены и дополнять её,
 * иначе диспетчер получает две заявки об одной протечке. Снаружи —
 * никто: соседу переписка с УК не показывается ни при каких условиях.
 *
 * Отдельный случай — НЕПОДТВЕРЖДЁННЫЙ. Он предъявил квитанцию квартиры,
 * и уровень 0 даёт ему завести жалобу: это ядро продукта, ждать
 * председателя ради него нельзя. Но чужие обращения той же квартиры
 * ему не принадлежат — иначе снимок чужой квитанции открывал бы
 * переписку жильцов с управляющей компанией и позволял в неё писать.
 * Поэтому здесь два множества, а не одно.
 */
async function requestScope(db: Database, userId: string) {
  const full = await propertyIdsFor(db, userId, 'full');
  const self = await propertyIdsFor(db, userId, 'self');
  return { full, pending: self.filter((id) => !full.includes(id)) };
}

/** Видно ли человеку конкретное обращение. */
function scopeAllows(
  scope: { full: string[]; pending: string[] },
  row: { propertyId: string; authorId: string | null },
  userId: string,
): boolean {
  if (scope.full.includes(row.propertyId)) return true;
  return scope.pending.includes(row.propertyId) && row.authorId === userId;
}

export async function listForUser(db: Database, userId: string, propertyId?: string) {
  const scope = await requestScope(db, userId);

  /**
   * Сузить до одной квартиры можно только в пределах своего доступа:
   * подставленный чужой `propertyId` не должен ничего открывать.
   */
  if (propertyId) {
    scope.full = scope.full.filter((id) => id === propertyId);
    scope.pending = scope.pending.filter((id) => id === propertyId);
  }

  const conditions = [
    scope.full.length ? inArray(request.propertyId, scope.full) : null,
    scope.pending.length
      ? and(inArray(request.propertyId, scope.pending), eq(request.authorId, userId))
      : null,
  ].filter((c) => c !== null);

  if (conditions.length === 0) return [];

  const rows = await db
    .select()
    .from(request)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .orderBy(desc(request.createdAt));

  return rows.map(decorate);
}

export async function getForUser(db: Database, userId: string, requestId: string) {
  const rows = await db
    .select({ req: request })
    .from(request)
    .where(eq(request.id, requestId))
    .limit(1);

  /**
   * Права считаются по тому же правилу, что и список: привязки к квартире
   * мало, если она не подтверждена, — тогда своим считается только то,
   * что человек завёл сам.
   */
  if (!rows[0]) return null;
  const scope = await requestScope(db, userId);
  if (!scopeAllows(scope, rows[0].req, userId)) return null;

  const events = await db
    .select()
    .from(requestEvent)
    .where(eq(requestEvent.requestId, requestId))
    .orderBy(requestEvent.createdAt);

  const photos = await listAttachments(db, requestId);

  const rated = await db
    .select()
    .from(rating)
    .where(eq(rating.requestId, requestId))
    .limit(1);

  return {
    ...decorate(rows[0].req),
    events: events.map(publicEvent),
    photos,
    rating: rated[0] ? { stars: rated[0].stars, comment: rated[0].comment } : null,
  };
}

/**
 * Последняя реплика человека по каждой заявке.
 *
 * Системные записи («заявка принята», «ответ получен») отфильтрованы:
 * в очереди диспетчеру нужно видеть, кто написал последним — он или
 * житель. Иначе ответ на уточнение теряется среди служебных строк.
 */
async function lastMessages(db: Database, requestIds: string[]) {
  const map = new Map<
    string,
    { text: string; actor: string; actorName: string | null; at: Date | null }
  >();
  if (requestIds.length === 0) return map;

  const rows = await db
    .select()
    .from(requestEvent)
    .where(inArray(requestEvent.requestId, requestIds))
    .orderBy(requestEvent.createdAt);

  for (const e of rows) {
    if (e.actor === 'system') continue;
    map.set(e.requestId, { text: e.text, actor: e.actor, actorName: e.actorName, at: e.createdAt });
  }
  return map;
}

/** Очередь диспетчера: просроченные первыми, дальше по сроку. */
export async function listForDispatcher(db: Database, ukId: string, status?: RequestStatus) {
  const rows = await db
    .select({
      req: request,
      address: property.addressRaw,
      // Разобранные части адреса: диспетчеру в очередь нужны улица и дом,
      // а не индекс с областью. Разбирать строку обратно на клиенте — значит
      // повторять там всю логику normalize.ts, включая ловушки с кириллицей
      street: property.street,
      house: property.house,
      block: property.block,
      flat: property.flat,
      houseKey: property.houseKey,
      authorName: appUser.fullName,
    })
    .from(request)
    .innerJoin(property, eq(request.propertyId, property.id))
    .innerJoin(appUser, eq(request.authorId, appUser.id))
    .where(status ? and(eq(request.orgId, ukId), eq(request.status, status)) : eq(request.orgId, ukId));

  const messages = await lastMessages(db, rows.map((r) => r.req.id));

  return rows
    .map((r) => {
      const lastMessage = messages.get(r.req.id) ?? null;
      const closed = r.req.status === 'done' || r.req.status === 'rejected';
      return {
        ...decorate(r.req),
        address: r.address,
        street: r.street,
        house: r.house,
        block: r.block,
        flat: r.flat,
        houseKey: r.houseKey,
        authorName: r.authorName,
        lastMessage,
        /**
         * Ход за УК: последний ЧЕЛОВЕК в переписке — не диспетчер, а
         * заявка ещё открыта.
         *
         * Раньше проверялось «последним написал житель» — это работало,
         * пока в переписке не завелась третья роль. Ответ председателя
         * («обсудим на собрании») гасил пометку так же, как ответ
         * диспетчера, хотя управляющая компания по-прежнему не ответила.
         * Гасить пометку должен только диспетчер — это единственная
         * роль, чей ответ означает «УК уже высказалась».
         */
        awaitingUk: !closed && lastMessage != null && lastMessage.actor !== 'dispatcher',
      };
    })
    .sort((a, b) => {
      const open = (s: string) => (s === 'done' || s === 'rejected' ? 1 : 0);
      if (open(a.status) !== open(b.status)) return open(a.status) - open(b.status);
      const at = a.slaDueAt?.getTime() ?? Infinity;
      const bt = b.slaDueAt?.getTime() ?? Infinity;
      return at - bt;
    });
}

/**
 * Карточка заявки для диспетчера: то же, что видит житель, плюс контакт.
 *
 * Раньше кабинет рисовал карточку из строки очереди, и переписки в ней
 * не было вовсе: диспетчер не видел ни собственных комментариев, ни
 * ответов жителя — то есть отвечал вслепую на свой же вопрос.
 */
export async function getForDispatcher(db: Database, ukId: string, requestId: string) {
  const rows = await db
    .select({
      req: request,
      address: property.addressRaw,
      street: property.street,
      house: property.house,
      block: property.block,
      flat: property.flat,
      authorName: appUser.fullName,
      authorPhone: appUser.phone,
      authorPhoneVerifiedAt: appUser.phoneVerifiedAt,
      authorMaxChatId: appUser.maxChatId,
    })
    .from(request)
    .innerJoin(property, eq(request.propertyId, property.id))
    .innerJoin(appUser, eq(request.authorId, appUser.id))
    .where(and(eq(request.id, requestId), eq(request.orgId, ukId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const events = await db
    .select()
    .from(requestEvent)
    .where(eq(requestEvent.requestId, requestId))
    .orderBy(requestEvent.createdAt);

  const photos = await listAttachments(db, requestId);

  const rated = await db
    .select()
    .from(rating)
    .where(eq(rating.requestId, requestId))
    .limit(1);

  const status = row.req.status as RequestStatus;
  const lastHuman = [...events].reverse().find((e) => e.actor !== 'system') ?? null;

  return {
    ...decorate(row.req),
    address: row.address,
    street: row.street,
    house: row.house,
    block: row.block,
    flat: row.flat,
    authorName: row.authorName,
    authorPhone: row.authorPhone,
    authorPhoneVerified: Boolean(row.authorPhoneVerifiedAt),
    // Уведомление уходит только тем, кто заходил через мессенджер
    notifiable: row.authorMaxChatId != null,
    allowed: TRANSITIONS[status] ?? [],
    // Та же правка, что и в listForDispatcher: гасит только ответ диспетчера
    awaitingUk: status !== 'done' && status !== 'rejected'
      && lastHuman != null && lastHuman.actor !== 'dispatcher',
    events: events.map(publicEvent),
    photos,
    rating: rated[0] ? { stars: rated[0].stars, comment: rated[0].comment } : null,
  };
}

/* ─────────────── совет дома ─────────────── */

/**
 * Обращения дома глазами председателя — отдельный путь по `houseKey`,
 * а не расширение жительского правила выше.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ПУТЬ. `requestScope`/`scopeAllows` считают доступ
 * по квартирам конкретного человека: подтверждённый видит свою квартиру
 * целиком, неподтверждённый — только своё. У председателя другая роль —
 * он адресат обращений всего дома, а не ещё один житель с расширенными
 * правами на одну квартиру. Раздувать `scopeAllows` условием «или
 * председатель» означало бы смешать два разных вопроса: «что видно
 * жителю» и «что видно совету дома».
 *
 * ВИДНО ВСЁ, ВКЛЮЧАЯ НЕПОДТВЕРЖДЁННЫХ. Председатель — это тот, кто и
 * подтверждает привязку к квартире; ждать его собственного подтверждения,
 * чтобы показать ему же жалобу, бессмысленно. Жалоба неподтверждённого
 * жителя адресована совету дома ровно так же, как и подтверждённого.
 */
export async function listForHouse(db: Database, houseKey: string) {
  const rows = await db
    .select({
      req: request,
      address: property.addressRaw,
      street: property.street,
      house: property.house,
      block: property.block,
      flat: property.flat,
      authorName: appUser.fullName,
    })
    .from(request)
    .innerJoin(property, eq(request.propertyId, property.id))
    .innerJoin(appUser, eq(request.authorId, appUser.id))
    .where(eq(property.houseKey, houseKey))
    .orderBy(desc(request.createdAt));

  const messages = await lastMessages(db, rows.map((r) => r.req.id));

  return rows.map((r) => ({
    ...decorate(r.req),
    address: r.address,
    street: r.street,
    house: r.house,
    block: r.block,
    flat: r.flat,
    authorName: r.authorName,
    lastMessage: messages.get(r.req.id) ?? null,
  }));
}

/**
 * Сколько обращений дома ждут ответа председателя.
 *
 * Только число — карточке на главной и профилю сама переписка не нужна,
 * а прежде вход в раздел «Совет дома» тянул на клиент весь список
 * обращений вместе с последними репликами ради одного этого числа.
 * Считаем на сервере и отдаём только счётчик.
 */
export async function countAwaitingChairman(db: Database, houseKey: string): Promise<number> {
  const rows = await listForHouse(db, houseKey);
  return rows.filter((r) => !r.closed && r.lastMessage?.actor === 'resident').length;
}

/** Карточка обращения для совета дома: переписка и вложения, как у жителя. */
export async function getForHouse(db: Database, houseKey: string, requestId: string) {
  const rows = await db
    .select({
      req: request,
      address: property.addressRaw,
      street: property.street,
      house: property.house,
      block: property.block,
      flat: property.flat,
      authorName: appUser.fullName,
    })
    .from(request)
    .innerJoin(property, eq(request.propertyId, property.id))
    .innerJoin(appUser, eq(request.authorId, appUser.id))
    .where(and(eq(request.id, requestId), eq(property.houseKey, houseKey)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const events = await db
    .select()
    .from(requestEvent)
    .where(eq(requestEvent.requestId, requestId))
    .orderBy(requestEvent.createdAt);

  const photos = await listAttachments(db, requestId);

  const rated = await db
    .select()
    .from(rating)
    .where(eq(rating.requestId, requestId))
    .limit(1);

  return {
    ...decorate(row.req),
    address: row.address,
    street: row.street,
    house: row.house,
    block: row.block,
    flat: row.flat,
    authorName: row.authorName,
    events: events.map(publicEvent),
    photos,
    rating: rated[0] ? { stars: rated[0].stars, comment: rated[0].comment } : null,
  };
}

export type ChairmanCommentResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'closed' | 'empty' };

/**
 * Ответ председателя по обращению дома.
 *
 * НАМЕРЕННО НЕ МЕНЯЕТ СТАТУС И НЕ ВОЗВРАЩАЕТ ЗАЯВКУ В РАБОТУ — в отличие
 * от `addResidentComment`. Статусами распоряжается только диспетчер: это
 * его ответственность за срок и подрядчиков. Совет дома — не диспетчер
 * даже для дома без управляющей компании, он отвечает словами, а не
 * переводит заявку между состояниями.
 */
export async function addChairmanComment(
  db: Database,
  input: { houseKey: string; chairmanName: string; requestId: string; text: string },
): Promise<ChairmanCommentResult> {
  const text = input.text.trim();
  if (text.length < 2) return { ok: false, reason: 'empty' };

  const rows = await db
    .select({ req: request })
    .from(request)
    .innerJoin(property, eq(request.propertyId, property.id))
    .where(and(eq(request.id, input.requestId), eq(property.houseKey, input.houseKey)))
    .limit(1);

  const current = rows[0]?.req;
  if (!current) return { ok: false, reason: 'not_found' };

  const status = current.status as RequestStatus;
  if (status === 'done' || status === 'rejected') return { ok: false, reason: 'closed' };

  await db.insert(requestEvent).values({
    id: newId('evt'),
    requestId: current.id,
    type: 'comment',
    text: text.slice(0, 2000),
    actor: 'chairman',
    actorName: input.chairmanName,
  });

  return { ok: true };
}

export type DispatcherCommentResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'closed' | 'empty' };

/**
 * Реплика диспетчера без смены статуса — строка ввода в чате кабинета УК.
 *
 * Раньше написать жителю можно было только вместе со сменой статуса:
 * «Мастер будет завтра» требовало выбрать статус, в котором заявка уже
 * стоит. Статус здесь не трогаем — им диспетчер распоряжается кнопками.
 */
export async function addDispatcherComment(
  db: Database,
  input: { ukId: string; dispatcherName: string; requestId: string; text: string },
): Promise<DispatcherCommentResult> {
  const text = input.text.trim();
  if (text.length < 2) return { ok: false, reason: 'empty' };

  const [current] = await db.select().from(request).where(eq(request.id, input.requestId)).limit(1);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.orgId !== input.ukId) return { ok: false, reason: 'forbidden' };
  if (current.status === 'done' || current.status === 'rejected') return { ok: false, reason: 'closed' };

  await db.insert(requestEvent).values({
    id: newId('evt'),
    requestId: current.id,
    type: 'comment',
    text: text.slice(0, 2000),
    actor: 'dispatcher',
    actorName: input.dispatcherName,
  });

  // Уведомление не должно ронять само сообщение
  await notify(db, {
    userId: current.authorId,
    kind: 'request_status',
    title: `Заявка № ${String(current.number).padStart(5, '0')}: сообщение от УК`,
    body: text.slice(0, 500),
    deepLinkPayload: `req_${current.number}`,
  }).catch(() => ({ sent: false }));

  return { ok: true };
}

export async function rateRequest(
  db: Database,
  userId: string,
  requestId: string,
  stars: number,
  comment?: string,
): Promise<boolean> {
  /**
   * Целое от одного до пяти — и проверка именно на целое.
   *
   * `stars < 1 || stars > 5` пропускала NaN: он не меньше единицы и не
   * больше пятёрки, оба сравнения дают false. Запрос без поля `stars`
   * доходил до вставки и падал в базе на колонке integer, а житель
   * видел «Что-то пошло не так» вместо «оценка от 1 до 5». Дробная
   * оценка падала там же и по той же причине.
   */
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return false;

  const found = await getForUser(db, userId, requestId);
  // Оценивать можно только выполненную заявку — иначе оценка ни о чём
  if (!found || found.status !== 'done') return false;

  await db
    .insert(rating)
    .values({ id: newId('rat'), requestId, stars, comment: comment ?? null })
    .onConflictDoUpdate({
      target: rating.requestId,
      set: { stars, comment: comment ?? null },
    });
  return true;
}

function publicEvent(e: typeof requestEvent.$inferSelect) {
  return { text: e.text, actor: e.actor, actorName: e.actorName, type: e.type, at: e.createdAt };
}

function decorate(r: typeof request.$inferSelect) {
  const status = r.status as RequestStatus;
  return {
    ...r,
    statusLabel: STATUS_LABEL[status] ?? r.status,
    sla: slaState(r.slaDueAt, r.category),
    slaLabel: r.closedAt ? 'закрыта' : slaLabel(r.slaDueAt),
    closed: status === 'done' || status === 'rejected',
    // Ход за жителем: пока он не ответит, заявка не двинется
    awaitingResident: status === 'need_info',
  };
}

/**
 * Кабинет у организации появился — у её открытых заявок стартует срок.
 *
 * Срок реакции ставится, только когда есть кому реагировать (см.
 * `createRequest`). Но заявки, поданные ДО подключения, так и оставались
 * «без срока» навсегда: аудит 26 сентября нашёл аварию «течёт стояк»,
 * которая у диспетчера висела без срока, хотя жителю форма обещала
 * два часа. Срок считаем от подключения, а не от подачи: до него
 * организация о заявке не знала, и обвинять её в просрочке не за что.
 */
export async function startClockForOrg(db: Database, orgId: string, now = new Date()): Promise<number> {
  const open = await db
    .select({ id: request.id, category: request.category })
    .from(request)
    .where(and(
      eq(request.orgId, orgId),
      isNull(request.slaDueAt),
      isNull(request.closedAt),
    ));

  for (const r of open) {
    await db.update(request)
      .set({ slaDueAt: slaDueAt(r.category, now) })
      .where(eq(request.id, r.id));
  }
  return open.length;
}
