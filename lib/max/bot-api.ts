/**
 * Клиент Bot API MAX.
 *
 * ВАЖНО ПРО ДОМЕН И СЕРТИФИКАТ.
 * Документация просит слать запросы на platform-api2.max.ru. Этот домен отдаёт
 * сертификат, подписанный корневым УЦ Минцифры, которого нет в стандартных
 * хранилищах доверенных корней. Без него Node падает с
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY — проверено.
 *
 * Что делать на деплое:
 *   1. Положить корневой сертификат Минцифры в репозиторий
 *   2. Указать путь в NODE_EXTRA_CA_CERTS (или передать сюда caBundle)
 *   3. Переключить MAX_API_BASE на https://platform-api2.max.ru
 *
 * Пока сертификат не добавлен, работает старый домен platform-api.max.ru
 * со стандартными корнями. Он объявлен устаревшим, так что это временно.
 */

const DEFAULT_BASE = 'https://platform-api.max.ru';

export interface BotConfig {
  token: string;
  baseUrl?: string;
  /** Диспетчер undici со своим корневым сертификатом — см. createCaDispatcher. */
  dispatcher?: unknown;
  fetchImpl?: typeof fetch;
  /** Сколько ждать ответа. По умолчанию 10 секунд. */
  timeoutMs?: number;
}

export interface BotInfo {
  user_id: number;
  name: string;
  username: string;
  is_bot: boolean;
}

/**
 * Кнопка, открывающая наше мини-приложение прямо из уведомления.
 *
 * Формат подсмотрен в официальном клиенте max-bot-api-client-ts:
 * на проводе поля называются `web_app` и `contact_id`, и одно из них
 * обязательно — без них API отвечает «Field 'webApp' cannot be null».
 */
export interface OpenAppButton {
  type: 'open_app';
  text: string;
  /** Имя бота, к которому привязано мини-приложение */
  webApp?: string;
  /** Либо его числовой идентификатор */
  contactId?: number;
  /** Payload диплинка: доедет в start_param. Только A-Za-z0-9_- до 512 символов. */
  payload?: string;
}

/** Наружу отдаём snake_case, как ждёт API. */
function serialiseButton(button: Button): Record<string, unknown> {
  if (button.type !== 'open_app') return { ...button };
  const { webApp, contactId, ...rest } = button;
  return {
    ...rest,
    ...(webApp ? { web_app: webApp } : {}),
    ...(contactId ? { contact_id: contactId } : {}),
  };
}

export interface LinkButton {
  type: 'link';
  text: string;
  url: string;
}

/**
 * Кнопка-ответ: нажатие присылает боту её текст от имени человека.
 * Так бот задаёт уточняющий вопрос с вариантами — пожилому человеку
 * нажать проще, чем набрать «горячей».
 */
export interface MessageButton {
  type: 'message';
  text: string;
}

export type Button = OpenAppButton | LinkButton | MessageButton;

export interface SendMessageInput {
  /** Одно из двух обязательно. chat_id для мини-приложения берётся из initData. */
  chatId?: number;
  userId?: number;
  text: string;
  buttons?: Button[][];
  notify?: boolean;
}

export class MaxBotError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'MaxBotError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Диспетчер undici с собственным корневым сертификатом — нужен для домена
 * platform-api2.max.ru, который подписан УЦ Минцифры.
 * Вынесено в отдельную функцию: динамический импорт, чтобы модуль оставался
 * пригодным и там, где undici недоступен.
 */
export async function createCaDispatcher(caPem: string): Promise<unknown> {
  // Типов undici в сборке нет, а сам пакет идёт в комплекте с Node,
  // поэтому импортируем по вычисляемому имени и типизируем структурно
  const moduleName = 'undici';
  const { Agent } = (await import(moduleName)) as {
    Agent: new (options: { connect: { ca: string } }) => unknown;
  };
  return new Agent({ connect: { ca: caPem } });
}

export class MaxBot {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly dispatcher?: unknown;
  private readonly timeoutMs: number;

  constructor(config: BotConfig) {
    if (!config.token) throw new Error('MAX_BOT_TOKEN не задан');
    this.token = config.token;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.doFetch = config.fetchImpl ?? fetch;
    this.dispatcher = config.dispatcher;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    /**
     * Таймаут обязателен.
     *
     * Без него зависшее соединение с Bot API держит HTTP-запрос вечно.
     * Хуже всего это видно на рассылке объявления по дому: она идёт
     * по жильцу за раз внутри запроса диспетчера, и один залипший вызов
     * останавливает всю рассылку. У клиента ГИС ЖКХ таймаут стоит
     * с самого начала — здесь его просто забыли.
     */
    const init: RequestInit & { dispatcher?: unknown } = {
      method,
      // Токен только заголовком: передача через query-параметры больше не поддерживается
      headers: {
        Authorization: this.token,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;

    const response = await this.doFetch(url, init);
    const raw = await response.text();

    if (!response.ok) {
      throw new MaxBotError(
        `MAX API ${method} ${path} → ${response.status}`,
        response.status,
        raw,
      );
    }
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  getMe(): Promise<BotInfo> {
    return this.call<BotInfo>('GET', '/me');
  }

  /**
   * Уведомление жителю. Внутри MAX это заменяет Web Push, который на iOS
   * почти не доставляется.
   */
  async sendMessage(input: SendMessageInput): Promise<{ message?: { body?: { mid?: string } } }> {
    if (input.chatId === undefined && input.userId === undefined) {
      throw new Error('sendMessage: нужен chatId или userId');
    }

    const attachments = input.buttons?.length
      ? [{
          type: 'inline_keyboard',
          payload: { buttons: input.buttons.map((row) => row.map(serialiseButton)) },
        }]
      : undefined;

    return this.call('POST', '/messages', {
      query: { chat_id: input.chatId, user_id: input.userId },
      body: {
        text: input.text,
        ...(attachments ? { attachments } : {}),
        ...(input.notify === undefined ? {} : { notify: input.notify }),
      },
    });
  }
  /** Подписки вебхука бота. */
  subscriptions(): Promise<{ subscriptions?: Array<{ url: string; update_types?: string[] }> }> {
    return this.call('GET', '/subscriptions');
  }

  /**
   * Вебхук: MAX шлёт события POST-ом на `url` с секретом в заголовке
   * `X-Max-Bot-Api-Secret`. Только HTTPS на 443 и сертификат доверенного УЦ.
   * Пока подписка есть, `getUpdates` не отдаёт ничего.
   */
  subscribe(url: string, secret: string, updateTypes: string[]): Promise<{ success?: boolean }> {
    return this.call('POST', '/subscriptions', { body: { url, secret, update_types: updateTypes } });
  }

  unsubscribe(url: string): Promise<{ success?: boolean }> {
    return this.call('DELETE', '/subscriptions', { query: { url } });
  }

  /** Длинный опрос — для разработки на машине без HTTPS. */
  getUpdates(marker?: number, timeoutSec = 30): Promise<{ updates?: unknown[]; marker?: number }> {
    return this.call('GET', '/updates', { query: { marker, timeout: timeoutSec, types: 'message_created,bot_started' } });
  }
}

/** Диплинк, открывающий мини-приложение с payload в start_param. */
export function deepLink(botUsername: string, payload?: string): string {
  const base = `https://max.ru/${botUsername}?startapp`;
  if (!payload) return base;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(payload)) {
    throw new Error(`Недопустимый payload диплинка: ${payload}`);
  }
  return `${base}=${payload}`;
}
