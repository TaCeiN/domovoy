import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  post, poll, pollOption, pollVote, property, userProperty, appUser, chairman,
  account, uk, managingOrg, house,
} from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { looseHouseKey } from '../address/normalize.ts';
import { notify } from '../notify/index.ts';
import { postsWithPhoto } from './photos.ts';
import { readPostIds } from './reads.ts';
import type { Database } from '../../db/client.ts';
import { ratingsFor } from '../pick/reviews.ts';

/**
 * Жизнь дома: объявления УК, объявления соседей, опросы.
 *
 * Всё привязано к houseKey — нормализованному ключу дома из адреса
 * квитанции. Именно он сводит жильцов одного подъездного адреса вместе,
 * независимо от того, как их адрес записан в разных квитанциях.
 *
 * ПРО ОПРОСЫ. Это опросы, а не общее собрание собственников. ОСС по ЖК РФ
 * требует подсчёта по долям в праве собственности, кворума, реестра
 * собственников и протокола. Мы этого не делаем и нигде не обещаем —
 * формулировки в интерфейсе должны оставаться честными.
 */

export const POST_CATEGORIES = ['outage', 'meeting', 'news', 'market'] as const;
export type PostCategory = (typeof POST_CATEGORIES)[number];

export const POST_CATEGORY_LABEL: Record<PostCategory, string> = {
  outage: 'Отключение',
  meeting: 'Собрание',
  news: 'Новость',
  market: 'Соседи предлагают',
};

/**
 * Дома организации из реестра.
 *
 * Это НЕ список домов, где кто-то зарегистрировался: реестр знает дом
 * задолго до первого жителя. УК видит свой жилищный фонд сразу после
 * подключения и может публиковать объявления и назначать председателей,
 * не дожидаясь, пока кто-нибудь отсканирует квитанцию.
 */
export async function orgHouses(db: Database, orgId: string) {
  const houses = await db
    .select()
    .from(house)
    .where(eq(house.registryOrgId, orgId))
    .orderBy(house.addressRaw);

  // Сколько жителей уже пришло в каждый дом — по объектам с тем же ключом
  const rows = await db
    .select({ houseKey: property.houseKey, propertyId: property.id })
    .from(property)
    .where(eq(property.managingOrgId, orgId));

  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(r.houseKey, (byKey.get(r.houseKey) ?? 0) + 1);

  const ratings = await ratingsFor(db, houses.map((h) => h.houseKey));

  return houses.map((h) => ({
    houseKey: h.houseKey,
    address: h.addressRaw,
    flatCount: h.flatCount,
    gisHouseGuid: h.gisHouseGuid,
    /** Сколько квартир этого дома уже заведено жителями */
    linkedProperties: byKey.get(h.houseKey) ?? 0,
    /** Оценка жителей из подбора дома и число отзывов: УК видит, как её оценивают */
    rating: ratings.get(h.houseKey)?.rating ?? null,
    reviews: ratings.get(h.houseKey)?.count ?? 0,
  }));
}

/**
 * Дом обслуживается этой организацией?
 *
 * Проверяем по РЕЕСТРУ, а не по тому, завёл ли кто-то из жильцов объект.
 * Иначе УК не может опубликовать объявление в собственный дом до того,
 * как туда придёт первый житель, — а объявления как раз и нужны, чтобы
 * жители пришли.
 */
export async function orgOwnsHouse(
  db: Database,
  orgId: string,
  houseKey: string,
): Promise<boolean> {
  const rows = await db
    .select({ houseKey: house.houseKey })
    .from(house)
    .where(and(eq(house.registryOrgId, orgId), eq(house.houseKey, houseKey)))
    .limit(1);
  return Boolean(rows[0]);
}

export type AddHouseResult =
  | { ok: true; houseKey: string; address: string; alreadyMine: boolean }
  | { ok: false; reason: 'bad_address' | 'taken'; byOrg?: string };

/**
 * УК добавляет свой дом руками.
 *
 * Нужно по двум причинам. Первая: треть организаций реестра ГИС ЖКХ
 * не отдаёт свои дома, и без ручного ввода их жители остаются без УК.
 * Вторая: дом мог сменить компанию только что, а реестр обновляется
 * с задержкой в недели.
 *
 * Чужой дом забрать нельзя: если он уже закреплён за другой организацией,
 * говорим об этом прямо. Разбирать спор двух УК за дом — не дело
 * приложения, это вопрос лицензии и жилищной инспекции.
 */
export async function addHouseToOrg(
  db: Database,
  orgId: string,
  addressRaw: string,
): Promise<AddHouseResult> {
  const { parseAddress } = await import('../address/normalize.ts');
  const parsed = parseAddress(addressRaw);

  if (!parsed.houseKey || !parsed.house) return { ok: false, reason: 'bad_address' };

  const existing = await db
    .select({ orgId: house.registryOrgId, humanOrgId: house.orgId })
    .from(house)
    .where(eq(house.houseKey, parsed.houseKey))
    .limit(1);

  /**
   * Чужой — и по реестру, и по слову оператора.
   *
   * Смотрели только реестровую УК, и дом ТСЖ, закреплённый оператором
   * (человеческий слой `org_id`), любая УК забирала одной формой (аудит
   * 26 сентября). Реестр сильнее оператора — поэтому он первый.
   */
  const takenBy = existing[0]?.orgId ?? existing[0]?.humanOrgId;
  if (takenBy && takenBy !== orgId) {
    const owner = await db
      .select({ name: managingOrg.shortName, full: managingOrg.name })
      .from(managingOrg)
      .where(eq(managingOrg.id, takenBy))
      .limit(1);

    return { ok: false, reason: 'taken', byOrg: owner[0]?.name ?? owner[0]?.full };
  }

  if (takenBy) {
    return { ok: true, houseKey: parsed.houseKey, address: addressRaw, alreadyMine: true };
  }

  const org = await db
    .select({ regionCode: managingOrg.regionCode, licenseNumber: managingOrg.licenseNumber })
    .from(managingOrg)
    .where(eq(managingOrg.id, orgId))
    .limit(1);

  const loose = looseHouseKey(addressRaw);
  // Лицензия выдаётся только на управление МКД — это и есть форма 'uk'
  const registryForm = org[0]?.licenseNumber ? 'uk' : 'unknown';

  /**
   * Дом мог уже лежать в наборе региона без организации: частным,
   * ТСЖ без ИНН или просто домом ГАР. Тогда организация дописывается
   * в его строку, а адрес набора — в написании реестра — остаётся.
   */
  await db
    .insert(house)
    .values({
      houseKey: parsed.houseKey,
      // Запасной ключ: житель мог прийти с квитанции, где региона нет
      houseKeyLoose: loose,
      registryOrgId: orgId,
      registryForm,
      regionCode: org[0]?.regionCode ?? '00',
      addressRaw,
      importedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: house.houseKey,
      set: {
        registryOrgId: orgId,
        registryForm,
        addressRaw: sql`coalesce(${house.addressRaw}, excluded.address_raw)`,
        houseKeyLoose: sql`coalesce(${house.houseKeyLoose}, excluded.house_key_loose)`,
        regionCode: sql`coalesce(${house.regionCode}, excluded.region_code)`,
      },
    });

  /**
   * Объекты жителей, которые пришли раньше, догоняем сразу.
   *
   * Иначе человек, привязавшийся до того, как УК добавила его дом,
   * так и остался бы без управляющей организации до следующего скана.
   */
  await db
    .update(property)
    .set({ managingOrgId: orgId })
    .where(and(eq(property.houseKey, parsed.houseKey), isNull(property.managingOrgId)));

  /**
   * И те, чей адрес записан без региона.
   *
   * УК добавляет дом полной строкой, с областью. Житель приходит
   * с квитанции, которая region не печатает, — строгие ключи у них
   * разные, и догон прошёл бы мимо ровно тех, ради кого он сделан.
   *
   * Ключ квартиры выравниваем по дому: иначе сосед с регионом и сосед
   * без региона окажутся в разных лентах одного дома.
   */
  if (loose) {
    const strays = await db
      .select({ id: property.id, addressRaw: property.addressRaw, flat: property.flat })
      .from(property)
      .where(isNull(property.managingOrgId));

    for (const stray of strays) {
      if (looseHouseKey(stray.addressRaw) !== loose) continue;

      /**
       * Уникальность объекта — пара «дом + квартира». Если под реестровым
       * ключом такая квартира уже есть, ключ не меняем: два жителя одной
       * квартиры разберутся привязкой, а падать здесь нельзя — команда
       * добавления дома не должна ломаться из-за чужой записи.
       */
      const [taken] = await db
        .select({ id: property.id })
        .from(property)
        .where(and(eq(property.houseKey, parsed.houseKey), eq(property.flat, stray.flat)));

      await db
        .update(property)
        .set({
          managingOrgId: orgId,
          ...(taken && taken.id !== stray.id ? {} : { houseKey: parsed.houseKey }),
        })
        .where(eq(property.id, stray.id));
    }
  }

  return { ok: true, houseKey: parsed.houseKey, address: addressRaw, alreadyMine: false };
}

/** Организация из реестра: её показывают и жителю, и в кабинете. */
export async function orgById(db: Database, orgId: string) {
  const rows = await db.select().from(managingOrg).where(eq(managingOrg.id, orgId)).limit(1);
  const org = rows[0];
  return org ? { ...org, shortName: org.shortName ?? org.name } : null;
}

/** Дома, к которым у человека есть доступ. */
export async function houseKeysFor(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ houseKey: property.houseKey })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(and(eq(userProperty.userId, userId), eq(userProperty.status, 'active')));

  return [...new Set(rows.map((r) => r.houseKey).filter(Boolean))];
}

export async function houseFeed(
  db: Database,
  userId: string,
  category?: PostCategory,
) {
  const keys = await houseKeysFor(db, userId);
  if (keys.length === 0) return [];

  const rows = await db
    .select({
      id: post.id,
      type: post.type,
      category: post.category,
      title: post.title,
      body: post.body,
      contact: post.contact,
      publishedAt: post.publishedAt,
      expiresAt: post.expiresAt,
      authorName: appUser.fullName,
      authorId: post.authorId,
      chairmanName: chairman.name,
      sharePhone: post.sharePhone,
      authorPhone: appUser.phone,
      authorPhoneVerifiedAt: appUser.phoneVerifiedAt,
      authorMaxUsername: appUser.maxUsername,
    })
    .from(post)
    .leftJoin(appUser, eq(post.authorId, appUser.id))
    .leftJoin(chairman, eq(post.chairmanId, chairman.id))
    .where(category
      ? and(inArray(post.houseKey, keys), eq(post.category, category), isNull(post.removedAt))
      : and(inArray(post.houseKey, keys), isNull(post.removedAt)))
    .orderBy(desc(post.publishedAt));

  const now = Date.now();

  /**
   * Есть ли у объявления фотография — одним запросом на весь список.
   * Спрашивать по строке значило бы полсотни запросов на открытие ленты.
   */
  const withPhoto = await postsWithPhoto(db, rows.map((r) => r.id));

  /**
   * Что человек уже открывал.
   *
   * Прочитанным считается открытая КАРТОЧКА, а не показанная строка
   * списка: иначе лента объявляла бы прочитанными заголовки, которые
   * человек только увидел, пролистывая.
   */
  const read = await readPostIds(db, userId, rows.map((r) => r.id));

  return rows.map(({ sharePhone, authorPhone, authorPhoneVerifiedAt, authorMaxUsername, ...r }) => ({
    ...r,
    /**
     * Контакт автора — только если он сам поделился, и только
     * подтверждённый MAX телефон. Номер из профиля, а не копия
     * в объявлении: убрал номер — пропал и из старых объявлений.
     */
    phone: sharePhone && authorPhoneVerifiedAt ? authorPhone : null,
    maxUsername: sharePhone ? authorMaxUsername : null,
    /** Своё объявление: кнопок «Позвонить» и «Написать» на нём нет */
    mine: r.authorId === userId,
    categoryLabel: POST_CATEGORY_LABEL[r.category as PostCategory] ?? r.category,
    /** Сам файл отдаётся отдельным маршрутом с проверкой доступа */
    hasPhoto: withPhoto.has(r.id),
    /**
     * Доска соседей прочитанности не знает: это витрина, а не почта.
     * Предложение не «прочитывают» — его смотрят и забывают, и деление
     * на прочитанные там только мешало бы.
     */
    unread: r.category === 'market' ? false : !read.has(r.id),
    /**
     * Объявление, срок которого вышел.
     *
     * Из ленты не убираем — история дома должна оставаться читаемой, —
     * но помечаем: «нет воды до 18:00» назавтра вводит в заблуждение,
     * даже если формально это правдивая запись от вчера.
     */
    expired: r.expiresAt !== null && r.expiresAt.getTime() <= now,
    // Объявления УК подписываем компанией, председателя — должностью
    // и именем, соседские — именем автора
    author: r.type === 'uk'
      ? 'Управляющая компания'
      : r.type === 'chair'
        ? `Председатель совета дома${r.chairmanName ? ` · ${r.chairmanName}` : ''}`
        : (r.authorName ?? 'Сосед'),
  }));
}

/**
 * Снятие объявления.
 *
 * Мягкое: строка остаётся в базе. Жёсткое удаление лишает дом истории —
 * «а было ли вообще объявление про отключение?» станет неразрешимым
 * спором между УК и жителями.
 */
export async function removePost(
  db: Database,
  postId: string,
  /**
   * `types` ограничивает, ЧЬИ объявления можно снимать.
   *
   * Без него председатель, у которого проверялся только дом, снимал
   * аварийное объявление управляющей компании: её объявление относится
   * к тому же дому и проверку проходило. Права председателя описаны
   * как «выше жителя, ниже УК» — значит трогать он может только
   * публикации совета дома, включая своего предшественника.
   */
  scope: { ukId?: string; houseKey?: string; types?: readonly string[] },
): Promise<boolean> {
  const rows = await db
    .select({
      id: post.id,
      ukId: post.orgId,
      houseKey: post.houseKey,
      type: post.type,
      removedAt: post.removedAt,
    })
    .from(post)
    .where(eq(post.id, postId))
    .limit(1);

  const found = rows[0];
  if (!found || found.removedAt) return false;
  if (scope.ukId && found.ukId !== scope.ukId) return false;
  if (scope.houseKey && found.houseKey !== scope.houseKey) return false;
  if (scope.types && !scope.types.includes(found.type)) return false;

  await db.update(post).set({ removedAt: new Date() }).where(eq(post.id, postId));
  return true;
}

/** Объявления дома для того, кто их публикует: со снятыми и истёкшими. */
export async function managedPosts(
  db: Database,
  scope: { ukId?: string; houseKeys?: string[] },
) {
  const conditions = [];
  if (scope.ukId) conditions.push(eq(post.orgId, scope.ukId));
  if (scope.houseKeys) conditions.push(inArray(post.houseKey, scope.houseKeys));

  const rows = await db
    .select({
      id: post.id,
      houseKey: post.houseKey,
      type: post.type,
      category: post.category,
      title: post.title,
      body: post.body,
      publishedAt: post.publishedAt,
      expiresAt: post.expiresAt,
      removedAt: post.removedAt,
      chairmanName: chairman.name,
    })
    .from(post)
    .leftJoin(chairman, eq(post.chairmanId, chairman.id))
    .where(conditions.length > 1 ? and(...conditions) : conditions[0])
    .orderBy(desc(post.publishedAt));

  const now = Date.now();

  // Объявления соседей УК и председатель не модерируют: доска «купи-продай»
  // не их зона, а вмешательство в неё — прямой путь к жалобам на цензуру
  return rows
    .filter((r) => r.type !== 'resident')
    .map((r) => ({
      ...r,
      categoryLabel: POST_CATEGORY_LABEL[r.category as PostCategory] ?? r.category,
      expired: r.expiresAt !== null && r.expiresAt.getTime() <= now,
      removed: r.removedAt !== null,
      author: r.type === 'uk'
        ? 'Управляющая компания'
        : `Председатель совета дома${r.chairmanName ? ` · ${r.chairmanName}` : ''}`,
    }));
}

export interface CreatePostInput {
  houseKey: string;
  ukId: string | null;
  authorId: string | null;
  chairmanId?: string | null;
  type: 'uk' | 'resident' | 'chair';
  category: PostCategory;
  title: string;
  body: string;
  contact?: string;
  /** Показать соседям подтверждённый телефон и ник MAX автора */
  sharePhone?: boolean;
  expiresAt?: Date | null;
}

export async function createPost(db: Database, input: CreatePostInput): Promise<string> {
  const id = newId('pst');
  await db.insert(post).values({
    id,
    houseKey: input.houseKey,
    orgId: input.ukId,
    authorId: input.authorId,
    type: input.type,
    category: input.category,
    chairmanId: input.chairmanId ?? null,
    title: input.title.slice(0, 160),
    body: input.body,
    contact: input.contact ?? null,
    sharePhone: input.sharePhone === true,
    expiresAt: input.expiresAt ?? null,
  });
  return id;
}

/**
 * Рассылка объявления УК жильцам дома.
 *
 * Аварийные отключения — единственное, ради чего стоит будить людей
 * уведомлением. Новости и собрания человек прочитает, когда зайдёт сам.
 */
/**
 * Срок актуальности словами — строкой в конце сообщения бота.
 *
 * Ради него срок и вводят: «нет воды до 18:00» — это главное, что нужно
 * знать человеку, а раньше он вынужден был открывать мини-приложение,
 * чтобы это выяснить.
 *
 * Без срока строки нет. Приписывать «бессрочно» не надо: у новости
 * и собрания срок не ставят, и лишняя строка в каждом сообщении — шум.
 */
export function expiryLine(expiresAt: Date | null | undefined): string {
  if (!expiresAt) return '';

  const day = expiresAt.getDate();
  const month = MONTHS_IN[expiresAt.getMonth()];
  const time = `${String(expiresAt.getHours()).padStart(2, '0')}`
    + `:${String(expiresAt.getMinutes()).padStart(2, '0')}`;

  // Год пишем только для прошлых и будущих лет — как на экранах
  const year = expiresAt.getFullYear() === new Date().getFullYear()
    ? ''
    : ` ${expiresAt.getFullYear()}`;

  return `Актуально до ${day} ${month}${year}, ${time}`;
}

const MONTHS_IN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export async function notifyHouse(
  db: Database,
  houseKey: string,
  title: string,
  body: string,
  expiresAt?: Date | null,
): Promise<number> {
  const residents = await db
    .selectDistinct({ userId: userProperty.userId })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(and(eq(property.houseKey, houseKey), eq(userProperty.status, 'active')));

  let sent = 0;
  for (const r of residents) {
    const result = await notify(db, {
      userId: r.userId,
      kind: 'outage',
      title,
      body: [body, expiryLine(expiresAt)].filter(Boolean).join('\n\n'),
      deepLinkPayload: 'feed',
    }).catch(() => ({ sent: false }));
    if (result.sent) sent++;
  }
  return sent;
}

/**
 * УК подтверждает адрес, который житель выбрал сам.
 *
 * Пока подтверждения нет, интерфейс обязан говорить «указан жителем»:
 * связка «лицевой счёт → квартира» есть только в биллинге УК, и лишь она
 * может сверить одно с другим. Выдавать непроверенный адрес за данные
 * компании — то же враньё, что «оплачено» вместо «по вашим отметкам».
 */
export async function verifyPropertyAddress(
  db: Database,
  ukId: string,
  propertyId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: property.id })
    .from(property)
    .where(and(eq(property.id, propertyId), eq(property.managingOrgId, ukId)))
    .limit(1);
  if (!rows[0]) return false;

  await db
    .update(property)
    .set({ addressSource: 'uk', addressVerifiedAt: new Date() })
    .where(eq(property.id, propertyId));
  return true;
}

/* ─────────────── опросы ─────────────── */

export interface CreatePollInput {
  /** Организации может не быть: ТСЖ, непосредственное управление, частный дом */
  ukId: string | null;
  chairmanId?: string | null;
  houseKey: string;
  title: string;
  description?: string;
  options: string[];
  closesAt?: Date;
}

/**
 * Границы опроса.
 *
 * Верхних не было вовсе: проходил опрос с пятьюстами вариантами, каждый
 * своим INSERT внутри одного HTTP-запроса, и дальше он грузился целиком
 * у каждого жителя дома. Числа выбраны по здравому смыслу — опрос дома
 * это «за/против» и несколько вариантов подрядчика, а не анкета.
 */
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_OPTION_LENGTH = 200;
export const POLL_MAX_TITLE_LENGTH = 200;
export const POLL_MAX_DESCRIPTION_LENGTH = 2000;

export type PollProblem =
  'too_few_options' | 'too_many_options' | 'option_too_long' | 'title_too_long';

export type CreatePollResult =
  | { ok: true; id: string }
  | { ok: false; reason: PollProblem };

/** Тексты для человека держим рядом с правилами: разъедутся — сразу видно. */
export const POLL_ERRORS: Record<PollProblem, string> = {
  too_few_options: 'Нужно хотя бы два варианта ответа',
  too_many_options: `Вариантов должно быть не больше ${POLL_MAX_OPTIONS}`,
  option_too_long: `Вариант ответа длиннее ${POLL_MAX_OPTION_LENGTH} символов`,
  title_too_long: `Заголовок длиннее ${POLL_MAX_TITLE_LENGTH} символов`,
};

export async function createPoll(
  db: Database,
  input: CreatePollInput,
): Promise<CreatePollResult> {
  const options = input.options
    .map((o) => (typeof o === 'string' ? o.trim() : ''))
    .filter(Boolean);

  // Опрос с одним вариантом — не опрос
  if (options.length < 2) return { ok: false, reason: 'too_few_options' };
  if (options.length > POLL_MAX_OPTIONS) return { ok: false, reason: 'too_many_options' };
  if (options.some((o) => o.length > POLL_MAX_OPTION_LENGTH)) {
    return { ok: false, reason: 'option_too_long' };
  }
  if (input.title.length > POLL_MAX_TITLE_LENGTH) return { ok: false, reason: 'title_too_long' };

  const id = newId('pol');
  await db.insert(poll).values({
    id,
    orgId: input.ukId,
    chairmanId: input.chairmanId ?? null,
    houseKey: input.houseKey,
    title: input.title,
    description: input.description?.slice(0, POLL_MAX_DESCRIPTION_LENGTH) ?? null,
    closesAt: input.closesAt ?? null,
    status: 'open',
  });

  // Одним запросом, а не по варианту: их немного, но и десять круговых
  // обращений к базе на ровном месте не нужны
  await db.insert(pollOption).values(
    options.map((text, position) => ({ id: newId('opt'), pollId: id, text, position })),
  );

  return { ok: true, id };
}

/**
 * Опросы дома для того, кто их ведёт.
 *
 * Без «моего голоса»: у УК и председателя нет аккаунта жителя, голосовать
 * они не могут — им нужны только результаты и явка.
 */
export async function listPollsForHouses(db: Database, houseKeys: string[]) {
  if (houseKeys.length === 0) return [];

  const polls = await db
    .select()
    .from(poll)
    .where(inArray(poll.houseKey, houseKeys))
    .orderBy(desc(poll.opensAt));

  return Promise.all(polls.map(async (p) => {
    const options = await db
      .select()
      .from(pollOption)
      .where(eq(pollOption.pollId, p.id))
      .orderBy(pollOption.position);

    const counts = await db
      .select({ optionId: pollVote.optionId, n: sql<number>`count(*)::int` })
      .from(pollVote)
      .where(eq(pollVote.pollId, p.id))
      .groupBy(pollVote.optionId);

    const total = counts.reduce((sum, c) => sum + Number(c.n), 0);
    const closed = p.status === 'closed'
      || (p.closesAt !== null && p.closesAt.getTime() < Date.now());

    return {
      id: p.id,
      houseKey: p.houseKey,
      title: p.title,
      description: p.description,
      closesAt: p.closesAt,
      closed,
      total,
      byChairman: p.chairmanId !== null,
      options: options.map((o) => ({
        id: o.id,
        text: o.text,
        votes: Number(counts.find((c) => c.optionId === o.id)?.n ?? 0),
      })),
    };
  }));
}

export async function listPolls(db: Database, userId: string) {
  const keys = await houseKeysFor(db, userId);
  if (keys.length === 0) return [];

  const polls = await db
    .select()
    .from(poll)
    .where(inArray(poll.houseKey, keys))
    .orderBy(desc(poll.opensAt));

  return Promise.all(polls.map((p) => decoratePoll(db, p, userId)));
}

export async function getPoll(db: Database, userId: string, pollId: string) {
  const keys = await houseKeysFor(db, userId);
  const rows = await db.select().from(poll).where(eq(poll.id, pollId)).limit(1);
  if (!rows[0] || !keys.includes(rows[0].houseKey)) return null;
  return decoratePoll(db, rows[0], userId);
}

async function decoratePoll(
  db: Database,
  p: typeof poll.$inferSelect,
  userId: string,
) {
  const options = await db
    .select()
    .from(pollOption)
    .where(eq(pollOption.pollId, p.id))
    .orderBy(pollOption.position);

  const counts = await db
    .select({ optionId: pollVote.optionId, n: sql<number>`count(*)::int` })
    .from(pollVote)
    .where(eq(pollVote.pollId, p.id))
    .groupBy(pollVote.optionId);

  const mine = await db
    .select({ optionId: pollVote.optionId })
    .from(pollVote)
    .where(and(eq(pollVote.pollId, p.id), eq(pollVote.userId, userId)))
    .limit(1);

  const total = counts.reduce((sum, c) => sum + Number(c.n), 0);
  const closed = p.status === 'closed'
    || (p.closesAt !== null && p.closesAt.getTime() < Date.now());
  const myOptionId = mine[0]?.optionId ?? null;

  /**
   * Результаты показываем только тем, кто уже проголосовал, или после
   * закрытия. Иначе первые ответы тянут за собой все остальные.
   */
  const showResults = closed || myOptionId !== null;

  return {
    id: p.id,
    title: p.title,
    description: p.description,
    closesAt: p.closesAt,
    closed,
    myOptionId,
    total,
    showResults,
    // Опрос, а не ОСС — говорим это прямо в данных, чтобы не забылось в вёрстке
    legalNotice: 'Опрос жителей. Юридической силы общего собрания не имеет.',
    options: options.map((o) => {
      const n = Number(counts.find((c) => c.optionId === o.id)?.n ?? 0);
      return {
        id: o.id,
        text: o.text,
        votes: showResults ? n : null,
        percent: showResults && total > 0 ? Math.round((n / total) * 100) : null,
      };
    }),
  };
}

export type VoteResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'closed' | 'bad_option' };

export async function vote(
  db: Database,
  userId: string,
  pollId: string,
  optionId: string,
): Promise<VoteResult> {
  const keys = await houseKeysFor(db, userId);
  const rows = await db.select().from(poll).where(eq(poll.id, pollId)).limit(1);
  const p = rows[0];
  if (!p || !keys.includes(p.houseKey)) return { ok: false, reason: 'not_found' };

  if (p.status === 'closed' || (p.closesAt && p.closesAt.getTime() < Date.now())) {
    return { ok: false, reason: 'closed' };
  }

  const option = await db
    .select()
    .from(pollOption)
    .where(and(eq(pollOption.id, optionId), eq(pollOption.pollId, pollId)))
    .limit(1);
  if (!option[0]) return { ok: false, reason: 'bad_option' };

  // Один голос на человека: повторный выбор переставляет голос, а не добавляет
  await db
    .insert(pollVote)
    .values({ id: newId('vot'), pollId, optionId, userId })
    .onConflictDoUpdate({
      target: [pollVote.pollId, pollVote.userId],
      set: { optionId, createdAt: new Date() },
    });

  return { ok: true };
}

/**
 * Объекты дома и их лицевые счета — для кабинета УК.
 *
 * У квартиры счетов бывает несколько: ЖКУ, свет, газ, вывоз мусора.
 * Показываем один объект со списком счетов, а не одну строку на счёт:
 * иначе дом на сотню квартир превращается в четыре сотни строк.
 */
export async function houseAccounts(db: Database, ukId: string) {
  const rows = await db
    .select({
      propertyId: property.id,
      persAcc: account.persAcc,
      service: account.service,
      providerName: uk.name,
      flat: property.flat,
      addressRaw: property.addressRaw,
      houseKey: property.houseKey,
      addressSource: property.addressSource,
      addressVerifiedAt: property.addressVerifiedAt,
      userName: appUser.fullName,
      role: userProperty.role,
      status: userProperty.status,
    })
    .from(property)
    .leftJoin(account, eq(account.propertyId, property.id))
    .leftJoin(uk, eq(uk.id, account.ukId))
    .leftJoin(userProperty, and(
      eq(userProperty.propertyId, property.id),
      eq(userProperty.status, 'active'),
    ))
    .leftJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(eq(property.managingOrgId, ukId));

  const byProperty = new Map<string, {
    propertyId: string;
    flat: string | null; address: string; houseKey: string;
    /** Адрес выбран жителем и ещё не сверен управляющей компанией */
    addressSource: string; addressVerified: boolean;
    accounts: { persAcc: string; service: string; provider: string | null }[];
    residents: { name: string; role: string }[];
  }>();

  for (const r of rows) {
    const entry = byProperty.get(r.propertyId) ?? {
      propertyId: r.propertyId,
      flat: r.flat,
      address: r.addressRaw,
      houseKey: r.houseKey,
      addressSource: r.addressSource,
      addressVerified: r.addressVerifiedAt !== null,
      accounts: [],
      residents: [],
    };
    if (r.persAcc && !entry.accounts.some((a) => a.persAcc === r.persAcc)) {
      entry.accounts.push({
        persAcc: r.persAcc,
        service: r.service ?? 'other',
        provider: r.providerName,
      });
    }
    if (r.userName && !entry.residents.some((x) => x.name === r.userName)) {
      entry.residents.push({ name: r.userName, role: r.role ?? 'member' });
    }
    byProperty.set(r.propertyId, entry);
  }

  /**
   * Сортировка по номеру квартиры, а не по строке.
   *
   * Раньше стояло `Number(a.flat) - Number(b.flat)`, а квартиры бывают
   * «15а» и «4/1» — `Number` давал NaN, компаратор возвращал NaN, и порядок
   * строк становился неопределённым: диспетчер искал квартиру глазами
   * в перемешанном списке. Разбираем номер и букву отдельно, нечисловые
   * уводим в конец.
   */
  const flatOrder = (flat: string | null) => {
    const match = /^(\d+)(.*)$/.exec((flat ?? '').trim());
    return match
      ? { number: Number(match[1]), rest: match[2] }
      : { number: Number.MAX_SAFE_INTEGER, rest: flat ?? '' };
  };

  return [...byProperty.entries()]
    .map(([id, v]) => ({ id, ...v, registered: v.residents.length > 0 }))
    .sort((a, b) => {
      const left = flatOrder(a.flat);
      const right = flatOrder(b.flat);
      return left.number - right.number || left.rest.localeCompare(right.rest, 'ru');
    });
}
