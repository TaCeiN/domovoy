/**
 * Сроки реакции по заявкам.
 *
 * Это главный аргумент продажи управляющей компании: продукт показывает
 * не «красивое приложение», а сколько заявок у неё просрочено.
 *
 * Значения ориентируются на сложившуюся практику ЖКХ и Правила содержания
 * общего имущества: аварийные ситуации устраняются немедленно, остальное —
 * в разумные сроки. Конкретные часы согласовываются с УК при подключении,
 * поэтому лежат в одном месте и меняются одной правкой.
 */

export type RequestCategory =
  | 'Авария' | 'Сантехника' | 'Электрика' | 'Лифт'
  | 'Общее имущество' | 'Мебель и сборка' | 'Другое';

const SLA_HOURS: Record<string, number> = {
  'Авария': 2,
  'Лифт': 8,
  'Сантехника': 24,
  'Электрика': 24,
  'Общее имущество': 72,
  'Мебель и сборка': 72,
  'Другое': 72,
};

export const DEFAULT_SLA_HOURS = 72;

export function slaHoursFor(category: string): number {
  return SLA_HOURS[category] ?? DEFAULT_SLA_HOURS;
}

export function slaDueAt(category: string, from = new Date()): Date {
  return new Date(from.getTime() + slaHoursFor(category) * 3600_000);
}

export type SlaState = 'ok' | 'soon' | 'overdue';

/**
 * Состояние срока. «Скоро» зажигается за четверть срока до конца —
 * так у диспетчера остаётся время среагировать, а не узнать постфактум.
 */
export function slaState(
  dueAt: Date | null,
  category: string,
  now = new Date(),
): SlaState {
  if (!dueAt) return 'ok';
  const leftMs = dueAt.getTime() - now.getTime();
  if (leftMs <= 0) return 'overdue';
  const warnMs = slaHoursFor(category) * 3600_000 * 0.25;
  return leftMs <= warnMs ? 'soon' : 'ok';
}

/** Человеческая подпись остатка: «осталось 3 ч», «просрочено на 2 ч». */
export function slaLabel(dueAt: Date | null, now = new Date()): string {
  if (!dueAt) return 'без срока';

  const diffMinutes = Math.round((dueAt.getTime() - now.getTime()) / 60_000);
  const overdue = diffMinutes < 0;
  const total = Math.abs(diffMinutes);

  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;

  let text: string;
  if (days > 0) text = `${days} ${plural(days, 'день', 'дня', 'дней')}`;
  else if (hours > 0) text = `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  else text = `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;

  return overdue ? `просрочено на ${text}` : `осталось ${text}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
