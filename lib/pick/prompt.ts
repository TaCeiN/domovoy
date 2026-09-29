import { and, eq, sql } from 'drizzle-orm';
import { house, houseReview, property, reviewPrompt as promptTable, userProperty } from '../../db/schema.ts';
import { notify } from '../notify/index.ts';
import { ratingsFor } from './reviews.ts';
import { isPickerHouse, PICKER_HOUSE } from './scope.ts';
import type { Database } from '../../db/client.ts';

/**
 * Просьба оставить отзыв.
 *
 * Без просьбы отзывов не будет: живущему в доме незачем его описывать.
 * Просим двумя путями — карточкой на главной и одним письмом бота —
 * и отступаем: закрытая карточка возвращается через месяц один раз,
 * дальше молчим. Пожилой человек, которому каждый день напоминают
 * одно и то же, перестаёт открывать приложение.
 */

export const PROMPT_PAUSE_DAYS = 30;
export const BOT_DELAY_DAYS = 3;
const DAY = 86_400_000;

export interface PromptState { dismissedAt: Date | null; dismissCount: number }

export function promptVisible(state: PromptState | undefined, now: Date): boolean {
  if (!state) return true;
  if (state.dismissCount >= 2) return false;
  if (!state.dismissedAt) return true;
  return now.getTime() - state.dismissedAt.getTime() >= PROMPT_PAUSE_DAYS * DAY;
}

export interface Prompt { houseKey: string; address: string; reviews: number }

/** Дом, о котором стоит попросить отзыв, или `null` */
export async function reviewPrompt(db: Database, userId: string, now = new Date()): Promise<Prompt | null> {
  const homes = await db
    .select({
      houseKey: property.houseKey,
      address: house.addressRaw,
      houseKind: house.houseKind,
      garMkd: house.garMkd,
      flatCount: house.flatCount,
      garFlats: house.garFlats,
      registryForm: house.registryForm,
      form: house.form,
      decidedAt: userProperty.decidedAt,
    })
    .from(userProperty)
    .innerJoin(property, eq(property.id, userProperty.propertyId))
    .innerJoin(house, eq(house.houseKey, property.houseKey))
    .where(and(eq(userProperty.userId, userId), eq(userProperty.status, 'active')))
    .orderBy(userProperty.decidedAt);

  for (const home of homes) {
    if (!isPickerHouse(home)) continue;
    /**
     * Не в первый же день.
     *
     * Карточка «Как вам живётся в доме?» появлялась через двадцать минут
     * после подтверждения (аудит 26 сентября): о доме человек в приложении
     * ещё ничего не знает, а его уже просят оценить. Тот же срок, что
     * у письма бота.
     */
    if (home.decidedAt && now.getTime() - home.decidedAt.getTime() < BOT_DELAY_DAYS * DAY) continue;

    const [review] = await db.select({ id: houseReview.id }).from(houseReview)
      .where(and(eq(houseReview.userId, userId), eq(houseReview.houseKey, home.houseKey)))
      .limit(1);
    if (review) continue;

    const [state] = await db.select().from(promptTable)
      .where(and(eq(promptTable.userId, userId), eq(promptTable.houseKey, home.houseKey)))
      .limit(1);
    if (!promptVisible(state, now)) continue;

    const count = (await ratingsFor(db, [home.houseKey])).get(home.houseKey)?.count ?? 0;
    return { houseKey: home.houseKey, address: home.address ?? '', reviews: count };
  }
  return null;
}

export async function dismissPrompt(db: Database, userId: string, houseKey: string, now = new Date()): Promise<void> {
  await db.insert(promptTable)
    .values({ userId, houseKey, dismissedAt: now, dismissCount: 1 })
    .onConflictDoUpdate({
      target: [promptTable.userId, promptTable.houseKey],
      set: { dismissedAt: now, dismissCount: sql`${promptTable.dismissCount} + 1` },
    });
}

/** «обл Ростовская, г Аксай, ул Мира, д. 1» → «ул Мира, д. 1»: в письме короче */
const shortAddress = (address: string) => address.split(',').slice(-2).join(',').trim();

/**
 * Одно письмо бота подтверждённому жителю без отзыва — через три дня
 * после подтверждения: в первый день человеку уже пришло «доступ
 * подтверждён», и второе письмо следом выглядит как спам.
 *
 * Отметку ставим ДО отправки: упавший канал не должен превращаться
 * в повторные письма при каждом прогоне.
 */
export async function sendReviewInvites(db: Database, now = new Date(), limit = 200): Promise<number> {
  const before = new Date(now.getTime() - BOT_DELAY_DAYS * DAY);
  const result = await db.execute(sql`
    select distinct up.user_id, p.house_key, ${house.addressRaw} as address
      from ${userProperty} up
      join ${property} p on p.id = up.property_id
      join ${house} on ${house.houseKey} = p.house_key
      left join ${houseReview} r on r.user_id = up.user_id and r.house_key = p.house_key
      left join ${promptTable} rp on rp.user_id = up.user_id and rp.house_key = p.house_key
     where up.status = 'active'
       and coalesce(up.decided_at, up.created_at) <= ${before}
       and r.id is null
       and rp.bot_sent_at is null
       and coalesce(rp.dismiss_count, 0) < 2
       and ${PICKER_HOUSE}
     limit ${limit}`);
  const rows = result.rows as { user_id: string; house_key: string; address: string | null }[];

  for (const row of rows) {
    await db.insert(promptTable)
      .values({ userId: row.user_id, houseKey: row.house_key, botSentAt: now })
      .onConflictDoUpdate({ target: [promptTable.userId, promptTable.houseKey], set: { botSentAt: now } });

    await notify(db, {
      userId: row.user_id,
      kind: 'review_invite',
      title: 'Как вам живётся в доме?',
      body: `Оцените дом ${shortAddress(row.address ?? '')}: ваш отзыв увидят те, кто думает переехать к вам. `
        + 'Пять строк звёзд — минута времени.',
      deepLinkPayload: 'home',
    }).catch(() => undefined);
  }
  return rows.length;
}

/** Фоновая рассылка раз в 6 часов. `unref`: таймер не держит процесс, как уборка сессий. */
export function startReviewInvites(db: Database, intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  const timer = setInterval(() => {
    sendReviewInvites(db).catch(() => { /* рассылка не повод падать */ });
  }, intervalMs);
  timer.unref();
  return timer;
}
