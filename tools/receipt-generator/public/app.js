import { encodeQr, qrToSvg } from '../lib/qr-encode.mjs';
import { encodeByFlag } from '../lib/cp1251.mjs';
import {
  ENCODINGS, PAYEES, buildReceipt, formatPeriod, toKopecks, persAccFor,
} from '../lib/receipt.mjs';

/**
 * Страница генератора.
 *
 * Модули кодирования импортируются ПРЯМО те же, что проверяет
 * `qr-encode.test.mjs`, — сборки здесь нет, и подмениться нечему.
 * Если тест зелёный, значит и на экране будет сканируемый код.
 */

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let currentSvg = '';
let currentString = '';

/* ─────────────── заполнение форм ─────────────── */

$('payee').innerHTML = PAYEES
  .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
$('encoding').innerHTML = ENCODINGS
  .map((e) => `<option value="${esc(e.flag)}">${esc(e.label)}</option>`).join('');
$('period').value = formatPeriod();

fetch('/api/stats').then((r) => r.json()).then((s) => {
  $('dbLine').textContent =
    `Инструмент разработки. В реестре ${s.houses} домов, ${s.orgs} организаций, ${s.streets} улиц.`;
}).catch(() => {});

/* ─────────────── поиск дома ─────────────── */

let searchTimer = null;

$('houseSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = $('houseSearch').value.trim();
  const hits = $('houseHits');

  if (query.length < 2) {
    hits.hidden = true;
    return;
  }

  // Задержка: запрос на каждую букву — это сотня запросов на слово
  searchTimer = setTimeout(async () => {
    try {
      const data = await (await fetch(`/api/houses?q=${encodeURIComponent(query)}`)).json();

      hits.innerHTML = data.houses.length
        ? data.houses.map((h) => `
            <button type="button" class="hit" data-address="${esc(h.address)}">
              <span class="hit-a">${esc(h.address)}</span>
              <span class="hit-o">${esc(h.orgName)}${h.flatCount ? ` · ${h.flatCount} кв.` : ''}</span>
            </button>`).join('')
        : '<div class="hit-empty">Ничего не найдено. Можно вписать адрес руками ниже.</div>';
      hits.hidden = false;
    } catch (error) {
      hits.innerHTML = `<div class="hit-empty">${esc(error.message)}</div>`;
      hits.hidden = false;
    }
  }, 250);
});

$('houseHits').addEventListener('click', (event) => {
  const hit = event.target.closest('.hit');
  if (!hit) return;

  $('address').value = hit.dataset.address;
  $('houseHits').hidden = true;
  refresh();
});

/* ─────────────── предсказание ─────────────── */

const VERDICT_TONE = {
  found: 'ok',
  found_no_org: 'warn',
  not_in_registry: 'warn',
  ambiguous: 'warn',
  no_key: 'bad',
};

async function updatePreview() {
  const address = $('address').value.trim();
  const card = $('previewCard');

  if (!address) {
    card.hidden = true;
    return;
  }

  try {
    const flat = $('flat').value.trim();
    const data = await (await fetch(
      `/api/preview?address=${encodeURIComponent(address)}&flat=${encodeURIComponent(flat)}`,
    )).json();

    const p = data.parsed ?? {};
    const rows = [
      ['Регион', p.region],
      ['Район', p.district],
      ['Населённый пункт', p.city],
      ['Микрорайон', p.subplace],
      ['Улица', p.street],
      ['Дом', p.house],
      ['Корпус', p.block],
      ['Строение', p.building],
      ['Квартира', p.flat],
    ].filter(([, value]) => value);

    $('preview').innerHTML = `
      <div class="verdict ${VERDICT_TONE[data.verdict] ?? ''}">${esc(data.message)}</div>
      ${data.registryAddress && data.registryAddress !== address ? `
        <p class="hint">
          В реестре этот дом записан как «${esc(data.registryAddress)}» — приложение
          покажет жителю именно это написание, чтобы он и УК видели один адрес.
        </p>` : ''}
      <dl class="kv">
        ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        <dt>Ключ дома</dt><dd class="mono">${esc(p.houseKey ?? '—')}</dd>
      </dl>`;
    card.hidden = false;
  } catch (error) {
    $('preview').innerHTML = `<div class="verdict bad">${esc(error.message)}</div>`;
    card.hidden = false;
  }
}

/* ─────────────── генерация ─────────────── */

function generate() {
  const payee = PAYEES.find((p) => p.id === $('payee').value) ?? PAYEES[0];
  $('payeeNote').textContent = payee.note;

  const address = $('address').value.trim();
  const flat = $('flat').value.trim();
  const withoutAddress = $('noAddress').checked;

  // Счёт считается от адреса: повторная генерация даёт тот же номер,
  // иначе каждый раз заводился бы новый счёт и «повторный скан» не проверить
  const persAcc = $('persAcc').value.trim() || persAccFor(address, flat);
  if (!$('persAcc').value.trim()) $('persAcc').placeholder = persAcc;

  const fullAddress = withoutAddress
    ? ''
    : [address, flat ? `кв. ${flat}` : ''].filter(Boolean).join(', ');

  const encoding = $('encoding').value;

  currentString = buildReceipt({
    encoding,
    payeeName: payee.name,
    payeeInn: payee.inn,
    kpp: payee.kpp,
    purpose: payee.purpose,
    persAcc,
    address: fullAddress,
    lastName: $('lastName').value,
    firstName: $('firstName').value,
    middleName: $('middleName').value,
    sumKopecks: toKopecks($('sum').value),
    period: $('period').value.trim(),
  });

  $('raw').value = currentString;

  try {
    const bytes = encodeByFlag(currentString, encoding);
    const matrix = encodeQr(bytes, { ecc: 'M' });
    currentSvg = qrToSvg(matrix, { scale: 6 });

    $('qr').innerHTML = currentSvg;
    /**
     * Плотность показываем явно.
     *
     * «Версия 13» ни о чём не говорит, а «69 модулей, 4.2 px во врезке» —
     * говорит: сразу видно, что код на грани и его лучше открыть крупно.
     */
    const across = matrix.size + 8;
    $('qrMeta').textContent =
      `${bytes.length} байт · версия ${matrix.version} · ${matrix.size} модулей `
      + `· коррекция ${matrix.ecc} · маска ${matrix.mask} `
      + `· во врезке ${(320 / across).toFixed(1)} px на модуль`;
  } catch (error) {
    $('qr').innerHTML = '';
    $('qrMeta').textContent = error.message;
  }
}

function refresh() {
  generate();
  updatePreview();
}

for (const id of [
  'address', 'flat', 'persAcc', 'sum', 'period',
  'lastName', 'firstName', 'middleName', 'payee', 'encoding', 'noAddress',
]) {
  $(id).addEventListener('input', refresh);
  $(id).addEventListener('change', refresh);
}

/**
 * Колесо мыши над выпадающим списком его НЕ меняет.
 *
 * Браузер по умолчанию считает прокрутку над `<select>` перебором
 * вариантов. В обычной форме это раздражает, а здесь — тихо подменяет
 * получателя платежа или кодировку, то есть саму суть квитанции:
 * человек прокрутил страницу, а сгенерировалось другое. Инструмент,
 * который должен убирать путаницу, обязан не создавать её сам.
 */
for (const select of document.querySelectorAll('select')) {
  select.addEventListener('wheel', (event) => {
    if (document.activeElement !== select) event.preventDefault();
  }, { passive: false });
}

/**
 * Показ кода во весь экран.
 *
 * Врезка на странице ограничена 320 px, а плотная квитанция — это версия 13
 * и выше, то есть 69+ модулей. Модуль выходит тоньше четырёх пикселей,
 * и камера под бликующим монитором ловит такой код через раз. Здесь тот же
 * SVG растягивается на всё окно: модуль становится втрое крупнее, и проверка
 * сканера перестаёт зависеть от везения.
 *
 * Оверлей пересоздаётся при каждом открытии: код между показами меняется,
 * а держать вторую копию SVG в синхронном состоянии — лишний источник
 * расхождений.
 */
function showBig() {
  if (!currentSvg) return;

  const overlay = document.createElement('div');
  overlay.className = 'qr-full';
  overlay.innerHTML = currentSvg
    + '<div class="qr-full-hint">Нажмите на код или Esc, чтобы закрыть</div>';

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

$('showBig').addEventListener('click', showBig);

$('copyString').addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentString);
  $('copyString').textContent = 'Скопировано';
  setTimeout(() => { $('copyString').textContent = 'Скопировать строку'; }, 1500);
});

$('downloadSvg').addEventListener('click', () => {
  const blob = new Blob([currentSvg], { type: 'image/svg+xml' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'kvitanciya.svg';
  link.click();
  URL.revokeObjectURL(link.href);
});

// Что-нибудь осмысленное на экране с первой секунды
$('address').value = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3';
refresh();
