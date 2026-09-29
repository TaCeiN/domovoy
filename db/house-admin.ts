/**
 * Команды оператора для домов без управляющей компании.
 *
 * ПОЧЕМУ КОНСОЛЬ, А НЕ ЭКРАН. Админка — второй подпроект, и делается
 * она после этой модели: экран над сущностями, которых ещё нет,
 * пришлось бы переписывать. До неё оператор работает отсюда.
 */
import { eq } from 'drizzle-orm';
import { getDb, closeDb, describeConnection } from './client.ts';
import { appUser, property, userProperty } from './schema.ts';
import { setHouseForm, HOUSE_FORMS, type HouseForm } from '../lib/house/form.ts';
import { openHouseClaims, decideHouseClaim } from '../lib/house/claim.ts';
import { createChairman, revokeChairman, chairmanOfHouse } from '../lib/house/chairman.ts';
import { findOrg, fetchHouses } from '../lib/address/gis.ts';
import { upsertOrgAndHouses, houseKeyOf } from '../lib/dataset/org.ts';
import type { Database } from './client.ts';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Закрыть заявки дома: вопрос решён, держать их в очереди незачем. */
async function closeClaimsFor(db: Database, houseKey: string) {
  const open = (await openHouseClaims(db)).filter((c) => c.houseKey === houseKey);
  for (const c of open) await decideHouseClaim(db, c.id, 'done', 'cli');
  if (open.length) console.log(`Закрыто заявок: ${open.length}`);
}

async function cmdClaims(db: Database) {
  const rows = await openHouseClaims(db);
  if (!rows.length) return console.log('Очередь пуста');
  for (const r of rows) {
    console.log(`\n${r.houseKey}`);
    console.log(`  ${r.userName}  (${r.userId})`);
    if (r.note) console.log(`  «${r.note}»`);
    console.log(`  ${r.createdAt.toLocaleString('ru-RU')}`);
  }
  console.log(`\nВсего: ${rows.length}`);
}

async function cmdForm(db: Database) {
  const houseKey = arg('house') ?? die('Нужен --house "<ключ дома>"');
  const form = arg('form') ?? die(`Нужен --form, одно из: ${HOUSE_FORMS.join(', ')}`);
  if (!HOUSE_FORMS.includes(form as HouseForm)) {
    die(`Неизвестная форма «${form}». Допустимо: ${HOUSE_FORMS.join(', ')}`);
  }

  await setHouseForm(db, houseKey, {
    form: form as HouseForm, source: 'operator', setBy: 'cli',
  });
  console.log(`Форма дома изменена: ${form}`);
  await closeClaimsFor(db, houseKey);
}

async function cmdResidents(db: Database) {
  const houseKey = arg('house') ?? die('Нужен --house "<ключ дома>"');
  const rows = await db
    .select({
      userId: userProperty.userId,
      name: appUser.fullName,
      claimName: userProperty.claimName,
      flat: property.flat,
      status: userProperty.status,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .innerJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(eq(property.houseKey, houseKey));

  if (!rows.length) return console.log('В этом доме пока никого нет');
  for (const r of rows) {
    const flat = r.flat ? `кв. ${r.flat}` : 'без квартиры';
    console.log(`${r.userId}  ${r.claimName ?? r.name ?? '—'}  ${flat}  ${r.status}`);
  }
}

async function cmdChairman(db: Database) {
  const houseKey = arg('house') ?? die('Нужен --house "<ключ дома>"');
  const userId = arg('user') ?? die('Нужен --user usr_XXXX (список: npm run house:residents)');

  const res = await createChairman(db, {
    houseKey, userId, by: { kind: 'operator', who: 'cli' },
  });
  if (!res.ok) {
    const why = {
      foreign_house: 'дом не принадлежит назначающему',
      not_a_resident: 'этот человек не житель дома — проверьте house:residents',
      already_exists: 'у дома уже есть действующий председатель',
    }[res.reason];
    die(`Не назначено: ${why}`);
  }
  console.log(`Председатель назначен: ${res.name}`);
  await closeClaimsFor(db, houseKey);
}

/**
 * Снять председателя, назначенного оператором.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ КОМАНДА. `revokeChairman` в приложении доступна только
 * диспетчеру, и она снимает председателя лишь СВОЕЙ организации: у дома,
 * назначенного этой же командой (`house:chairman`, без УК), `orgId` пуст,
 * и диспетчерское условие не совпадёт никогда. Без команды ниже ошибочное
 * назначение было необратимо — исправлялось только правкой в базе руками.
 * Председатель подтверждает всех жителей дома и читает обращения
 * с фамилиями и номерами квартир, поэтому снимать его можно и нужно.
 */
async function cmdChairmanRevoke(db: Database) {
  const houseKey = arg('house') ?? die('Нужен --house "<ключ дома>"');

  const current = await chairmanOfHouse(db, houseKey);
  if (!current) die('У этого дома нет действующего председателя');

  const ok = await revokeChairman(db, { kind: 'operator', who: 'cli' }, current.id);
  if (!ok) die('Не снято: попробуйте ещё раз');
  console.log(`Председатель снят: ${current.name}`);
}

/**
 * Подключить организацию (обычно ТСЖ или ЖСК) по ИНН со всеми её домами.
 *
 * Ключ дома считается ОДНИМ И ТЕМ ЖЕ нормализатором, что и у полного
 * импорта реестра: `upsertOrgAndHouses` и `houseKeyOf` не переписаны
 * заново, а живут в `lib/dataset/org.ts` рядом с набором данных — иначе связка с объектами
 * жителей однажды разойдётся, и дом останется без организации молча.
 */
async function cmdOrg(db: Database) {
  const inn = arg('inn') ?? die('Нужен --inn <ИНН организации>');
  const form = (arg('form') ?? 'tsj') as HouseForm;
  if (!HOUSE_FORMS.includes(form)) die(`Неизвестная форма «${form}»`);

  const found = await findOrg(inn);
  if (!found) die(`Организации с ИНН ${inn} нет в справочнике ГИС ЖКХ`);

  /**
   * Дома тянем страницами: у ТСЖ их обычно один-два, но у ЖСК
   * с несколькими корпусами бывает больше сотни.
   */
  const houses: { address: string; houseGuid: string | null; flatCount: number | null }[] = [];
  for (let page = 1; ; page += 1) {
    const chunk = await fetchHouses(found.guid, page);
    houses.push(...chunk.items);
    if (houses.length >= chunk.total || !chunk.items.length) break;
  }
  console.log(`Организация найдена, домов: ${houses.length}`);

  const { orgId, skipped } = await upsertOrgAndHouses(db, inn, found, houses);
  if (skipped) console.log(`Адресов, которые не разобрались: ${skipped}`);

  /**
   * Заявки домов ЗДЕСЬ не закрываем.
   *
   * Организация подключена, но кабинета диспетчера у неё, как правило,
   * нет и не появится: ТСЖ и ЖСК заводятся именно потому, что кабинета
   * не будет. Подтверждать жителей всё ещё некому — председателя пока
   * нет. Закрыть заявки обязана только команда `house:chairman`: она
   * и означает, что дом наконец довели до конца.
   */
  for (const h of houses) {
    const key = houseKeyOf(h.address);
    if (!key) { console.log(`  пропущен адрес: ${h.address}`); continue; }
    await setHouseForm(db, key, { form, orgId, source: 'operator', setBy: 'cli' });
    console.log(`  ${key}`);
  }
  console.log(
    '\nОрганизация подключена, но дело наполовину: жителям по-прежнему '
    + 'некому подтверждать доступ, пока у дома нет председателя. '
    + 'Назначьте его командой: npm run house:chairman -- --house "<ключ дома>" --user usr_XXXX '
    + '(список жителей — npm run house:residents -- --house "<ключ дома>"). '
    + 'Она же закроет заявки, поданные жителями.',
  );
}

async function main() {
  const db = getDb();
  console.log('База →', describeConnection(), '\n');

  const cmd = process.argv[2];
  try {
    if (cmd === 'claims') await cmdClaims(db);
    else if (cmd === 'form') await cmdForm(db);
    else if (cmd === 'residents') await cmdResidents(db);
    else if (cmd === 'chairman') await cmdChairman(db);
    else if (cmd === 'chairman-revoke') await cmdChairmanRevoke(db);
    else if (cmd === 'org') await cmdOrg(db);
    else die('Команды: claims | form | residents | chairman | chairman-revoke | org');
  } finally {
    await closeDb();
  }
}

await main();
