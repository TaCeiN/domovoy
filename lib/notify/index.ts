import { and, desc, eq, sql } from 'drizzle-orm';
import { appUser, notification } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { allowsKind } from './prefs.ts';
import { MaxBot, deepLink } from '../max/bot-api.ts';
import type { Database } from '../../db/client.ts';

/**
 * Уведомления жителям.
 *
 * Транспорт спрятан за абстракцией намеренно. Сейчас основной канал —
 * сообщения бота MAX: они доходят на всех платформах, в отличие от веб-пушей,
 * которые на iOS работают только из установленной PWA. Но привязываться
 * к одной платформе нельзя, поэтому выбор канала — одна ветка в одном месте.
 *
 * Каждое уведомление сначала пишется в базу и только потом отправляется:
 * если канал отвалился, событие не потеряно, его видно в приложении
 * и можно переотправить.
 */

export type NotificationKind =
  | 'request_status'
  | 'request_assigned'
  | 'outage'
  | 'meters_reminder'
  | 'payment_reminder'
  | 'access_request'
  | 'review_invite';

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Payload диплинка: откроет нужный экран мини-аппа. A-Za-z0-9_- */
  deepLinkPayload?: string;
}

export interface NotifyResult {
  id: string;
  transport: 'max_bot' | 'web_push' | 'none';
  sent: boolean;
  error?: string;
}

/** Транспорт вынесен в интерфейс, чтобы тесты не ходили в сеть. */
export interface Transport {
  sendToMax(chatId: number, text: string, buttonPayload?: string): Promise<void>;
}

export class MaxTransport implements Transport {
  private bot: MaxBot;
  private botUsername: string;

  constructor(token: string, botUsername: string, baseUrl?: string) {
    this.bot = new MaxBot({ token, baseUrl });
    this.botUsername = botUsername;
  }

  async sendToMax(chatId: number, text: string, buttonPayload?: string): Promise<void> {
    await this.bot.sendMessage({
      chatId,
      text,
      buttons: buttonPayload
        ? [[{
            type: 'open_app',
            text: 'Открыть в приложении',
            // Без web_app или contact_id API отклоняет кнопку
            webApp: this.botUsername,
            payload: buttonPayload,
          }]]
        : undefined,
    });
  }

  /** Ссылка на мини-апп для писем и объявлений. */
  link(payload?: string): string {
    return deepLink(this.botUsername, payload);
  }
}

let defaultTransport: Transport | null = null;

export function setTransport(transport: Transport | null): void {
  defaultTransport = transport;
  envTransport = null;
}

/**
 * Транспорт из окружения создаётся один раз, а не на каждое уведомление.
 *
 * Раньше `notify` звал `transportFromEnv()` при каждом вызове, и рассылка
 * аварийного объявления по дому на сотню квартир создавала сотню клиентов
 * подряд. Ключ кеша — сами переменные: если их подменили в тестах,
 * транспорт пересоздастся.
 */
let envTransport: { key: string; transport: Transport } | null = null;

export function transportFromEnv(): Transport | null {
  const token = process.env.MAX_BOT_TOKEN;
  const username = process.env.MAX_BOT_USERNAME;
  const base = process.env.MAX_API_BASE;
  if (!token || !username) return null;

  const key = `${token}|${username}|${base ?? ''}`;
  if (envTransport?.key === key) return envTransport.transport;

  const transport = new MaxTransport(token, username, base);
  envTransport = { key, transport };
  return transport;
}

/**
 * Уведомления человека — то, что лежит в базе.
 *
 * ЗАЧЕМ ЭТО ПОЯВИЛОСЬ. Комментарий в шапке файла обещал: «если канал
 * отвалился, событие не потеряно, его видно в приложении». Видно
 * его не было нигде: маршрута чтения не существовало, колонка `read`
 * не использовалась. Для жителя, зашедшего из браузера, канал доставки
 * мёртв полностью — `notify` писала строку с `transport: 'web_push'`,
 * `sentAt: null` и молча возвращала «не отправлено». Смену статуса
 * заявки, вопрос диспетчера и аварийное отключение он не узнавал никак.
 *
 * Данные для этого уже были — не хватало вывода.
 */
export const NOTIFICATIONS_PAGE = 50;

/**
 * Потолок выдачи.
 *
 * Параметр приходит из адресной строки, и без верхней границы «показать
 * ещё» однажды превратилось бы в выгрузку всей истории человека одним
 * ответом — на мобильном интернете внутри мессенджера это ощутимо.
 */
export const NOTIFICATIONS_MAX = 500;

/** Сколько уведомлений у человека всего — чтобы список не врал о своей полноте. */
export async function countNotifications(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notification)
    .where(eq(notification.userId, userId));
  return Number(rows[0]?.n ?? 0);
}

export async function listNotifications(db: Database, userId: string, limit = NOTIFICATIONS_PAGE) {
  const rows = await db
    .select()
    .from(notification)
    .where(eq(notification.userId, userId))
    .orderBy(desc(notification.createdAt))
    .limit(limit);

  return rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    read: n.read,
    at: n.createdAt,
    /** Ушло ли сообщением от бота. Для веб-режима всегда false — и это честно */
    delivered: n.sentAt !== null,
    deepLinkPayload: n.deepLinkPayload,
  }));
}

export async function unreadCount(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.read, false)));
  return Number(rows[0]?.n ?? 0);
}

/** Пометить прочитанным. Чужое пометить нельзя — фильтр по userId обязателен. */
export async function markRead(
  db: Database,
  userId: string,
  id: string | null,
): Promise<void> {
  await db
    .update(notification)
    .set({ read: true })
    .where(id
      ? and(eq(notification.userId, userId), eq(notification.id, id))
      : eq(notification.userId, userId));
}

export async function notify(db: Database, input: NotifyInput): Promise<NotifyResult> {
  const id = newId('ntf');

  const users = await db
    .select({ maxChatId: appUser.maxChatId })
    .from(appUser)
    .where(eq(appUser.id, input.userId))
    .limit(1);

  const chatId = users[0]?.maxChatId ?? null;
  const transport: NotifyResult['transport'] = chatId ? 'max_bot' : 'web_push';

  // Сначала в базу: событие не должно теряться из-за упавшего канала
  await db.insert(notification).values({
    id,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    deepLinkPayload: input.deepLinkPayload ?? null,
    transport,
  });

  if (!chatId) {
    // Веб-пуши будут отдельным шагом; пока событие ждёт в приложении
    return { id, transport: 'web_push', sent: false };
  }

  /**
   * Настройки человека спрашиваем ПОСЛЕ записи в базу.
   *
   * Приглушённое уведомление не исчезает: оно остаётся в списке внутри
   * приложения. Молчит только бот — иначе человек, отключивший сообщения
   * о начислениях, не узнал бы о них вообще никогда.
   */
  if (!await allowsKind(db, input.userId, input.kind)) {
    return { id, transport: 'none', sent: false, error: 'muted' };
  }

  const sender = defaultTransport ?? transportFromEnv();
  if (!sender) {
    return { id, transport: 'max_bot', sent: false, error: 'transport_not_configured' };
  }

  try {
    await sender.sendToMax(
      chatId,
      `${input.title}\n\n${input.body}`,
      input.deepLinkPayload,
    );
    await db.update(notification).set({ sentAt: new Date() }).where(eq(notification.id, id));
    return { id, transport: 'max_bot', sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(notification).set({ error: message }).where(eq(notification.id, id));
    // Уведомление — не повод уронить основную операцию
    return { id, transport: 'max_bot', sent: false, error: message };
  }
}
