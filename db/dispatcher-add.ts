/**
 * Учётка кабинета управляющей организации.
 *
 *   npm run uk:find -- --query Сервис           найти УК в реестре
 *   npm run uk:dispatcher -- --inn 6155090199 --login uk-senestra
 *
 * Отдельная команда, потому что подключение УК — это договор, а не
 * самообслуживание. В реестре лицензий по одной Ростовской области
 * 733 организации; кабинет заводится только тем, кто реально пришёл.
 *
 * Пароль генерируется здесь и печатается ОДИН раз: в базе только хеш.
 */
import { and, eq, ilike, or } from 'drizzle-orm';
import { getDb, closeDb, describeConnection } from './client.ts';
import { managingOrg, house, dispatcher } from './schema.ts';
import { newId } from '../lib/ids.ts';
import { hashPassword, generatePassword } from '../lib/auth/password.ts';
import { startClockForOrg } from '../lib/requests/service.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function find(db: ReturnType<typeof getDb>, query: string) {
  const rows = await db
    .select()
    .from(managingOrg)
    .where(or(
      ilike(managingOrg.name, `%${query}%`),
      ilike(managingOrg.shortName, `%${query}%`),
      eq(managingOrg.inn, query),
    ))
    .limit(20);

  if (rows.length === 0) {
    console.log('Ничего не найдено. Реестр загружается командой dataset:load.');
    return;
  }

  for (const row of rows) {
    const houses = await db
      .select({ houseKey: house.houseKey })
      .from(house)
      .where(eq(house.registryOrgId, row.id));

    console.log(
      `${row.inn}  ${(row.shortName ?? row.name).slice(0, 48).padEnd(48)} `
      + `домов в реестре: ${String(houses.length).padStart(4)}  (по лицензии ${row.houseCount})`,
    );
  }
}

async function main() {
  const db = getDb();
  console.log('Реестр →', describeConnection(), '\n');

  const query = arg('query');
  if (query) {
    await find(db, query);
    await closeDb();
    return;
  }

  const inn = arg('inn');
  const login = (arg('login') ?? '').trim().toLowerCase();

  if (!inn || !login) {
    console.error(
      'Использование:\n'
      + '  npm run uk:find -- --query Сервис\n'
      + '  npm run uk:dispatcher -- --inn 6155090199 --login uk-senestra [--name "Диспетчер"]',
    );
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const orgs = await db.select().from(managingOrg).where(eq(managingOrg.inn, inn)).limit(1);
  const org = orgs[0];

  if (!org) {
    console.error(
      `Организации с ИНН ${inn} нет в реестре управляющих организаций.\n`
      + 'Либо реестр не загружен (dataset:load), либо это не управляющая компания —\n'
      + 'например, расчётный центр или энергосбыт: они получают платежи, но домами не управляют.',
    );
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const taken = await db.select().from(dispatcher).where(eq(dispatcher.login, login)).limit(1);
  if (taken[0]) {
    console.error(`Логин ${login} уже занят.`);
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const password = generatePassword();
  await db.insert(dispatcher).values({
    id: newId('dsp'),
    orgId: org.id,
    login,
    passwordHash: await hashPassword(password),
    name: arg('name') ?? `Диспетчер ${org.shortName ?? org.name}`,
  });
  // Заявки, поданные до кабинета, получают срок с этой минуты
  const started = await startClockForOrg(db, org.id);

  const houses = await db
    .select({ houseKey: house.houseKey })
    .from(house)
    .where(and(eq(house.registryOrgId, org.id)));

  console.log(`Кабинет создан для «${org.shortName ?? org.name}»`);
  if (started) console.log(`  открытых заявок получили срок реакции: ${started}`);
  console.log(`  логин:  ${login}`);
  console.log(`  пароль: ${password}`);
  console.log(`  домов в реестре: ${houses.length}`);
  console.log('\nПароль показан один раз — в базе только хеш.');

  await closeDb();
}

await main();
