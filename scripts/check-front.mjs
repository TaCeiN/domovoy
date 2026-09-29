import { build } from 'esbuild';

/**
 * Проверка фронта сборкой — со строгим отношением к предупреждениям.
 *
 * ЗАЧЕМ. Тестов у фронта нет, и единственная автоматическая проверка —
 * то, что он вообще собирается. Но esbuild ловит заметно больше: мёртвые
 * импорты, дублирующиеся ключи объектов, недостижимый код. Эти находки
 * приходят ПРЕДУПРЕЖДЕНИЯМИ, а не ошибками, — то есть сборка остаётся
 * «успешной», и их легко не заметить.
 *
 * Именно так и вышло 25 августа: в объекте состояния кабинета диспетчера
 * ключ `houses` был объявлен дважды, второй затирал первый значением
 * `null`, и вкладки «Объявления» и «Председатели» падали на `null.length`
 * при первом же заходе. esbuild писал «Duplicate key "houses"» с самого
 * начала — предупреждение просто утонуло в выводе.
 *
 * Поэтому здесь любое предупреждение это провал проверки.
 */

const ENTRY_POINTS = [
  'public/app/main.js',
  'public/dispatcher/dispatcher.js',
  'public/admin/admin.js',
];

let failed = false;

for (const entry of ENTRY_POINTS) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  }).catch((error) => ({ errors: error.errors ?? [{ text: String(error) }], warnings: [] }));

  for (const error of result.errors ?? []) {
    console.error(`✖ ${entry}: ${error.text}`);
    if (error.location) console.error(`  ${error.location.file}:${error.location.line}`);
    failed = true;
  }

  for (const warning of result.warnings ?? []) {
    console.error(`⚠ ${entry}: ${warning.text}`);
    if (warning.location) console.error(`  ${warning.location.file}:${warning.location.line}`);
    failed = true;
  }

  if (!(result.errors ?? []).length && !(result.warnings ?? []).length) {
    console.log(`✓ ${entry}`);
  }
}

/**
 * Каждое действие в разметке должно иметь обработчик.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ПРОВЕРКА. Сборка этого не видит: файл с `data-action="tab"`
 * в шаблоне и без `case 'tab'` в обработчике собирается идеально — просто
 * кнопка молча перестаёт нажиматься. Ни ошибки, ни предупреждения,
 * ни записи в консоли браузера.
 *
 * Именно так и вышло 25 августа: правка убрала из `switch` 131 строку,
 * вместе с обработчиками вкладок, публикации объявлений, создания опросов
 * и добавления дома. Сборка проходила, типы проходили, тесты проходили —
 * а в кабинете диспетчера перестало нажиматься вообще всё.
 *
 * Обратную сторону — обработчик без разметки — считаем предупреждением
 * и не валим сборку: действие может приходить из общего модуля или
 * вызываться из кода напрямую.
 */
const HANDLER_FILES = [
  { markup: ['public/dispatcher/dispatcher.js', 'public/dispatcher/nav.js', 'public/app/house-admin.js',
             'public/app/datepicker.js'],
    handler: ['public/dispatcher/dispatcher.js', 'public/app/datepicker.js'] },
  /**
   * Кабинет оператора: разметка и обработчики в одном файле, плюс общий
   * календарь — фильтр журнала по датам берёт то же поле, что и остальные
   * формы проекта.
   */
  { markup: ['public/admin/admin.js', 'public/dispatcher/nav.js', 'public/admin/events.js', 'public/admin/coverage.js', 'public/app/datepicker.js'],
    handler: ['public/admin/admin.js', 'public/admin/events.js', 'public/admin/coverage.js', 'public/app/datepicker.js'] },
  /**
   * Приложение жителя. Разметка разбросана по экранам, обработчики —
   * тоже: часть в main.js, часть в handleXAction каждого экрана.
   */
  { markup: [
      'public/app/main.js',
      'public/app/datepicker.js',
      'public/app/screens/council.js',
      'public/app/screens/council-posts.js',
      'public/app/screens/council-polls.js',
      'public/app/screens/home.js',
      'public/app/screens/house.js',
      'public/app/screens/login.js',
      'public/app/screens/meters.js',
      'public/app/screens/profile.js',
      'public/app/screens/requests.js',
      'public/app/pay.js',
      'public/app/screens/master.js',
      'public/app/screens/demo.js',
      'public/app/screens/pick.js',
      'public/app/screens/pick-mock.js',
      'public/app/screens/pick-icons.js',
      // Общая шторка: её кнопка «Закрыть» размечена здесь, обработчик — в main.js
      'public/app/ui.js',
      'public/app/chat.js',
      // Поля квитанции для «Проверьте данные»: разметки нет, но файл в списке
      'public/app/receipt-fields.js',
      'public/app/transitions.js',
      // Разбор параметра запуска от кнопок бота MAX: разметки нет, но файл в списке
      'public/app/deeplink.js',
      // Кнопка Домового размечена здесь, открывает её main.js
      'public/app/assistant.js',
      // Тарифы под счётчиками: разметки с действиями нет, но файл в списке
      'public/app/tariffs.js',
      // Свайп «Назад»: разметки с действиями нет, но файл в списке
      'public/app/swipe-back.js',
      // Обучение жителя: карточки и их кнопки
      'public/app/tutorial.js',
    ],
    handler: [
      'public/app/main.js',
      'public/app/tutorial.js',
      'public/app/datepicker.js',
      'public/app/screens/council.js',
      'public/app/screens/council-posts.js',
      'public/app/screens/council-polls.js',
      'public/app/screens/house.js',
      'public/app/screens/login.js',
      'public/app/screens/meters.js',
      'public/app/screens/profile.js',
      'public/app/screens/requests.js',
      'public/app/pay.js',
      'public/app/screens/master.js',
      'public/app/screens/demo.js',
      'public/app/screens/pick.js',
      'public/app/screens/pick-mock.js',
      'public/app/screens/pick-icons.js',
    ] },
];

const readFile = async (path) => (await import('node:fs/promises'))
  .readFile(path, 'utf8')
  // Файла может не быть: список общий для проверки и для будущих экранов
  .catch(() => '');

/**
 * Действия, которые код умеет обрабатывать.
 *
 * ЧЕТЫРЕ ФОРМЫ ЗАПИСИ. В кабинете УК это `switch` с `case`, в экранах
 * приложения — цепочка `if (action === '...')` или обратная ей проверка
 * `if (action !== '...') return false`, а простые переходы вообще
 * не пишутся кодом: они лежат ключами в таблице NAVIGATE. Знать надо
 * все четыре, иначе проверка объявит потерянными действия, которые
 * прекрасно работают, — на `send-reading` это и случилось при первом
 * же запуске.
 */
function handledActions(text) {
  const found = new Set();
  for (const m of text.matchAll(/case '([a-z-]+)'/g)) found.add(m[1]);
  for (const m of text.matchAll(/action === '([a-z-]+)'/g)) found.add(m[1]);
  // Ранний выход через отрицание: `if (action !== 'send-reading' && ...) return false`
  for (const m of text.matchAll(/action !== '([a-z-]+)'/g)) found.add(m[1]);

  const table = text.match(/const NAVIGATE = \{([\s\S]*?)\};/);
  if (table) {
    for (const m of table[1].matchAll(/([a-z-]+)\s*:/g)) found.add(m[1]);
    for (const m of table[1].matchAll(/'([a-z-]+)'\s*:/g)) found.add(m[1]);
  }
  return found;
}

for (const group of HANDLER_FILES) {
  const emitted = new Set();
  for (const file of group.markup) {
    for (const m of (await readFile(file)).matchAll(/data-action="([a-z-]+)"/g)) {
      emitted.add(m[1]);
    }
  }

  const handled = new Set();
  for (const file of group.handler) {
    for (const action of handledActions(await readFile(file))) handled.add(action);
  }

  const where = group.handler[0];
  const orphans = [...emitted].filter((a) => !handled.has(a)).sort();
  if (orphans.length) {
    console.error(`✖ ${where}: действия без обработчика — ${orphans.join(', ')}`);
    console.error('  Кнопка с таким data-action просто не нажимается, и это никак не видно.');
    failed = true;
  } else {
    console.log(`✓ ${where}: все ${emitted.size} действий обработаны`);
  }
}

if (failed) {
  console.error('\nФронт не прошёл проверку. Предупреждения здесь считаются ошибками:');
  console.error('esbuild ловит мёртвые импорты и дубли ключей, а тестов у фронта нет.');
  process.exit(1);
}

console.log('\nФронт собирается без предупреждений, все действия обработаны.');
