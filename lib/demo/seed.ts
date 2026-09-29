import { and, eq, inArray, or } from 'drizzle-orm';
import {
  account, appUser, bill, billBringer, botDraft, chairman, demoRelease, demoRole, dispatcher,
  house, houseClaim, houseContact, houseFavorite, houseReview, invite, managingOrg, meter,
  meterReading, notification, poll, pollOption, pollVote, post, postPhoto, postRead, property,
  rating, request, requestEvent, requestPhoto, reviewPrompt, session, uk, userProperty,
} from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { generatePassword, hashPassword } from '../auth/password.ts';
import { numberScopeFor } from '../requests/addressee.ts';
import { slaDueAt } from '../requests/sla.ts';
import { saveAttachment } from '../requests/attachments.ts';
import type { Database } from '../../db/client.ts';
import {
  DEMO_ADDRESS, DEMO_CLAIMANTS, DEMO_ELEC_INN, DEMO_GAS_INN, DEMO_HOUSE_KEY, DEMO_LAT, DEMO_LON,
  DEMO_NEIGHBOURS, DEMO_ORG_INN, DEMO_ROLES, DEMO_UK_LOGIN,
} from './constants.ts';
import { solidPng } from './png.ts';
import { setDemoEnabled } from './setting.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Стереть демо-дом целиком. Порядок — от зависимых к главным.
 * Всё находится по ключу дома, его квартирам, их жителям и ИНН демо-УК:
 * вне этих множеств не трогается ни одна строка.
 */
export async function clearDemo(db: Database): Promise<void> {
  const props = (await db.select({ id: property.id }).from(property)
    .where(eq(property.houseKey, DEMO_HOUSE_KEY))).map((r) => r.id);
  const bound = props.length
    ? (await db.select({ id: userProperty.userId }).from(userProperty)
      .where(inArray(userProperty.propertyId, props))).map((r) => r.id)
    : [];
  const personas = (await db.select({ id: demoRole.userId }).from(demoRole)).map((r) => r.id);
  const users = [...new Set([...bound, ...personas])];
  const orgs = (await db.select({ id: managingOrg.id }).from(managingOrg)
    .where(eq(managingOrg.inn, DEMO_ORG_INN))).map((r) => r.id);
  const reqs = props.length
    ? (await db.select({ id: request.id }).from(request).where(inArray(request.propertyId, props))).map((r) => r.id)
    : [];
  const bills = props.length
    ? (await db.select({ id: bill.id }).from(bill).where(inArray(bill.propertyId, props))).map((r) => r.id)
    : [];
  const meters = props.length
    ? (await db.select({ id: meter.id }).from(meter).where(inArray(meter.propertyId, props))).map((r) => r.id)
    : [];
  const posts = (await db.select({ id: post.id }).from(post).where(eq(post.houseKey, DEMO_HOUSE_KEY))).map((r) => r.id);
  const polls = (await db.select({ id: poll.id }).from(poll).where(eq(poll.houseKey, DEMO_HOUSE_KEY))).map((r) => r.id);

  await db.delete(demoRole);
  await db.delete(demoRelease);
  if (reqs.length) {
    await db.delete(rating).where(inArray(rating.requestId, reqs));
    await db.delete(requestPhoto).where(inArray(requestPhoto.requestId, reqs));
    await db.delete(requestEvent).where(inArray(requestEvent.requestId, reqs));
    await db.delete(request).where(inArray(request.id, reqs));
  }
  if (bills.length) {
    await db.delete(billBringer).where(inArray(billBringer.billId, bills));
    await db.delete(bill).where(inArray(bill.id, bills));
  }
  if (meters.length) {
    await db.delete(meterReading).where(inArray(meterReading.meterId, meters));
    await db.delete(meter).where(inArray(meter.id, meters));
  }
  if (posts.length) {
    await db.delete(postRead).where(inArray(postRead.postId, posts));
    await db.delete(postPhoto).where(inArray(postPhoto.postId, posts));
    await db.delete(post).where(inArray(post.id, posts));
  }
  if (polls.length) {
    await db.delete(pollVote).where(inArray(pollVote.pollId, polls));
    await db.delete(pollOption).where(inArray(pollOption.pollId, polls));
    await db.delete(poll).where(inArray(poll.id, polls));
  }
  await db.delete(houseContact).where(eq(houseContact.houseKey, DEMO_HOUSE_KEY));
  await db.delete(houseReview).where(eq(houseReview.houseKey, DEMO_HOUSE_KEY));
  await db.delete(houseFavorite).where(eq(houseFavorite.houseKey, DEMO_HOUSE_KEY));
  await db.delete(reviewPrompt).where(eq(reviewPrompt.houseKey, DEMO_HOUSE_KEY));
  if (props.length) {
    await db.delete(invite).where(inArray(invite.propertyId, props));
    await db.delete(account).where(inArray(account.propertyId, props));
    await db.delete(botDraft).where(inArray(botDraft.propertyId, props));
    await db.delete(userProperty).where(inArray(userProperty.propertyId, props));
  }
  await db.delete(chairman).where(eq(chairman.houseKey, DEMO_HOUSE_KEY));
  if (users.length) {
    await db.delete(session).where(inArray(session.userId, users));
    await db.delete(notification).where(inArray(notification.userId, users));
    await db.delete(houseClaim).where(inArray(houseClaim.userId, users));
    await db.delete(houseFavorite).where(inArray(houseFavorite.userId, users));
    await db.delete(reviewPrompt).where(inArray(reviewPrompt.userId, users));
    await db.delete(appUser).where(inArray(appUser.id, users));
  }
  if (props.length) await db.delete(property).where(inArray(property.id, props));
  if (orgs.length) {
    const disp = (await db.select({ id: dispatcher.id }).from(dispatcher).where(inArray(dispatcher.orgId, orgs))).map((r) => r.id);
    if (disp.length) await db.delete(session).where(inArray(session.dispatcherId, disp));
    await db.delete(dispatcher).where(inArray(dispatcher.orgId, orgs));
  }
  await db.delete(house).where(eq(house.houseKey, DEMO_HOUSE_KEY));
  if (orgs.length) await db.delete(managingOrg).where(inArray(managingOrg.id, orgs));
  await db.delete(uk).where(or(eq(uk.inn, DEMO_ORG_INN), eq(uk.inn, DEMO_ELEC_INN), eq(uk.inn, DEMO_GAS_INN)));
}

/** Период «YYYY-MM» за `back` месяцев до `now` */
function periodBack(now: Date, back: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Завести демо-дом заново. Идемпотентно: сначала `clearDemo`.
 * Все даты — от `now`, чтобы дом всегда выглядел «сегодняшним».
 * Возвращает логин и пароль кабинета демо-УК: пароль печатается один раз.
 */
export async function seedDemo(
  db: Database, now = new Date(), opts: { ukPassword?: string } = {},
): Promise<{ ukLogin: string; ukPassword: string }> {
  await clearDemo(db);
  const ago = (ms: number) => new Date(now.getTime() - ms);

  /* ── организация, дом, получатели платежей, кабинет ── */
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: DEMO_ORG_INN, name: 'ООО «УК Демо-Дом»', shortName: 'УК «Демо-Дом»',
    phone: '+7 (863) 000-00-01', regionCode: '61', licenseNumber: '061000000', houseCount: 1,
  });
  await db.insert(house).values({
    houseKey: DEMO_HOUSE_KEY, addressRaw: DEMO_ADDRESS, regionCode: '61',
    houseKind: 'mkd', garMkd: true, flatCount: 144, garFlats: 144, multiFlat: true,
    registryForm: 'uk', registryOrgId: orgId, builtYear: 1987, floors: 9, entrances: 4,
    elevators: 4, wallMaterial: 'Панельные', gas: true, emergency: false,
    lat: DEMO_LAT, lon: DEMO_LON, importedAt: now,
  });
  const payee = async (inn: string, name: string) => {
    const id = newId('uk');
    await db.insert(uk).values({ id, inn, name });
    return id;
  };
  const housingUk = await payee(DEMO_ORG_INN, 'ООО «УК Демо-Дом»');
  const elecUk = await payee(DEMO_ELEC_INN, 'Энергосбыт «Демо»');
  const gasUk = await payee(DEMO_GAS_INN, 'Газ «Демо»');

  const ukPassword = opts.ukPassword || generatePassword();
  const dispatcherId = newId('dsp');
  await db.insert(dispatcher).values({
    id: dispatcherId, orgId, login: DEMO_UK_LOGIN, passwordHash: await hashPassword(ukPassword),
    name: 'Диспетчер УК «Демо-Дом»',
  });

  /* ── квартиры и жители ── */
  const flats = new Map<string, string>();
  const flatId = async (flat: string) => {
    if (!flats.has(flat)) {
      const id = newId('prp');
      await db.insert(property).values({
        id, managingOrgId: orgId, houseKey: DEMO_HOUSE_KEY, flat,
        addressRaw: `${DEMO_ADDRESS}, кв. ${flat}`, city: 'Ростов-на-Дону',
        street: 'демонстрационная', house: '1', addressSource: 'receipt', addressVerifiedAt: now,
      });
      flats.set(flat, id);
    }
    return flats.get(flat)!;
  };
  const resident = async (p: {
    name: string; flat: string; role: 'owner' | 'member'; status: 'active' | 'pending';
    claimFlat?: string; claimNote?: string;
  }) => {
    const userId = newId('usr');
    await db.insert(appUser).values({ id: userId, fullName: p.name });
    await db.insert(userProperty).values({
      id: newId('ubd'), userId, propertyId: await flatId(p.flat), role: p.role, status: p.status,
      addressFromUser: true, claimName: p.name, claimFlat: p.claimFlat ?? p.flat,
      claimNote: p.claimNote ?? null, decidedAt: p.status === 'active' ? ago(60 * DAY) : null,
      createdAt: ago(p.status === 'active' ? 90 * DAY : 2 * DAY),
    });
    return userId;
  };

  const persona = new Map<string, string>();
  for (const [i, r] of DEMO_ROLES.entries()) {
    const userId = await resident(r);
    persona.set(r.key, userId);
    await db.insert(demoRole).values({ key: r.key, userId, title: r.title, subtitle: r.subtitle, position: i });
  }
  const neighbours: string[] = [];
  for (const n of DEMO_NEIGHBOURS) {
    neighbours.push(await resident({ ...n, role: 'owner', status: 'active' }));
  }
  for (const c of DEMO_CLAIMANTS) {
    await resident({ name: c.name, flat: c.flat, role: 'member', status: 'pending', claimFlat: c.claimFlat, claimNote: c.note });
  }

  const chairUser = persona.get('chairman')!;
  const chairmanId = newId('chr');
  await db.insert(chairman).values({
    id: chairmanId, orgId, houseKey: DEMO_HOUSE_KEY, userId: chairUser,
    name: 'Лебедева Ольга Викторовна', flat: '1', createdBySource: 'operator', createdAt: ago(60 * DAY),
  });

  /* ── деньги и счётчики квартир с ролями ── */
  const moneyFlats: [string, string][] = [
    ['1', chairUser], ['12', persona.get('owner12')!], ['45', persona.get('owner45')!],
    ['78', persona.get('owner78')!], ['30', persona.get('newcomer30')!],
  ];
  for (const [n, [flat, owner]] of moneyFlats.entries()) {
    const propertyId = await flatId(flat);
    const services: [string, string, number][] = [
      [housingUk, 'housing', 480_000 + n * 23_000], [elecUk, 'electricity', 110_000 + n * 9_000], [gasUk, 'gas', 42_000],
    ];
    for (const [ukId, service, base] of services) {
      const accountId = newId('acc');
      await db.insert(account).values({
        id: accountId, propertyId, ukId, service, persAcc: `9061${flat.padStart(4, '0')}${service.length}`,
      });
      for (let back = 5; back >= 0; back--) {
        // Неоплачен только текущий месяц: красное «просрочено» на всех квартирах пугало бы
        const paid = back >= 1;
        await db.insert(bill).values({
          id: newId('bil'), accountId, propertyId, period: periodBack(now, back),
          sumKopecks: base + ((back * 7919) % 30_000), source: 'qr_scan', createdBy: owner,
          paidAt: paid ? ago((back * 30 - 12) * DAY) : null, paidSource: paid ? 'resident' : null,
          createdAt: ago(back * 30 * DAY),
        });
      }
    }
    const kinds: [string, string | null, number, number][] = [
      ['cold', 'Кухня', 214, 4.2], ['hot', 'Кухня', 131, 2.6], ['elec', null, 18_420, 165],
    ];
    for (const [kind, place, start, step] of kinds) {
      const meterId = newId('mtr');
      await db.insert(meter).values({ id: meterId, propertyId, kind, place, createdBy: owner });
      for (let back = 5; back >= 1; back--) {
        await db.insert(meterReading).values({
          id: newId('rdg'), meterId, period: periodBack(now, back),
          value: String(Number((start + (6 - back) * step).toFixed(1))), createdBy: owner,
        });
      }
    }
  }
  await db.insert(invite).values({
    id: newId('inv'), propertyId: await flatId('12'), createdBy: persona.get('owner12')!,
    code: 'KV4M7P', role: 'member', expiresAt: new Date(now.getTime() + 2 * DAY),
  });

  /* ── лента, опросы, телефоны, отзывы ── */
  const postRow = (p: Partial<typeof post.$inferInsert> & Pick<typeof post.$inferInsert, 'type' | 'category' | 'title' | 'body'>) =>
    db.insert(post).values({ id: newId('pst'), houseKey: DEMO_HOUSE_KEY, ...p });
  await postRow({ orgId, type: 'uk', category: 'outage', title: 'Отключение горячей воды',
    body: 'Завтра с 9:00 до 18:00 — замена задвижки в подвале 2 подъезда.', publishedAt: ago(3 * HOUR),
    expiresAt: new Date(now.getTime() + 30 * HOUR) });
  await postRow({ chairmanId, authorId: chairUser, type: 'chair', category: 'meeting', title: 'Собрание во дворе в субботу',
    body: 'В 12:00 у 1 подъезда: шлагбаум, покраска подъездов, график уборки.', publishedAt: ago(2 * DAY) });
  await postRow({ orgId, type: 'uk', category: 'news', title: 'Поверка счётчиков без выезда в офис',
    body: 'Мастер УК проверит счётчики по записи — оставьте заявку в приложении.', publishedAt: ago(6 * DAY) });
  await postRow({ authorId: neighbours[2], type: 'resident', category: 'market', title: 'Отдам детскую коляску',
    body: 'Зимняя, в хорошем состоянии. Самовывоз из 17-й.', contact: 'кв. 17, вечером', publishedAt: ago(DAY) });
  await postRow({ authorId: neighbours[5], type: 'resident', category: 'market', title: 'Остались плитка и клей',
    body: 'После ремонта — 3 м² напольной плитки, мешок клея. Бесплатно.', contact: 'кв. 41', publishedAt: ago(4 * DAY) });
  await postRow({ authorId: neighbours[9], type: 'resident', category: 'market', title: 'Репетитор по математике',
    body: '5–9 класс, занимаюсь у себя в 88-й. Первое занятие бесплатно.', contact: 'кв. 88', publishedAt: ago(9 * DAY) });

  const pollWith = async (title: string, options: string[], open: boolean, votes: number[]) => {
    const pollId = newId('pol');
    await db.insert(poll).values({
      id: pollId, chairmanId, houseKey: DEMO_HOUSE_KEY, title, status: open ? 'open' : 'closed',
      opensAt: ago((open ? 3 : 20) * DAY),
      closesAt: open ? new Date(now.getTime() + 5 * DAY) : ago(10 * DAY), createdAt: ago((open ? 3 : 20) * DAY),
    });
    const ids: string[] = [];
    for (const [position, text] of options.entries()) {
      const optionId = newId('opt');
      ids.push(optionId);
      await db.insert(pollOption).values({ id: optionId, pollId, text, position });
    }
    for (const [i, optionIndex] of votes.entries()) {
      await db.insert(pollVote).values({ id: newId('vot'), pollId, optionId: ids[optionIndex], userId: neighbours[i] });
    }
  };
  await pollWith('Ставим шлагбаум на въезде во двор?', ['За', 'Против', 'Воздержусь'], true, [0, 0, 1, 0, 2, 0, 0, 1, 0]);
  await pollWith('Цвет стен в подъездах', ['Светло-бежевый', 'Серо-голубой', 'Оставить как есть'], false, [0, 1, 0, 0, 1, 0, 2, 0, 0, 1, 0]);

  const contact = (kind: string, phone: string, note: string) => db.insert(houseContact).values({
    id: newId('hct'), houseKey: DEMO_HOUSE_KEY, kind, phone, note,
    updatedByRole: 'chairman', updatedBy: 'Лебедева О. В.',
  });
  await contact('uk_dispatch', '+7 (863) 000-00-02', 'круглосуточно');
  await contact('lift', '+7 (863) 000-00-03', 'застрял лифт — сюда');
  await contact('intercom', '+7 (863) 000-00-04', 'ключи и ремонт домофона');

  const review = (i: number, s: [number, number, number, number, number], pros: string, cons: string) =>
    db.insert(houseReview).values({
      id: newId('rev'), houseKey: DEMO_HOUSE_KEY, userId: neighbours[i],
      starsUk: s[0], starsClean: s[1], starsNeighbors: s[2], starsQuiet: s[3], starsYard: s[4], pros, cons,
    });
  await review(0, [4, 4, 5, 4, 3], 'Тихие соседи, УК отвечает в тот же день', 'Мало парковки');
  await review(3, [3, 4, 4, 5, 4], 'Зелёный двор, детская площадка', 'Лифт иногда встаёт');
  await review(10, [5, 5, 4, 4, 4], 'Чистые подъезды', 'Шумно летом от дороги');

  /* ── заявки во всех состояниях ── */
  const scope = numberScopeFor(orgId, DEMO_HOUSE_KEY);
  let number = 0;
  const addRequest = async (r: {
    author: string; flat: string; category: string; title: string; description: string;
    status: string; createdAgo: number; events: [string, string, string | null][];
    assignee?: string; rejectReason?: string; closedAgo?: number; stars?: number; photo?: [number, number, number];
    overdue?: boolean;
  }) => {
    const id = newId('req');
    const created = ago(r.createdAgo);
    await db.insert(request).values({
      id, number: ++number, numberScope: scope, propertyId: await flatId(r.flat), orgId, authorId: r.author,
      kind: 'complaint', category: r.category, title: r.title, description: r.description, status: r.status,
      slaDueAt: r.overdue ? ago(12 * HOUR) : slaDueAt(r.category, created),
      assigneeName: r.assignee ?? null, rejectReason: r.rejectReason ?? null,
      createdAt: created, closedAt: r.closedAgo !== undefined ? ago(r.closedAgo) : null,
    });
    for (const [i, [actor, text, actorName]] of r.events.entries()) {
      await db.insert(requestEvent).values({
        id: newId('evt'), requestId: id, text, actor, actorName,
        // Факт смены статуса — «status», слова людей — «comment», как пишет changeStatus
        type: i === 0 ? 'created'
          : actor !== 'resident' && /^(Заявка (взята|закрыта)|Диспетчер запросил|Житель: проблема)/.test(text) ? 'status'
          : 'comment',
        createdAt: new Date(created.getTime() + i * HOUR),
      });
    }
    if (r.stars) await db.insert(rating).values({ id: newId('rat'), requestId: id, stars: r.stars });
    if (r.photo) await saveAttachment(db, { requestId: id, bytes: solidPng(r.photo), originalName: 'фото.png', userId: r.author });
  };
  const disp = 'Диспетчер УК «Демо-Дом»';
  await addRequest({ author: neighbours[1], flat: '9', category: 'Электрика', title: 'Не горит свет на 3 этаже',
    description: 'Во 2 подъезде на 3 этаже не горит лампа с позавчера.', status: 'new', createdAgo: 2 * HOUR,
    events: [['system', 'Заявка принята диспетчером', null]] });
  await addRequest({ author: persona.get('owner12')!, flat: '12', category: 'Сантехника', title: 'Течёт кран в подвале',
    description: 'В подвале 1 подъезда течёт кран на стояке, лужа.', status: 'in_work', createdAgo: 26 * HOUR,
    assignee: 'Петров И., сантехник', photo: [70, 110, 190],
    events: [['system', 'Заявка принята диспетчером', null], ['dispatcher', 'Заявка взята в работу, назначен мастер: Петров И., сантехник', disp]] });
  await addRequest({ author: persona.get('owner45')!, flat: '45', category: 'Общее имущество', title: 'Шумит насос отопления',
    description: 'По ночам гудит насос, слышно в квартире.', status: 'need_info', createdAgo: 30 * HOUR,
    events: [['system', 'Заявка принята диспетчером', null],
      ['dispatcher', 'Диспетчер запросил уточнения', disp], ['dispatcher', 'В какое время гудит сильнее всего и в каком подъезде?', disp]] });
  await addRequest({ author: neighbours[9], flat: '88', category: 'Лифт', title: 'Не работает лифт во 2 подъезде',
    description: 'Лифт стоит с утра, на табло ошибка.', status: 'new', createdAgo: 20 * HOUR, overdue: true,
    events: [['system', 'Заявка принята диспетчером', null]] });
  await addRequest({ author: persona.get('owner78')!, flat: '78', category: 'Общее имущество', title: 'Не закрывается дверь подъезда',
    description: 'Доводчик сломан, дверь подъезда 3 стоит открытой.', status: 'done', createdAgo: 4 * DAY, closedAgo: DAY,
    assignee: 'Сидоров А., слесарь',
    events: [['system', 'Заявка принята диспетчером', null], ['dispatcher', 'Заявка взята в работу, назначен мастер: Сидоров А., слесарь', disp],
      ['dispatcher', 'Заявка закрыта: работы выполнены', disp], ['dispatcher', 'Доводчик заменён', disp]] });
  await addRequest({ author: persona.get('owner12')!, flat: '12', category: 'Сантехника', title: 'Протечка на лестнице',
    description: 'С потолка между 4 и 5 этажом капает вода.', status: 'done', createdAgo: 12 * DAY, closedAgo: 10 * DAY,
    stars: 5, photo: [190, 120, 60],
    events: [['system', 'Заявка принята диспетчером', null], ['dispatcher', 'Заявка закрыта: работы выполнены', disp], ['dispatcher', 'Заменён участок трубы', disp]] });
  await addRequest({ author: neighbours[6], flat: '52', category: 'Другое', title: 'Поменять окно в квартире',
    description: 'Продувает окно в спальне.', status: 'rejected', createdAgo: 8 * DAY, closedAgo: 7 * DAY,
    rejectReason: 'Окна в квартире — имущество собственника, УК их не меняет. Подойдёт «Мастер в квартиру».',
    events: [['system', 'Заявка принята диспетчером', null],
      ['dispatcher', 'Заявка закрыта без выполнения', disp],
      ['dispatcher', 'Окна в квартире — имущество собственника, УК их не меняет. Подойдёт «Мастер в квартиру».', disp]] });
  await addRequest({ author: neighbours[11], flat: '102', category: 'Общее имущество', title: 'Не вывозят мусор у 4 подъезда',
    description: 'Контейнеры переполнены третий день.', status: 'in_work', createdAgo: 5 * DAY,
    events: [['system', 'Заявка принята диспетчером', null], ['dispatcher', 'Заявка закрыта: работы выполнены', disp], ['dispatcher', 'Вывоз согласован', disp],
      ['resident', 'Мусор так и лежит, контейнеры полные', 'Ершов Павел Денисович'],
      ['system', 'Житель: проблема не решена — заявка вернулась в работу', null]] });

  return { ukLogin: DEMO_UK_LOGIN, ukPassword };
}

/**
 * Демо-дом для запуска одной командой (docker compose up): завести, если
 * его ещё нет, и показать на экране входа. Уже заведённый не трогает —
 * перезапуск контейнеров не стирает то, что проверяющий успел сделать.
 * Пароль кабинета демо-УК можно задать заранее, чтобы написать его в README;
 * на бою он не задаётся и генерируется при сбросе из кабинета оператора.
 */
export async function ensureDemo(
  db: Database, opts: { ukPassword?: string } = {},
): Promise<{ created: boolean; ukLogin: string; ukPassword?: string }> {
  const [existing] = await db.select({ key: house.houseKey }).from(house)
    .where(eq(house.houseKey, DEMO_HOUSE_KEY));
  let result: { created: boolean; ukLogin: string; ukPassword?: string } = { created: false, ukLogin: DEMO_UK_LOGIN };
  if (!existing) result = { created: true, ...(await seedDemo(db, new Date(), opts)) };
  await setDemoEnabled(db, true);
  return result;
}
