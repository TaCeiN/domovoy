/**
 * Куда открыть приложение по кнопке бота MAX.
 *
 * Кнопка `open_app` несёт `payload`, мессенджер отдаёт его нам в
 * `start_param`. Разрешено только `A-Za-z0-9_-`, до 512 символов,
 * поэтому текст черновика едет не здесь, а на сервере — в ссылке его id.
 *
 *   d_<id>     — форма жалобы с черновиком бота
 *   r_<id>     — карточка обращения
 *   s_<экран>  — экран из белого списка
 *   p_<ЖК>     — карточка ЖК в подборе дома: кнопка «Поделиться» (29.09);
 *                32 hex-знака — настоящий дом по houseKey
 *
 * Код приглашения (`^[A-Za-z0-9]{5,12}$`) подчёркивания не содержит
 * и с префиксами не пересекается.
 *
 * Экран — только из списка: payload собирает код бота, но попадает он
 * к нам из чужих рук, и открывать по нему что угодно нельзя.
 *
 */
// Вторая строка — экраны, которые Домовёнок открывает по просьбе
// («открой профиль», «хочу отключить уведомления»; lib/bot/screens.ts)
const SCREENS = new Set([
  'analytics', 'payment', 'payment-history', 'meters', 'emergency',
  'feed', 'polls', 'access', 'council', 'master', 'requests', 'accounts',
  'complaint', 'market', 'profile', 'notify-settings', 'properties', 'privacy', 'pick',
]);

/** Экран-псевдоним: лицевые счета живут разделом на экране оплаты */
const ALIASES = { accounts: { name: 'payment', params: { focus: 'accounts' } } };

const ID = /^[A-Za-z0-9]{4,40}$/;

export function parseStartParam(raw) {
  const value = String(raw ?? '').trim();
  const match = /^([drsp])_([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) return null;
  const [, kind, rest] = match;

  // id черновика и заявки приходят без префикса типа: `bdr_` съел бы
  // лишние символы ссылки, а тип и так понятен по букве
  if (kind === 'd' && ID.test(rest)) return { kind: 'draft', id: `bdr_${rest}` };
  if (kind === 'r' && ID.test(rest)) return { kind: 'request', id: `req_${rest}` };
  // Экраны с дефисом (payment-history) пишутся в payload через подчёркивание
  const name = rest.replaceAll('_', '-');
  if (kind === 's' && SCREENS.has(name)) return { kind: 'screen', ...(ALIASES[name] ?? { name }) };
  // Ключ проверяет сервер (MOCK_KEY / HOUSE_KEY); здесь — только форма
  if (kind === 'p' && /^[0-9a-f]{32}$/.test(rest)) return { kind: 'pick', key: rest };
  if (kind === 'p' && /^[a-z0-9-]{1,60}$/.test(rest)) return { kind: 'pick', key: `mock:${rest}` };
  return null;
}
