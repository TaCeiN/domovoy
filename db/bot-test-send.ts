/**
 * Проверка кнопок бота MAX на живом телефоне.
 *
 *   npm run prod:bot-test                      кто вошёл через MAX (id для --max-user)
 *   npm run prod:bot-test -- --max-user 123    прислать ему кнопки
 *
 * Шлёт сообщение с тремя кнопками `open_app`: черновик жалобы (`d_…`),
 * «Счётчики» (`s_meters`), «Мои обращения» (`s_requests`). Нужна одна
 * проверка до всей работы над ботом: доходит ли `payload` кнопки
 * до `start_param` мини-приложения на телефоне.
 *
 * Черновик настоящий: в базе появляется строка `bot_draft` на квартиру
 * жителя (подтверждённую, если есть). Заявки он не создаёт.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb, closeDb, describeConnection } from './client.ts';
import { appUser, userProperty } from './schema.ts';
import { createDraft } from '../lib/bot/drafts.ts';
import { MaxBot } from '../lib/max/bot-api.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const db = getDb();
console.log('База →', describeConnection());

try {
  const maxUser = Number(arg('max-user'));

  if (!maxUser) {
    const rows = await db.select({ name: appUser.fullName, maxUserId: appUser.maxUserId })
      .from(appUser).where(isNotNull(appUser.maxUserId));
    for (const row of rows) console.log(`${row.maxUserId}\t${row.name}`);
    console.log(rows.length ? '\nПовторите с --max-user <id>' : 'Через MAX ещё никто не входил.');
  } else {
    const [user] = await db.select().from(appUser).where(eq(appUser.maxUserId, maxUser));
    if (!user) throw new Error(`Житель с max_user_id ${maxUser} не найден`);
    // Жалоба не ждёт подтверждения — черновик кладётся и на ожидающую квартиру
    const bindings = await db.select().from(userProperty)
      .where(and(eq(userProperty.userId, user.id), inArray(userProperty.status, ['active', 'pending'])));
    const binding = bindings.find((b) => b.status === 'active') ?? bindings[0];
    if (!binding) throw new Error('У жителя нет квартиры — черновик не на что положить');

    const draftId = await createDraft(db, {
      userId: user.id,
      propertyId: binding.propertyId,
      category: 'Сантехника',
      text: 'Проверка бота: в квартире нет горячей воды уже 15 дней. Прошу сообщить причину отключения и срок восстановления подачи.',
    });

    const botUsername = process.env.MAX_BOT_USERNAME;
    if (!botUsername) throw new Error('MAX_BOT_USERNAME не задан');
    const bot = new MaxBot({ token: process.env.MAX_BOT_TOKEN ?? '', baseUrl: process.env.MAX_API_BASE || undefined });
    const open = (text: string, payload: string) =>
      ({ type: 'open_app' as const, text, webApp: botUsername, payload });

    await bot.sendMessage({
      userId: maxUser,
      text: 'Проверка кнопок бота. Нажмите по очереди: каждая должна открыть свой экран, '
        + 'а «Черновик заявки» — форму жалобы с заполненным текстом. Заявка сама не отправится.',
      buttons: [
        [open('Черновик заявки', `d_${draftId.slice('bdr_'.length)}`)],
        [open('Счётчики', 's_meters'), open('Мои обращения', 's_requests')],
      ],
    });
    console.log(`Отправлено. Черновик ${draftId}`);
  }
} finally {
  await closeDb();
}
