import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.ts';

/**
 * Раздача статики: кабинеты должны открываться и без слэша на конце.
 *
 * ПОЧЕМУ ЭТО ВАЖНО. В `public/dispatcher/index.html` пути относительные —
 * `./dispatcher.js` и `../styles.css`. По адресу `/dispatcher/` браузер
 * разрешает их в `/dispatcher/dispatcher.js`, а по `/dispatcher` (без
 * слэша) — в `/dispatcher.js`, которого нет.
 *
 * Итог для человека: страница приходит, шапка «Кабинет диспетчера»
 * рисуется из самой разметки, а формы входа нет вовсе — её строит скрипт,
 * который не загрузился. Выглядит как сломанный кабинет, а на деле
 * потерянный слэш.
 */

test('кабинет диспетчера без слэша уводит на адрес со слэшем', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/dispatcher' });
  await app.close();

  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, '/dispatcher/');
});

/**
 * Веб-кабинета председателя больше нет.
 *
 * Председатель — такой же житель, и раздел «Совет дома» живёт внутри
 * приложения. Отдельная страница означала второй аккаунт и второй вход:
 * человек должен был помнить, «под кем он сейчас», а в советах домов
 * большинство — люди старшего возраста.
 *
 * Проверяем, что старый адрес не отдаёт страницу: если он останется,
 * кто-то будет ходить по нему и видеть пустой экран.
 */
test('старого веб-кабинета председателя больше нет', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/chairman/' });
  await app.close();

  // SPA-фолбэк отдаёт приложение жителя, а не отдельный кабинет
  assert.ok(!/Кабинет председателя/.test(res.body), 'отдельного кабинета быть не должно');
});

test('со слэшем кабинет отдаётся как есть', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/dispatcher/' });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Кабинет диспетчера/);
  // Скрипт кабинета на месте — значит поедет и вёрстка
  assert.match(res.body, /dispatcher\.js/);
});

test('приложение жителя открывается в корне', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/' });
  await app.close();

  assert.equal(res.statusCode, 200);
});
