import type { FunctionDef } from '../gigachat/client.ts';
import { SCREENS, SCREEN_KEYS } from './screens.ts';

/**
 * Что модель должна понять из сообщения жителя.
 *
 * Модель не пишет ответ — только разбирает. Суммы, даты, номера и адреса
 * в ответ подставляет код из базы, поэтому переврать их модели нечем.
 *
 * Понимание живой речи держится на примерах: мат, опечатки, без знаков
 * препинания. Непонятые сообщения копятся в `bot_miss` — оттуда
 * пополняется список ниже.
 */

export const INTENTS = [
  'greeting', 'bills', 'paid', 'request_status', 'complaint', 'master',
  'meters', 'accounts', 'contacts', 'invite', 'feed', 'polls', 'council', 'analytics', 'navigate', 'outage', 'unknown',
] as const;
export type Intent = (typeof INTENTS)[number];

/** Категории — те же, что в форме жалобы мини-приложения. */
export const CATEGORIES = ['Авария', 'Сантехника', 'Электрика', 'Лифт', 'Общее имущество', 'Другое'] as const;

const INTENT_HELP: Record<Intent, string> = {
  greeting: 'приветствие, «что ты умеешь», «привет»',
  bills: 'сколько платить, сумма квитанции, почему дорого, начисления',
  paid: 'оплачено ли, заплатил ли я, долг',
  request_status: 'что с моей заявкой или обращением, когда придёт мастер, заявка номер N',
  complaint: 'жалоба или проблема в доме или квартире, которую должна решить УК: нет воды, не работает лифт, грязно, холодно, течёт',
  master: 'нужен мастер для ремонта ВНУТРИ своей квартиры за свой счёт: повесить люстру, подключить стиральную машину, поменять розетку',
  meters: 'показания счётчиков, когда сдавать, какие показания',
  accounts: 'мои лицевые счета, номер лицевого счёта, по каким счетам приходят квитанции (свет, вода, газ), мои данные из квитанции',
  contacts: 'телефон аварийной службы, диспетчерской, лифтёров, домофона, какая у нас УК; '
    + 'номера экстренных служб: скорая, полиция, пожарные, газовая служба, МЧС, 112',
  invite: 'как добавить в приложение жену, мужа, детей, домочадцев',
  feed: 'новости дома, объявления, собрания',
  polls: 'голосования и опросы в доме',
  council: 'дела председателя совета дома: кого подтвердить, что по дому',
  analytics: 'сколько я трачу на коммуналку, расход по месяцам, выросли ли платежи',
  outage: 'когда отключат или дадут воду, свет, газ, отопление; плановые отключения; было ли объявление об отключении',
  navigate: 'открыть экран приложения, «где найти», «как перейти», «открой», «покажи», '
    + 'а также «новая заявка» и «хочу подать обращение» БЕЗ описания проблемы',
  unknown: 'всё остальное: законы, общие вопросы о ЖКХ, болтовня, непонятное',
};

export const SYSTEM_PROMPT = [
  'Ты разбираешь сообщения жителей многоквартирного дома боту управляющей компании.',
  'Люди пишут как говорят: с матом, опечатками, без знаков препинания. Пойми, чего человек хочет.',
  'Всегда вызывай функцию classify. Ничего не отвечай текстом.',
  '',
  'Правила для жалобы (intent=complaint):',
  '- category и text заполняй ВСЕГДА; не подходит ни одна категория — «Другое»;',
  '- text — жалоба в УК деловым языком от первого лица: без мата, оскорблений и эмоций;',
  '- сохрани ВСЕ факты человека (что, где, сколько дней) и НЕ добавляй своих;',
  '- если без уточнения УК не поймёт, о чём речь, задай ОДИН вопрос в ask и дай 2–4 коротких варианта в options.',
  '  Обязательно спрашивай, если человек пишет «нет воды» и не сказал, горячей или холодной;',
  '  если «нет света» или «нет отопления» и непонятно — только у него или во всём доме;',
  '- если в истории вопрос уже задавался — больше не спрашивай, собери text с ответом человека.',
  '',
  'Номер заявки из сообщения — в requestNumber (только цифры).',
  '',
  'Правила для открытия экрана (intent=navigate): screen — ОДИН из списка ниже, ничего не выдумывай.',
  'Если человек описал конкретную проблему — это complaint, а не navigate.',
  'Экраны:',
  ...SCREEN_KEYS.map((k) => `- ${k}: ${SCREENS[k].label}`),
  '',
  'Намерения:',
  ...INTENTS.map((i) => `- ${i}: ${INTENT_HELP[i]}`),
].join('\n');

export const CLASSIFY: FunctionDef = {
  name: 'classify',
  description: 'Разобрать сообщение жителя: чего он хочет',
  parameters: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: [...INTENTS], description: 'Чего хочет человек' },
      category: { type: 'string', enum: [...CATEGORIES], description: 'Категория жалобы (только для complaint)' },
      text: { type: 'string', description: 'Текст жалобы для УК деловым языком (только для complaint)' },
      ask: { type: 'string', description: 'Один уточняющий вопрос, если без него жалоба непонятна' },
      options: { type: 'array', items: { type: 'string' }, description: '2–4 коротких варианта ответа на ask' },
      requestNumber: { type: 'string', description: 'Номер заявки, если назван' },
      screen: { type: 'string', enum: [...SCREEN_KEYS], description: 'Какой экран открыть (только для navigate)' },
    },
    required: ['intent'],
  },
  few_shot_examples: [
    {
      request: 'схуяли нет воды уже 15 дней',
      params: {
        intent: 'complaint', category: 'Сантехника',
        text: 'В квартире нет воды уже 15 дней. Прошу сообщить причину отключения и срок восстановления подачи.',
        ask: 'Какой воды нет?', options: ['Горячей', 'Холодной', 'Никакой'],
      },
    },
    {
      request: 'лифт опять сдох третий день пешком на 9 этаж',
      params: {
        intent: 'complaint', category: 'Лифт',
        text: 'Лифт не работает третий день. Прошу восстановить его работу.',
      },
    },
    {
      request: 'в подъезде срач никто не убирает месяц',
      params: {
        intent: 'complaint', category: 'Общее имущество',
        text: 'В подъезде не проводится уборка около месяца. Прошу возобновить уборку.',
      },
    },
    { request: 'че за цифры в квитке', params: { intent: 'bills' } },
    { request: 'скока платить', params: { intent: 'bills' } },
    { request: 'я за август заплатил?', params: { intent: 'paid' } },
    { request: 'када мастер придет по заявке 12', params: { intent: 'request_status', requestNumber: '12' } },
    { request: 'что с моей жалобой', params: { intent: 'request_status' } },
    { request: 'надо люстру повесить кто может', params: { intent: 'master' } },
    { request: 'когда показания сдавать', params: { intent: 'meters' } },
    { request: 'какие мои лицевые счета', params: { intent: 'accounts' } },
    { request: 'номер счета за газ скинь', params: { intent: 'accounts' } },
    { request: 'телефон лифтеров', params: { intent: 'contacts' } },
    { request: 'какой номер у скорой', params: { intent: 'contacts' } },
    { request: 'когда отключение воды', params: { intent: 'outage' } },
    { request: 'када свет дадут', params: { intent: 'outage' } },
    { request: 'как жену добавить', params: { intent: 'invite' } },
    { request: 'дочь тоже хочет пользоваться приложением', params: { intent: 'invite' } },
    { request: 'мусор не вывозят неделю', params: { intent: 'complaint', category: 'Общее имущество', text: 'Мусор не вывозят неделю. Прошу организовать вывоз.' } },
    { request: 'нет света', params: { intent: 'complaint', category: 'Электрика', text: 'Нет электричества. Прошу сообщить причину и срок восстановления.', ask: 'Света нет только у вас или во всём доме?', options: ['Только у меня', 'Во всём подъезде', 'Во всём доме'] } },
    { request: 'расскажи анекдот', params: { intent: 'unknown' } },
    { request: 'чо нового в доме', params: { intent: 'feed' } },
    { request: 'имеют право отключать воду на месяц?', params: { intent: 'unknown' } },
    { request: 'привет', params: { intent: 'greeting' } },
    { request: 'открой счетчики', params: { intent: 'navigate', screen: 'meters' } },
    { request: 'как мне перейти в вкладку профиль', params: { intent: 'navigate', screen: 'profile' } },
    { request: 'Новая заявка', params: { intent: 'navigate', screen: 'complaint' } },
    { request: 'хочу отключить уведомления', params: { intent: 'navigate', screen: 'notify_settings' } },
    { request: 'хочу переехать, где посмотреть дома', params: { intent: 'navigate', screen: 'pick' } },
    { request: 'где мои заявки', params: { intent: 'navigate', screen: 'requests' } },
    { request: 'сколько я трачу на коммуналку', params: { intent: 'analytics' } },
  ],
};
