import { eq } from 'drizzle-orm';
import { appUser } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';
import type { NotificationKind } from './index.ts';

/**
 * Что человеку присылать.
 *
 * НАСТРОЙКА КАСАЕТСЯ ДОСТАВКИ, А НЕ СОБЫТИЯ. Выключенное уведомление
 * всё равно пишется в базу и видно в списке внутри приложения — иначе
 * человек, приглушивший бота, не узнал бы о смене статуса своей заявки
 * вообще никогда. Молчит только бот.
 */

export const NOTIFY_MODES = ['all', 'important', 'off', 'custom'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

/** Виды уведомлений человеческими словами — для экрана настроек. */
export const NOTIFY_KINDS: {
  kind: NotificationKind;
  label: string;
  hint: string;
  important: boolean;
}[] = [
  {
    kind: 'request_status',
    label: 'Мои обращения',
    hint: 'Смена статуса, ответ диспетчера, вопрос по заявке',
    important: true,
  },
  {
    kind: 'request_assigned',
    label: 'Назначен мастер',
    hint: 'Заявку взяли в работу и назначили исполнителя',
    important: true,
  },
  {
    kind: 'access_request',
    label: 'Доступ к квартире',
    hint: 'Подтверждение заявки, запрос от домочадца, отзыв доступа',
    important: true,
  },
  {
    kind: 'outage',
    label: 'Аварии и отключения',
    hint: 'Отключения воды, света, тепла в вашем доме',
    important: true,
  },
  {
    kind: 'meters_reminder',
    label: 'Показания счётчиков',
    hint: 'Напоминание передать показания и о сроке поверки',
    important: false,
  },
  {
    kind: 'payment_reminder',
    label: 'Начисления',
    hint: 'Пришла новая квитанция, приближается срок оплаты',
    important: false,
  },
  {
    kind: 'review_invite',
    label: 'Отзыв о доме',
    hint: 'Один раз попросим оценить ваш дом для тех, кто думает переехать',
    important: false,
  },
];

const IMPORTANT = new Set(NOTIFY_KINDS.filter((k) => k.important).map((k) => k.kind));

export interface NotifySettings {
  mode: NotifyMode;
  kinds: Record<string, boolean>;
}

/** Раскладка пресета по видам: экран настроек показывает её как есть. */
export function kindsForMode(mode: NotifyMode, current?: Record<string, boolean>) {
  if (mode === 'custom') {
    const base: Record<string, boolean> = {};
    for (const k of NOTIFY_KINDS) base[k.kind] = current?.[k.kind] ?? true;
    return base;
  }

  const map: Record<string, boolean> = {};
  for (const k of NOTIFY_KINDS) {
    map[k.kind] = mode === 'all' ? true : mode === 'off' ? false : k.important;
  }
  return map;
}

function normalizeMode(value: unknown): NotifyMode {
  return NOTIFY_MODES.includes(value as NotifyMode) ? (value as NotifyMode) : 'all';
}

export async function getSettings(db: Database, userId: string): Promise<NotifySettings> {
  const [row] = await db
    .select({ mode: appUser.notifyMode, prefs: appUser.notifyPrefs })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);

  const mode = normalizeMode(row?.mode);
  const stored = (row?.prefs ?? null) as Record<string, boolean> | null;

  return { mode, kinds: kindsForMode(mode, stored ?? undefined) };
}

/**
 * Сохранить настройки.
 *
 * Правка отдельной галочки переводит режим в «свой» — так решил владелец,
 * и это честно: человек больше не под пресетом, и показывать ему «Только
 * важное», когда он включил напоминание о счётчиках, значило бы врать
 * о состоянии его же настроек.
 */
export async function saveSettings(
  db: Database,
  userId: string,
  input: { mode?: unknown; kinds?: unknown },
): Promise<NotifySettings> {
  const askedKinds = (input.kinds ?? null) as Record<string, boolean> | null;

  /**
   * Режим не передали — значит человек тронул ОДНУ галочку, и считать
   * надо от его нынешних настроек, а не от «всё включено».
   *
   * Пока здесь стоял `normalizeMode(undefined)` → 'all', включение одного
   * вида молча возвращало все остальные: человек в режиме «только важное»
   * включал напоминание о счётчиках и получал обратно и начисления тоже.
   */
  const current = await getSettings(db, userId);
  const askedMode = input.mode === undefined ? current.mode : normalizeMode(input.mode);

  let mode: NotifyMode = askedMode;
  let kinds = askedMode === current.mode ? current.kinds : kindsForMode(askedMode);

  if (askedKinds) {
    const merged: Record<string, boolean> = {};
    for (const k of NOTIFY_KINDS) {
      merged[k.kind] = typeof askedKinds[k.kind] === 'boolean'
        ? askedKinds[k.kind]
        : kinds[k.kind];
    }

    // Совпало с пресетом — оставляем пресет: «свой» не должен появляться
    // от того, что человек вручную собрал ровно «только важное»
    const matches = (candidate: NotifyMode) => {
      const preset = kindsForMode(candidate);
      return NOTIFY_KINDS.every((k) => preset[k.kind] === merged[k.kind]);
    };

    mode = matches('all') ? 'all'
      : matches('off') ? 'off'
        : matches('important') ? 'important'
          : 'custom';
    kinds = merged;
  }

  await db
    .update(appUser)
    .set({ notifyMode: mode, notifyPrefs: kinds })
    .where(eq(appUser.id, userId));

  return { mode, kinds };
}

/** Пропускать ли уведомление этого вида до бота. */
export async function allowsKind(
  db: Database,
  userId: string,
  kind: NotificationKind,
): Promise<boolean> {
  const settings = await getSettings(db, userId);
  if (settings.mode === 'off') return false;
  if (settings.mode === 'all') return true;
  if (settings.mode === 'important') return IMPORTANT.has(kind);
  return settings.kinds[kind] !== false;
}
