/**
 * Демо-дом.
 * Запасной путь: обычно всё делается в кабинете оператора → «Демо-дом».
 *
 *   npm run demo:reset   завести заново: дом, роли, история; держатели отвязаны
 *   npm run demo:clear   стереть целиком
 *   npm run demo:on / demo:off   показать или убрать с экрана входа
 *   node db/demo.ts ensure   завести, если ещё нет, и показать (docker compose up);
 *                            пароль демо-УК — из DEMO_UK_PASSWORD, если задан
 *
 * Пароль кабинета демо-УК печатается при каждом сбросе — один раз.
 */
import { getDb, closeDb, describeConnection } from './client.ts';
import { seedDemo, clearDemo, ensureDemo } from '../lib/demo/seed.ts';
import { setDemoEnabled } from '../lib/demo/setting.ts';

const [command = 'reset'] = process.argv.slice(2);
console.log('Демо-дом →', describeConnection());
const db = getDb();

if (command === 'clear') {
  await clearDemo(db);
  await setDemoEnabled(db, false);
  console.log('Стёрт и убран с экрана входа.');
} else if (command === 'ensure') {
  const r = await ensureDemo(db, { ukPassword: process.env.DEMO_UK_PASSWORD });
  console.log(r.created ? 'Демо-дом заведён и показан на экране входа.' : 'Демо-дом уже есть — показан на экране входа.');
  if (r.created && r.ukPassword) console.log(`Кабинет УК: /dispatcher/  логин ${r.ukLogin}  пароль ${r.ukPassword}`);
} else if (command === 'on' || command === 'off') {
  await setDemoEnabled(db, command === 'on');
  console.log(command === 'on' ? 'Показан на экране входа.' : 'Убран с экрана входа.');
} else {
  const { ukLogin, ukPassword } = await seedDemo(db);
  console.log('Готово. Включить на экране входа — кабинет оператора → «Демо-дом» или demo:on.');
  console.log(`Кабинет УК: /dispatcher/  логин ${ukLogin}  пароль ${ukPassword}`);
}
await closeDb();
