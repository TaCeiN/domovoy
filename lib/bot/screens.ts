/**
 * Экраны приложения, которые Домовёнок открывает по просьбе («открой
 * счётчики», «где профиль», «хочу отключить уведомления»).
 *
 * Ключ — то, что выбирает модель (поле `screen` функции classify).
 * payload — адрес для кнопки `open_app`, тот же, что в ссылках бота:
 * `s_<экран>`, дефис пишется подчёркиванием (public/app/deeplink.js).
 * `need` — кто может смотреть: лента дома откроется только после
 * подтверждения квартиры, «Совет дома» — только председателю. Проверяет
 * код, а не модель.
 */
export interface Screen {
  label: string;
  payload: string;
  need?: 'full' | 'chairman';
}

export const SCREENS = {
  requests: { label: 'Мои обращения', payload: 's_requests' },
  complaint: { label: 'Новое обращение', payload: 's_complaint' },
  meters: { label: 'Показания счётчиков', payload: 's_meters' },
  analytics: { label: 'Аналитика потребления', payload: 's_analytics' },
  payment: { label: 'Оплата ЖКУ', payload: 's_payment' },
  payment_history: { label: 'История начислений', payload: 's_payment_history' },
  accounts: { label: 'Лицевые счета', payload: 's_accounts' },
  emergency: { label: 'Аварийные службы', payload: 's_emergency' },
  master: { label: 'Мастер в квартиру', payload: 's_master' },
  feed: { label: 'Объявления дома', payload: 's_feed', need: 'full' },
  market: { label: 'Соседи предлагают', payload: 's_market', need: 'full' },
  polls: { label: 'Опросы дома', payload: 's_polls', need: 'full' },
  access: { label: 'Доступ к адресу', payload: 's_access', need: 'full' },
  council: { label: 'Совет дома', payload: 's_council', need: 'chairman' },
  profile: { label: 'Профиль', payload: 's_profile' },
  notify_settings: { label: 'Уведомления', payload: 's_notify_settings' },
  properties: { label: 'Моя недвижимость', payload: 's_properties' },
  privacy: { label: 'Персональные данные', payload: 's_privacy' },
  pick: { label: 'Подбор дома', payload: 's_pick' },
} satisfies Record<string, Screen>;

export type ScreenKey = keyof typeof SCREENS;
export const SCREEN_KEYS = Object.keys(SCREENS) as ScreenKey[];
