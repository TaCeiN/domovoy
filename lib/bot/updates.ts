import { START, NO_TEXT, type Incoming } from './handle.ts';

/**
 * Событие MAX → сообщение для бота. Общее для вебхука и `bot:poll`.
 *
 * Отвечаем только в личке: в групповом чате бот не участник разговора.
 * Нажатие «Начать» (bot_started) приходит без текста — превращаем его
 * в `/start`, на который бот здоровается без модели.
 */
interface MaxUpdate {
  update_type?: string;
  timestamp?: number;
  message?: {
    sender?: { user_id?: number; is_bot?: boolean };
    recipient?: { chat_type?: string };
    body?: { mid?: string; text?: string };
  };
  user?: { user_id?: number };
}

export function incomingFromUpdate(raw: unknown): Incoming | null {
  const update = (raw ?? {}) as MaxUpdate;

  if (update.update_type === 'message_created') {
    const m = update.message;
    const userId = m?.sender?.user_id;
    const text = m?.body?.text;
    const mid = m?.body?.mid;
    const dialog = !m?.recipient?.chat_type || m.recipient.chat_type === 'dialog';
    if (!userId || !mid || !dialog || m?.sender?.is_bot) return null;
    // Без текста — стикер, фото, голосовое: не молчим, бот попросит написать словами
    return { maxUserId: userId, text: text?.trim() ? text : NO_TEXT, mid };
  }

  if (update.update_type === 'bot_started' && update.user?.user_id) {
    const userId = update.user.user_id;
    return { maxUserId: userId, text: START, mid: `start:${userId}:${update.timestamp ?? Date.now()}` };
  }
  return null;
}
