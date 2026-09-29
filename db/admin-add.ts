/**
 * Учётка оператора сервиса.
 *
 *   npm run admin:add -- --login operator --name "Николай"   завести
 *   npm run admin:add -- --login operator --reset            новый пароль
 *   npm run admin:add -- --login operator --disable          выключить
 *   npm run admin:add -- --login operator --enable           включить обратно
 *   npm run admin:add -- --list                              кто есть
 *
 * Отдельная команда, а не саморегистрация: оператор видит все дома
 * и всех жителей сразу, и выписать себе такое право никто не должен.
 *
 * Пароль генерируется здесь и печатается ОДИН раз: в базе только хеш.
 */
import { eq } from 'drizzle-orm';
import { getDb, closeDb, describeConnection } from './client.ts';
import { admin } from './schema.ts';
import { newId } from '../lib/ids.ts';
import { hashPassword, generatePassword } from '../lib/auth/password.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

async function list(db: ReturnType<typeof getDb>) {
  const rows = await db.select().from(admin);
  if (rows.length === 0) {
    console.log('Операторов пока нет.');
    return;
  }
  for (const row of rows) {
    const state = row.disabledAt ? 'выключен' : 'работает';
    console.log(`${row.login}  ${row.name}  ${state}`);
  }
}

async function main() {
  const db = getDb();
  console.log(describeConnection());

  if (has('list')) {
    await list(db);
    await closeDb();
    return;
  }

  const login = arg('login');
  if (!login) {
    console.error(
      'Нужен --login. Например:\n'
      + '  npm run admin:add -- --login operator --name "Николай"\n'
      + '  npm run admin:add -- --list',
    );
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const existing = (await db.select().from(admin).where(eq(admin.login, login)).limit(1))[0];

  if (has('disable') || has('enable')) {
    if (!existing) {
      console.error(`Оператора ${login} нет.`);
      process.exitCode = 1;
      await closeDb();
      return;
    }
    const off = has('disable');
    await db
      .update(admin)
      .set({ disabledAt: off ? new Date() : null })
      .where(eq(admin.id, existing.id));
    console.log(off
      ? `Оператор ${login} выключен. Его сессии перестали работать сейчас же.`
      : `Оператор ${login} снова работает. Пароль прежний.`);
    await closeDb();
    return;
  }

  /**
   * Молчаливой перезаписи нет: перепутанный логин иначе сменил бы пароль
   * действующему оператору, и тот узнал бы об этом, только не сумев войти.
   */
  if (existing && !has('reset')) {
    console.error(
      `Оператор ${login} уже есть.\n`
      + `Сменить ему пароль: npm run admin:add -- --login ${login} --reset`,
    );
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  if (existing) {
    await db.update(admin).set({ passwordHash }).where(eq(admin.id, existing.id));
    console.log(`Пароль оператора ${login} сменён.`);
  } else {
    await db.insert(admin).values({
      id: newId('adm'),
      login,
      passwordHash,
      name: arg('name') ?? login,
    });
    console.log(`Оператор ${login} заведён.`);
  }

  console.log(`  логин:  ${login}`);
  console.log(`  пароль: ${password}`);
  console.log('\nПароль показан один раз — в базе только хеш.');

  /**
   * Адрес кабинета выводим по той базе, в которую только что записали.
   * Иначе команда, запущенная через `prod:admin`, звала бы в localhost —
   * и получилось бы полчаса недоумения, почему боевой пароль не подходит.
   */
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')
    && !process.env.DATABASE_URL?.includes('5434');
  console.log(local
    ? 'Кабинет: http://localhost:3000/admin/'
    : 'Кабинет: /admin/ на том стенде, чью базу вы указали');

  await closeDb();
}

await main();
