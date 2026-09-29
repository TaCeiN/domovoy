import https from 'node:https';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Клиент GigaChat — ровно то, что нужно боту: вызов одной функции.
 *
 * Бот не просит модель писать ответ жителю. Он даёт ей одну функцию
 * (`classify`) и требует вызвать именно её: аргументы приходят
 * готовым объектом, и разбирать «JSON в тексте» не надо. Суммы,
 * даты и номера в ответ жителю пишет наш код, а не модель.
 *
 * СЕРТИФИКАТ. Хосты Сбера подписаны корневым УЦ Минцифры, которого нет
 * в хранилище Node: без него SELF_SIGNED_CERT_IN_CHAIN. Поэтому запросы
 * идут через `node:https` с явным `ca` — стандартные корни плюс
 * сертификат из `certs/`. `fetch` так не умеет без пакета undici,
 * которого в зависимостях нет.
 *
 * АДРЕС. SDK Сбера переехал на api.giga.chat, но оттуда рвёт соединение
 * с части сетей; классический адрес отвечает. Оба — в настройке.
 */

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  /** role=function: имя функции, чей результат в content */
  name?: string;
  /** role=assistant: вызов функции, на который отвечает следующее сообщение */
  function_call?: { name: string; arguments: Record<string, unknown> };
}

/** Ответ модели в свободном разговоре: либо текст, либо вызов функции */
export interface ChatTurn {
  content?: string;
  call?: { name: string; args: Record<string, unknown> };
  totalTokens: number;
}

export interface FunctionDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  few_shot_examples?: Array<{ request: string; params: Record<string, unknown> }>;
}

export interface GigaChatConfig {
  /** Ключ авторизации из личного кабинета (base64 от Client ID и секрета) */
  authKey: string;
  scope?: string;
  model?: string;
  apiBase?: string;
  authUrl?: string;
  /** PEM корневого сертификата Минцифры */
  ca?: string;
  timeoutMs?: number;
  transport?: Transport;
  now?: () => number;
}

export class GigaChatError extends Error {
  /** blacklist — сработал встроенный фильтр GigaChat: его шаблон жителю не показываем */
  code: 'http' | 'timeout' | 'network' | 'bad_response' | 'blacklist';
  status: number;
  /** Сколько токенов списали, даже если ответ не пригодился */
  totalTokens: number;

  constructor(code: GigaChatError['code'], message: string, status = 0, totalTokens = 0) {
    super(message);
    this.name = 'GigaChatError';
    this.code = code;
    this.status = status;
    this.totalTokens = totalTokens;
  }
}

const DEFAULT_API = 'https://gigachat.devices.sberbank.ru/api/v1';
const DEFAULT_AUTH = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
/** Токен выдают на 30 минут; берём новый за минуту до конца */
const TOKEN_MARGIN_MS = 60_000;

/** Транспорт на `node:https` со своим корневым сертификатом. */
export function httpsTransport(ca: string | undefined, timeoutMs: number): Transport {
  const roots = ca ? [...tls.rootCertificates, ca] : undefined;
  return (req) => new Promise((resolve, reject) => {
    const r = https.request(req.url, {
      method: req.method,
      headers: req.headers,
      ...(roots ? { ca: roots } : {}),
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new GigaChatError('timeout', `GigaChat не ответил за ${timeoutMs} мс`)));
    r.on('error', (e) => reject(e instanceof GigaChatError ? e : new GigaChatError('network', e.message)));
    if (req.body) r.write(req.body);
    r.end();
  });
}

/** Сертификат Минцифры из файла; нет файла — undefined, и хосты Сбера не откроются. */
export function readCa(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export class GigaChat {
  private readonly authKey: string;
  private readonly scope: string;
  private readonly model: string;
  private readonly apiBase: string;
  private readonly authUrl: string;
  private readonly transport: Transport;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: GigaChatConfig) {
    if (!config.authKey) throw new Error('GIGACHAT_AUTH_KEY не задан');
    this.authKey = config.authKey;
    this.scope = config.scope || 'GIGACHAT_API_PERS';
    this.model = config.model || 'GigaChat-2-Pro';
    this.apiBase = (config.apiBase || DEFAULT_API).replace(/\/+$/, '');
    this.authUrl = config.authUrl || DEFAULT_AUTH;
    this.transport = config.transport ?? httpsTransport(config.ca, config.timeoutMs ?? 15_000);
    this.now = config.now ?? Date.now;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > this.now()) return this.token.value;

    const res = await this.transport({
      url: this.authUrl,
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.authKey}`,
        RqUID: randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: `scope=${encodeURIComponent(this.scope)}`,
    });
    if (res.status !== 200) {
      throw new GigaChatError('http', `GigaChat: токен не выдан (${res.status}) ${res.text.slice(0, 200)}`, res.status);
    }
    const json = parseJson(res.text) as { access_token?: string; expires_at?: number; tok?: string; exp?: number } | null;
    const value = json?.access_token ?? json?.tok;
    const expiresAt = json?.expires_at ?? json?.exp;
    if (!value || !expiresAt) throw new GigaChatError('bad_response', 'GigaChat: в ответе нет токена');
    this.token = { value, expiresAt };
    return value;
  }

  /**
   * Одно обращение к модели с обязательным вызовом `fn`.
   * Токен протух на стороне Сбера раньше срока — одна повторная попытка.
   */
  async callFunction(
    messages: ChatMessage[],
    fn: FunctionDef,
  ): Promise<{ args: Record<string, unknown>; totalTokens: number }> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      functions: [fn],
      function_call: { name: fn.name },
      // Разбор, а не сочинение: разброс не нужен
      temperature: 0.1,
    });

    let res = await this.post(body);
    if (res.status === 401) {
      this.token = null;
      res = await this.post(body);
    }
    if (res.status !== 200) {
      throw new GigaChatError('http', `GigaChat: ${res.status} ${res.text.slice(0, 200)}`, res.status);
    }

    const json = parseJson(res.text) as {
      choices?: Array<{ message?: { function_call?: { name?: string; arguments?: unknown } }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    } | null;
    const totalTokens = json?.usage?.total_tokens ?? 0;
    if (json?.choices?.[0]?.finish_reason === 'blacklist') {
      throw new GigaChatError('blacklist', 'GigaChat: сработал фильтр', 200, totalTokens);
    }
    const call = json?.choices?.[0]?.message?.function_call;
    const args = typeof call?.arguments === 'string' ? parseJson(call.arguments) : call?.arguments;
    if (call?.name !== fn.name || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw new GigaChatError('bad_response', 'GigaChat не вызвал функцию разбора', 200, totalTokens);
    }
    return { args: args as Record<string, unknown>, totalTokens };
  }

  /**
   * Свободный разговор с функциями: модель сама решает, вызвать ли одну
   * из них или ответить текстом. Так работает агент Домовёнка
   * (lib/agent/loop.ts): результат функции уходит обратно сообщением
   * role=function, и модель пишет ответ по нему.
   */
  async chat(messages: ChatMessage[], functions: FunctionDef[]): Promise<ChatTurn> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      functions,
      function_call: 'auto',
      // Живой ответ, но без фантазий
      temperature: 0.3,
    });

    let res = await this.post(body);
    if (res.status === 401) {
      this.token = null;
      res = await this.post(body);
    }
    if (res.status !== 200) {
      throw new GigaChatError('http', `GigaChat: ${res.status} ${res.text.slice(0, 200)}`, res.status);
    }

    const json = parseJson(res.text) as {
      choices?: Array<{ message?: { content?: unknown; function_call?: { name?: string; arguments?: unknown } }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    } | null;
    const totalTokens = json?.usage?.total_tokens ?? 0;
    if (json?.choices?.[0]?.finish_reason === 'blacklist') {
      throw new GigaChatError('blacklist', 'GigaChat: сработал фильтр', 200, totalTokens);
    }
    const message = json?.choices?.[0]?.message;
    const fc = message?.function_call;
    if (fc?.name) {
      const raw = typeof fc.arguments === 'string' ? parseJson(fc.arguments) : fc.arguments;
      const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      return { call: { name: fc.name, args }, totalTokens };
    }
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!content) throw new GigaChatError('bad_response', 'GigaChat: пустой ответ', 200, totalTokens);
    return { content, totalTokens };
  }

  private async post(body: string): Promise<HttpResponse> {
    const token = await this.accessToken();
    return this.transport({
      url: `${this.apiBase}/chat/completions`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
