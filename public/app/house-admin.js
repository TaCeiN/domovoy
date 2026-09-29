import { esc, html, formatDate, displayAddress } from './ui.js';
import { dateField, todayValue } from './datepicker.js';
import { WIP } from './wip.js';

/**
 * Управление жизнью дома: объявления и опросы.
 *
 * Общий модуль для двух кабинетов — УК и председателя совета дома. Формы
 * у них одинаковые, разница только в области видимости: УК выбирает дом
 * из списка своих, у председателя дом ровно один и выбирать нечего.
 *
 * Держать это в двух копиях нельзя: расходятся не стили, а правила —
 * например, обязательность срока у аварийного объявления. Разъехавшись,
 * два кабинета начнут публиковать разное в одну и ту же ленту.
 */

export const POST_KINDS = [
  {
    value: 'outage',
    label: 'Отключение',
    hint: 'Уведомление уйдёт всем жильцам дома. Только для аварий и плановых отключений.',
  },
  { value: 'meeting', label: 'Собрание', hint: 'Появится в ленте дома, без уведомления.' },
  { value: 'news', label: 'Новость', hint: 'Появится в ленте дома, без уведомления.' },
];

/**
 * По умолчанию — новость, а не отключение.
 *
 * Отключение рассылает уведомление всем жильцам. Стоя первым выбранным,
 * оно превращало любую новость председателя в тревогу на все телефоны
 * дома, если он не заметил переключатель (аудит 26 сентября).
 */
export const DEFAULT_POST_KIND = 'news';

/**
 * «Во все мои дома» — для отключения по кварталу или новости УК.
 * Кабинет публикует объявление в каждый дом по очереди (аудит 26.09:
 * отключение на квартал приходилось набирать в каждый дом руками).
 */
export const ALL_HOUSES = '__all';

/**
 * Форма объявления.
 *
 * `houses` — список домов на выбор (у председателя пустой: дом один).
 */
export function postForm({ houses = [], houseLabel = '' } = {}) {
  return html`
    <div class="dsp-card">
      <h2>Новое объявление дома</h2>

      ${houses.length
        ? html`
          <div class="field-label" style="margin-top:0">Дом</div>
          <select id="haHouse" class="dsp-select">
            ${houses.map((h) => `<option value="${esc(h.houseKey)}">${esc(displayAddress(h.label))}</option>`).join('')}
            ${houses.length > 1 ? `<option value="${ALL_HOUSES}">Во все мои дома (${houses.length})</option>` : ''}
          </select>`
        : `<div class="dsp-hint" style="margin-top:0">Дом: ${esc(displayAddress(houseLabel))}</div>`}

      <div class="field-label">Тип</div>
      <div class="chips" id="haKind">
        ${POST_KINDS.map((k) => html`
          <span class="chip ${k.value === DEFAULT_POST_KIND ? 'sel' : ''}" data-action="ha-kind"
                data-v="${esc(k.value)}" data-hint="${esc(k.hint)}">${esc(k.label)}</span>
        `).join('')}
      </div>
      <div class="dsp-hint" id="haKindHint">${esc(POST_KINDS.find((k) => k.value === DEFAULT_POST_KIND).hint)}</div>

      <div class="field-label">Заголовок</div>
      <input type="text" id="haTitle" placeholder="Например: отключение холодной воды">

      <div class="field-label">Текст</div>
      <textarea id="haBody" placeholder="Что происходит, где и что делать жильцам"></textarea>

      <div class="field-label">Актуально до</div>
      ${dateField({ id: 'haExpires', withTime: true, min: todayValue(), placeholder: 'Без срока' })}
      <div class="dsp-hint">
        После этого времени объявление перестанет висеть на главном экране
        жителя. Без срока «нет воды до 18:00» остаётся там навсегда —
        у собрания и новости срок можно не ставить.
      </div>

      <!-- Фотография объявления — одна. Сервер хранит, лента пока не показывает. -->
      <div class="field-label">Фотография</div>
      <div class="dsp-hint">${esc(WIP.postPhoto.note)}</div>
      <label class="btn-primary secondary">
        Прикрепить фотографию
        <input type="file" id="haPhoto" hidden accept="image/*" data-action="ha-photo">
      </label>
      <div id="haPhotoName" class="file-chosen">Необязательно</div>

      <div class="dsp-actions" style="margin-top:16px">
        <button class="dsp-act primary" data-action="ha-publish">Опубликовать</button>
      </div>
    </div>`;
}

/**
 * Показать выбранный файл под кнопкой.
 *
 * Поля выбора файла шлют `change`, а не `click`, — оба слушателя стоят
 * в main.js и dispatcher.js. Без этой строки кнопка выглядит нажатой
 * впустую, хотя файл уже выбран.
 */
export function showPickedPhoto(target) {
  const name = document.querySelector('#haPhotoName');
  if (!name) return;
  name.textContent = target.files?.[0]?.name
    ?? 'Необязательно';
}

/** Файл, выбранный в форме объявления, — или null. */
export function pickedPostPhoto() {
  return document.querySelector('#haPhoto')?.files?.[0] ?? null;
}

/** Собрать данные формы объявления. Возвращает null, если не заполнено. */
export function readPostForm() {
  const title = document.querySelector('#haTitle')?.value.trim() ?? '';
  const body = document.querySelector('#haBody')?.value.trim() ?? '';
  const category = document.querySelector('#haKind .chip.sel')?.dataset.v ?? 'news';
  const rawExpires = document.querySelector('#haExpires')?.value ?? '';
  const houseKey = document.querySelector('#haHouse')?.value;

  if (title.length < 3 || body.length < 5) return null;

  return {
    houseKey,
    category,
    title,
    body,
    // datetime-local отдаёт местное время без зоны — доверяем браузеру
    expiresAt: rawExpires ? new Date(rawExpires).toISOString() : undefined,
  };
}

/**
 * Список объявлений кабинета.
 *
 * `action` обязателен и приходит от вызывающего: кнопка без обработчика
 * не ломает ни сборку, ни типы, ни тесты — только приложение, и значение
 * по умолчанию здесь однажды стало бы именно такой кнопкой.
 */
export function postList(posts, total = posts.length, action) {
  if (posts.length === 0) {
    return '<div class="dsp-empty">Объявлений пока нет</div>';
  }

  return html`
    <div class="dsp-card">
      <h2>Опубликованные объявления</h2>
      <div class="ha-list">
        ${posts.map((p) => html`
          <div class="ha-row ${p.removed ? 'off' : ''}">
            <div>
              <div class="ha-t">${esc(p.title)}</div>
              <div class="ha-d">
                ${esc(p.categoryLabel)} · ${esc(p.author)} · ${esc(formatDate(p.publishedAt))}
                ${p.expiresAt ? ` · до ${esc(formatDate(p.expiresAt))}` : ''}
              </div>
            </div>
            <div class="ha-state">${stateLabel(p)}</div>
            ${p.removed
              ? '<span></span>'
              : html`<button class="dsp-act danger" data-action="ha-remove" data-id="${esc(p.id)}">
                       Снять
                     </button>`}
          </div>`).join('')}
      </div>

      ${total > posts.length ? html`
        <div class="dsp-more">
          <span class="dsp-dim">Показаны ${posts.length} из ${total}</span>
          <button class="dsp-mini" data-action="${esc(action)}">Показать ещё</button>
        </div>` : ''}
    </div>`;
}

/**
 * Состояние объявления словами.
 *
 * «На главном экране» — только у действующего отключения: баннер наверху
 * приложения показывает именно их. Собрание и новость живут в ленте, и
 * обещать им место на главном экране было бы неправдой.
 */
function stateLabel(p) {
  if (p.removed) return '<span class="pill">снято</span>';
  if (p.expired) return '<span class="pill">срок вышел</span>';
  if (p.category === 'outage') return '<span class="pill ok">на главном экране</span>';
  return '<span class="pill ok">в ленте дома</span>';
}

/**
 * Форма опроса для кабинета УК.
 *
 * `houses` — дома на выбор, как у объявления. Без выбора дома форма
 * была немой: кнопка всегда отвечала «Выберите дом», а выбрать было
 * негде, и УК не могла запустить ни одного опроса.
 */
export function pollForm({ houses = [] } = {}) {
  return html`
    <div class="dsp-card">
      <h2>Новый опрос дома</h2>
      <div class="dsp-hint" style="margin-top:0">
        Это опрос, а не общее собрание собственников: голоса считаются по
        людям, а не по долям, и юридической силы у результата нет.
      </div>

      <div class="field-label">Дом</div>
      ${houses.length
        ? html`<select id="hpHouse" class="dsp-select">
            ${houses.map((h) => `<option value="${esc(h.houseKey)}">${esc(displayAddress(h.label))}</option>`).join('')}
          </select>`
        : '<div class="dsp-hint" style="margin-top:0">В ваших домах пока нет жителей в приложении — голосовать некому.</div>'}

      <div class="field-label">Вопрос</div>
      <input type="text" id="hpTitle" placeholder="Например: ставим ли шлагбаум на въезде">

      <div class="field-label">Пояснение</div>
      <textarea id="hpDesc" placeholder="Зачем спрашиваем и что будет с результатом"></textarea>

      <div class="field-label">Варианты ответа, по одному в строке</div>
      <textarea id="hpOptions" placeholder="Каждый вариант с новой строки">За&#10;Против&#10;Воздержался</textarea>

      <div class="field-label">Голосование до</div>
      ${dateField({ id: 'hpCloses', withTime: true, min: todayValue(), placeholder: 'Срок не выбран' })}

      <div class="dsp-actions" style="margin-top:16px">
        <button class="dsp-act primary" data-action="hp-create">Запустить опрос</button>
      </div>
    </div>`;
}

export function readPollForm() {
  const title = document.querySelector('#hpTitle')?.value.trim() ?? '';
  const options = (document.querySelector('#hpOptions')?.value ?? '')
    .split('\n')
    .map((o) => o.trim())
    .filter(Boolean);
  const rawCloses = document.querySelector('#hpCloses')?.value ?? '';

  if (!title || options.length < 2) return null;

  return {
    title,
    description: document.querySelector('#hpDesc')?.value.trim() || undefined,
    options,
    closesAt: rawCloses ? new Date(rawCloses).toISOString() : undefined,
  };
}

export function pollList(polls) {
  if (polls.length === 0) return '<div class="dsp-empty">Опросов пока нет</div>';

  return html`
    <div class="dsp-card">
      <h2>Опросы дома</h2>
      <div class="ha-list">
        ${polls.map((p) => html`
          <div class="ha-row">
            <div>
              <div class="ha-t">${esc(p.title)}</div>
              <div class="ha-d">
                ${p.closed ? 'завершён' : 'идёт'} ·
                проголосовало ${esc(p.total)} ·
                ${p.byChairman ? 'от председателя' : 'от УК'}
              </div>
              <div class="ha-bars">
                ${p.options.map((o) => html`
                  <div class="ha-bar">
                    <span class="l">${esc(o.text)}</span>
                    <span class="track"><span class="fill"
                      style="width:${p.total ? Math.round((o.votes / p.total) * 100) : 0}%"></span></span>
                    <span class="n">${esc(o.votes)}</span>
                  </div>`).join('')}
              </div>
            </div>
            <span></span><span></span>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ─────────────── телефоны дома ─────────────── */

/**
 * Редактор телефонов дома — один на председателя, УК и оператора.
 *
 * Три копии формы разъехались бы: в одной появилось бы поле, которого
 * нет в другой, и номер из кабинета УК выглядел бы у жителя иначе.
 * Отличается только вид: `app` — экраны приложения, `cabinet` — кабинеты.
 * Обёртку-карточку рисует вызывающий.
 *
 * `houseKey` кладётся на кнопки: у УК и оператора домов много.
 */
export function contactsEditor({ kinds = [], contacts = [], look = 'app', houseKey = '' }) {
  const cab = look === 'cabinet';
  const hint = cab ? 'dsp-hint' : 'hc-hint';
  const key = esc(houseKey);

  const rows = contacts.length
    ? contacts.map((c) => html`
        <div class="${cab ? 'ha-row' : 'row'}">
          <div class="${cab ? '' : 'content'}">
            <div class="${cab ? 'ha-t' : 't'}">${esc(c.title)}</div>
            <div class="${cab ? 'ha-d' : 'd'}">
              ${esc(c.phone)}${c.note ? ` · ${esc(c.note)}` : ''}
            </div>
          </div>
          <button class="${cab ? 'dsp-mini danger' : 'chip'}" data-action="hc-remove"
                  data-id="${esc(c.id)}" data-key="${key}">Удалить</button>
        </div>`).join('')
    : html`<div class="${hint}">
        Телефонов пока нет. Жители увидят их на экране «Аварийные службы».
      </div>`;

  return html`
    <div class="${cab ? '' : 'list'}">${rows}</div>

    <div class="field-label">Что за служба</div>
    <div class="chips" id="hcKind">
      ${kinds.map((k, i) => html`
        <span class="chip ${i === 0 ? 'sel' : ''}" data-action="hc-kind"
              data-v="${esc(k.kind)}">${esc(k.label)}</span>`).join('')}
    </div>

    <div id="hcLabelWrap" hidden>
      <div class="field-label">Чей номер</div>
      <input type="text" id="hcLabel" maxlength="60" placeholder="Например: бухгалтерия ТСЖ">
    </div>

    <div class="field-label">Телефон</div>
    <input type="text" id="hcPhone" inputmode="tel" autocomplete="off" placeholder="+7 863 200-00-00">

    <div class="field-label">Пометка</div>
    <input type="text" id="hcNote" maxlength="80" placeholder="Например: круглосуточно">

    <div class="${hint}">
      Номер готовой службы заменяет прежний. По нему звонят в аварию —
      сверьте цифры перед сохранением.
    </div>

    <button class="${cab ? 'dsp-act primary' : 'btn-primary'}" data-action="hc-save"
            data-key="${key}" style="margin-top:14px">Сохранить</button>`;
}

/** Выбор типа: у «Другое» появляется поле названия. */
export function pickContactKind(target) {
  target.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
  target.classList.add('sel');
  const wrap = document.querySelector('#hcLabelWrap');
  if (wrap) wrap.hidden = target.dataset.v !== 'other';
}

export function readContactForm() {
  const value = (sel) => document.querySelector(sel)?.value.trim() ?? '';
  return {
    kind: document.querySelector('#hcKind .chip.sel')?.dataset.v ?? '',
    label: value('#hcLabel'),
    phone: value('#hcPhone'),
    note: value('#hcNote'),
  };
}
