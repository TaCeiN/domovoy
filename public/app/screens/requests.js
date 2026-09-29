import { api } from '../api.js';
import { platform } from '../platform.js';
import { displayAddress,
  esc, html, formatDate, formatDay, skeletonState, errorState, emptyState, toast, withLoading,
  eventAuthor, eventRole, moreLine, keepScroll, plural, confirmAction, askText,
} from '../ui.js';
import { wipNote } from '../wip.js';
import { dateField } from '../datepicker.js';
import { setBackHook } from '../router.js';
import { chatTimeline } from '../chat.js';

/**
 * Заявки: список, деталка с историей, форма создания.
 *
 * Срок реакции показываем везде, где показываем статус. Житель должен
 * понимать, когда ждать мастера, — иначе он всё равно позвонит в УК,
 * и приложение не снимет с них ни одного звонка.
 */

const CATEGORIES = [
  'Авария', 'Сантехника', 'Электрика', 'Лифт', 'Общее имущество', 'Другое',
];

const SLA_TONE = { ok: '', soon: 'warn', overdue: 'bad' };

export function requestsSkeleton() {
  return `<div class="page active" id="page-requests">${skeletonState('list', 'Загружаем обращения…')}</div>`;
}

/**
 * Сколько строк архива показано сейчас.
 *
 * Активные потолка не знают — их единицы. Архив за год дорастает
 * до шести десятков строк, и его же листают в поисках прошлогодней
 * жалобы, поэтому режется именно он.
 */
const ARCHIVE_STEP = 50;
let archiveShown = ARCHIVE_STEP;

export async function renderRequests(state) {
  let data;
  try {
    // Обращения принадлежат квартире — показываем только активную
    data = await api.requests(state?.currentProperty?.propertyId, archiveShown);
  } catch (error) {
    return errorState(error, 'requests');
  }

  const tab = window.__reqTab ?? 'active';
  const list = tab === 'active' ? data.active : data.archive;
  const archiveTotal = data.archiveTotal ?? data.archive.length;

  return html`
    <div class="tabs" style="padding:0 0 12px">
      <span class="tab ${tab === 'active' ? 'on' : ''}" data-action="req-tab" data-tab="active">
        Активные · ${data.active.length}
      </span>
      <span class="tab ${tab === 'archive' ? 'on' : ''}" data-action="req-tab" data-tab="archive">
        Архив · ${archiveTotal}
      </span>
    </div>

    ${list.length
      ? `<div class="list">${list.map(row).join('')}</div>`
        + (tab === 'archive'
          ? moreLine({ shown: list.length, total: archiveTotal, action: 'req-more' })
          : '')
      : (tab === 'active'
          ? emptyState(
              'Активных обращений нет',
              'Если в квартире или подъезде что-то сломалось — оформите обращение, диспетчер примет его в работу',
              { action: 'complaint', label: 'Подать обращение' },
              'requests',
            )
          : emptyState(
              'Архив пуст',
              'Выполненные и отклонённые обращения сохранятся здесь с датами и историей переписки',
              null,
              'archive',
            ))}

    ${tab === 'active' && list.length > 0
      // В архиве кнопки нет: там смотрят прошлое, а не заводят новое (27.09)
      ? '<button class="btn-primary" data-action="complaint">Новое обращение</button>'
      : ''}
  `;
}

function row(r) {
  const tone = r.status === 'done' ? 'ok' : r.status === 'new' ? 'new'
    : r.status === 'rejected' ? 'bad' : '';

  /**
   * «Нужны уточнения» в списке выглядел ровно как «в работе», и заявка
   * молча стояла: житель не знал, что ход за ним. Поэтому вторая строка
   * говорит прямо, что от него ждут ответа, и дату вытесняет: когда ход
   * за человеком, это важнее календаря.
   *
   * В остальных строках дата обязательна. Список отсортирован по времени,
   * а времени в нём не было: за год архив дорастает до шести десятков
   * строк, и вопрос «когда я жаловался на лифт» решался только
   * открыванием карточек по одной. Номер не помогает — нумерация сквозная
   * по управляющей организации, и соседние строки идут вразнобой.
   */
  const sub = r.awaitingResident
    ? 'Диспетчер ждёт вашего ответа'
    : `№ ${esc(r.number)} · ${esc(r.category)} · ${esc(formatDay(r.createdAt))}`;

  return html`
    <button class="wrow tappable" data-action="request" data-id="${esc(r.id)}">
      <span class="sq ${r.awaitingResident ? '' : tone}">${statusIcon(r.status, r.awaitingResident)}</span>
      <div class="content">
        <div class="t">${esc(r.title)}</div>
        <div class="d ${r.awaitingResident ? 'ask' : ''}">${sub}</div>
      </div>
      <span class="pill ${tone}">${esc(r.statusLabel)}</span>
    </button>`;
}

function statusIcon(status, awaiting) {
  if (awaiting) {
    return '<svg viewBox="0 0 20 20" fill="none"><path d="M10 3.2C6.3 3.2 3.3 5.7 3.3 8.8C3.3 10.6 4.3 12.2 5.9 13.2L5.2 16L8.2 14.3C8.8 14.4 9.4 14.5 10 14.5C13.7 14.5 16.7 12 16.7 8.8C16.7 5.7 13.7 3.2 10 3.2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }
  if (status === 'done') {
    return '<svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5L8.2 14.2L15.5 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  if (status === 'rejected') {
    return '<svg viewBox="0 0 20 20" fill="none"><path d="M5.5 5.5L14.5 14.5M14.5 5.5L5.5 14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }
  return '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.6"/><path d="M10 6V10.2L12.8 11.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

/* ─────────────── деталка ─────────────── */

export async function renderRequestDetail(id) {
  let r;
  try {
    r = await api.request(id);
  } catch (error) {
    return errorState(error, 'requests');
  }

  const closed = r.closed ?? (r.status === 'done' || r.status === 'rejected');
  const question = lastQuestion(r);

  return html`
    <div class="req-chat">
      <!--
        Чат на весь экран (просьба владельца 29.09): сверху одна строка
        о заявке, подробности — по нажатию. Главное на экране — разговор.
      -->
      <button class="req-head" data-action="toggle-req-info" aria-expanded="false">
        <span class="req-head-main">
          <span class="req-head-t">${esc(r.title)}</span>
          <span class="req-head-d">№ ${esc(r.number)} · ${esc(r.category)}${!closed && r.hasDeadline && r.slaLabel
            ? html` · <span class="sla-inline ${SLA_TONE[r.sla] ?? ''}">${r.sla === 'overdue' ? 'срок вышел' : `срок ${esc(r.slaLabel)}`}</span>` : ''}</span>
        </span>
        <span class="pill ${statusTone(r.status)}">${esc(r.statusLabel)}</span>
      </button>

      <div class="req-info" id="reqInfo" hidden>
        ${r.status === 'rejected'
          // Отклонённой заявке трек не рисуем: закрашенный конец читается как «сделано»
          ? ''
          : html`
            ${track(r.status)}
            <div class="track-labels"><span>отправлено</span><span>в работе</span><span>выполнено</span></div>`}
        ${r.assigneeName ? html`<div class="req-info-row"><span>Мастер</span><b>${esc(r.assigneeName)}</b></div>` : ''}
        ${r.masterSlotStart ? html`<div class="req-info-row"><span>Удобное время</span><b>${esc(slotText(r))}</b></div>` : ''}
        ${r.category === 'Авария' && !closed ? '' : contactBlock(r.addressee)}
        <!--
          ГЛАВНАЯ ЦЕННОСТЬ ПРОДУКТА, которую надо назвать вслух: архив УК
          неудаляемый по построению — маршрута удаления заявки нет.
        -->
        <div class="dt-p req-info-note">
          <b>Это обращение нельзя удалить.</b> Управляющая компания может
          изменить статус или отклонить его с объяснением, но запись
          и вся переписка останутся в её архиве и у вас.
        </div>
      </div>

      ${r.category === 'Авария' && !closed ? contactBlock(r.addressee) : ''}

      ${chatTimeline(r, 'resident')}

      ${r.status === 'done' ? ratingBlock(r) : ''}

      <div class="chat-bar">
        ${closed ? (canDispute(r) ? html`
          <div class="chat-closed">Работа не сделана? Верните заявку — срок реакции пойдёт заново.</div>
          <button class="btn-primary secondary" data-action="dispute-request" data-id="${esc(r.id)}">
            Проблема не решена
          </button>` : html`
          <div class="chat-closed">Заявка закрыта — дописать в неё нельзя. Если проблема вернулась, заведите новую.</div>`)
        : html`
          ${r.awaitingResident ? html`
            <div class="chat-ask">Диспетчер ждёт вашего ответа${question ? html`: <b>${esc(question)}</b>` : ''}</div>` : ''}
          <div id="reqReplyFilesList" class="chat-picked" data-hint=""></div>
          <div class="field-error" id="reqReplyErr"></div>
          <div class="chat-input">
            <!--
              Файлы можно приложить и к дополнению: «протечка стала хуже,
              вот фотография» — самый частый повод вернуться в обращение.
            -->
            <label class="chat-clip" aria-label="Прикрепить файл">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <input type="file" id="reqReplyFiles" hidden multiple accept="image/*,application/pdf" data-action="pick-reply-files">
            </label>
            <textarea id="reqReply" rows="1" placeholder="${r.awaitingResident ? 'Ответьте диспетчеру' : 'Сообщение диспетчеру'}"></textarea>
            <button class="chat-send" data-action="send-comment" data-id="${esc(r.id)}" aria-label="Отправить">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>`}
      </div>
    </div>`;
}

/** После отрисовки карточки: подгрузить миниатюры фото */
export function mountRequestDetail(host) {
  for (const thumb of host.querySelectorAll('.att-thumb[data-url]')) {
    fileObjectUrl(thumb.dataset.url)
      .then(({ href }) => {
        thumb.style.backgroundImage = `url("${href}")`;
        thumb.classList.add('ready');
      })
      .catch(() => thumb.classList.add('failed'));
  }

  /**
   * Чат открывается на последнем сообщении, как в мессенджере: человек
   * пришёл узнать, что ему ответили, а не перечитать своё описание.
   */
  if (host.querySelector('.req-chat')) {
    const page = host.closest('.page') ?? host;
    requestAnimationFrame(() => { page.scrollTop = page.scrollHeight; });
  }

  /** Поле растёт с текстом до пяти строк, дальше прокручивается само */
  const field = host.querySelector('#reqReply');
  field?.addEventListener('input', () => {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
  });
}

/** Выполненную — месяц после закрытия, как на сервере (DISPUTE_DAYS) */
function canDispute(r) {
  if (r.status !== 'done' || !r.closedAt) return false;
  return Date.now() - new Date(r.closedAt).getTime() < 30 * 86_400_000;
}

/**
 * Связь по заявке — только настоящий телефон и только настоящей ссылкой.
 *
 * ЧТО ЗДЕСЬ БЫЛО. Литерал «+7 (495) 123-45-67 · будни 8:00–20:00»
 * и кнопка с обработчиком `toast('Звоним: …')`, которая никуда
 * не звонила. Выдуманный московский номер и выдуманный график работы
 * в приложении, чьё правило звучит «данные — только настоящие»,
 * при том что настоящий телефон организации лежит в реестре.
 *
 * Теперь номер приходит с сервера (`addressee.phone`), а его отсутствие
 * — это ответ: блока просто нет. Пустая строка честнее выдуманной.
 *
 * Ссылка, а не кнопка: `tel:` набирает номер сам, без нашего кода.
 */
function contactBlock(addressee) {
  if (!addressee?.phone) return '';

  const title = addressee.kind === 'org'
    ? `Позвонить в «${esc(addressee.name)}»`
    : 'Позвонить';

  return html`
    <div class="field-label">Связь по заявке</div>
    <div class="list">
      <a class="row tappable" href="tel:${esc(telHref(addressee.phone))}">
        <span class="sq new"><svg viewBox="0 0 20 20" fill="none"><path d="M4 4.5C4 4 4.5 3.2 5.2 3.2H7L8.2 6.8L6.5 8C7.2 9.8 9 11.8 10.8 12.5L12 10.8L15.6 12V13.8C15.6 14.5 15 15 14.3 15C8.6 15 4 10.4 4 4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></span>
        <div class="content">
          <div class="t">${title}</div>
          <!-- Графика работы мы не знаем и придумывать его не будем -->
          <div class="d">${esc(addressee.phone)}</div>
        </div>
      </a>
    </div>`;
}

/**
 * Номер для `tel:`: всё, кроме цифр и ведущего плюса, набору мешает.
 *
 * Реестр пишет городские номера без кода страны: «(863) 247-09-43» —
 * это десять цифр, и `tel:8632470943` с мобильного не набирается
 * (аудит 26 сентября). Десять цифр — российский номер без +7;
 * одиннадцать с восьмёркой — тот же номер по-старому. Короткие
 * (112, 104) не трогаем.
 */
export function telHref(phone) {
  const digits = String(phone ?? '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return `+${digits.slice(1).replace(/\+/g, '')}`;
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  return digits;
}

function statusTone(status) {
  if (status === 'done') return 'ok';
  if (status === 'new') return 'new';
  if (status === 'rejected') return 'bad';
  return '';
}

/** Окно приёма мастера: «21 августа, 13:00–18:00». */
export function slotText(r) {
  if (!r.masterSlotStart) return '';
  const start = new Date(r.masterSlotStart);
  const end = r.masterSlotEnd ? new Date(r.masterSlotEnd) : null;
  const day = start.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const hhmm = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return end ? `${day}, ${hhmm(start)}–${hhmm(end)}` : `${day}, ${hhmm(start)}`;
}

/** Последний вопрос диспетчера — его показываем прямо в баннере. */
function lastQuestion(r) {
  const found = [...(r.events ?? [])].reverse().find((e) => e.actor === 'dispatcher');
  return found?.text ?? null;
}

function track(status) {
  const stage = status === 'new' ? 0
    : status === 'in_work' || status === 'need_info' ? 1
    : 2;
  const dot = (i) => i < stage ? 'done' : i === stage ? 'on' : '';
  const seg = (i) => i < stage ? 'done' : '';
  return html`
    <div class="track">
      <div class="pt ${dot(0)}"></div><div class="seg ${seg(0)}"></div>
      <div class="pt ${dot(1)}"></div><div class="seg ${seg(1)}"></div>
      <div class="pt ${dot(2)}"></div>
    </div>`;
}

function ratingBlock(r) {
  if (r.rating) {
    return html`
      <div class="field-label">Ваша оценка</div>
      <div class="dt-card" style="margin-top:0;display:flex;align-items:center;gap:12px">
        <div class="stars readonly">${stars(r.rating.stars)}</div>
        <span style="font-size:14px;color:var(--tx-2)">Спасибо за оценку</span>
      </div>`;
  }
  return html`
    <div class="field-label">Оцените выполнение</div>
    <div class="dt-card" style="margin-top:0">
      <div class="stars" id="rateStars">
        ${[1, 2, 3, 4, 5].map((n) => html`
          <span class="star" data-action="rate" data-id="${esc(r.id)}" data-stars="${n}">${starSvg()}</span>
        `).join('')}
      </div>
    </div>`;
}

function stars(value) {
  return [1, 2, 3, 4, 5]
    .map((n) => `<span class="star ${n <= value ? 'on' : ''}">${starSvg()}</span>`)
    .join('');
}

const starSvg = () =>
  '<svg width="24" height="24" viewBox="0 0 22 22" fill="none"><path d="M11 2L13.5 8.2L20 8.7L15 12.9L16.6 19.3L11 15.8L5.4 19.3L7 12.9L2 8.7L8.5 8.2L11 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity="0"/></svg>';

/* ─────────────── форма создания ─────────────── */

/**
 * Окна приёма мастера.
 *
 * Раньше здесь были готовые пары «день + окно» на три ближайших дня,
 * и дальше послезавтра позвать мастера было нельзя — а люди уезжают,
 * работают в смену и планируют неделями. Теперь день выбирается
 * календарём, а окно остаётся списком: обещать «мастер в 14:20» УК
 * не может, и промах по обещанию хуже широкого окна.
 */
const MASTER_WINDOWS = [
  { from: 9, to: 13, label: '9:00–13:00' },
  { from: 13, to: 18, label: '13:00–18:00' },
  { from: 18, to: 21, label: '18:00–21:00' },
];

/** Завтра — разумное умолчание: сегодняшние окна чаще всего уже прошли */
function tomorrow(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * День и окно → две отметки времени для заявки.
 *
 * Возвращает пустое, если день не выбран: окно приёма необязательно,
 * и заявка без него — обычное дело.
 */
export function masterSlotFrom(day, windowIndex) {
  const w = MASTER_WINDOWS[Number(windowIndex)];
  if (!day || !w) return {};
  const [y, m, d] = day.split('-').map(Number);
  return {
    slotStart: new Date(y, m - 1, d, w.from, 0, 0, 0).toISOString(),
    slotEnd: new Date(y, m - 1, d, w.to, 0, 0, 0).toISOString(),
  };
}

/**
 * Размер файла человеческими словами.
 *
 * «0 КБ» у маленькой картинки читается как ошибка загрузки, поэтому
 * всё, что меньше килобайта, называем прямо.
 */
function fileSize(bytes) {
  const size = Number(bytes ?? 0);
  if (size < 1024) return 'меньше 1 КБ';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

/** Столько файлов принимает ОДНО обращение — потолок сервера. */
const MAX_FILES = 5;

/**
 * Сколько файлов ещё можно приложить.
 *
 * Потолок общий на обращение, а не на сообщение: `saveAttachment` считает
 * уже приложенные и отвечает отказом. Значит сказать об этом надо ДО того,
 * как человек выберет шестой файл, — иначе отказ приходит на ровном месте
 * и выглядит поломкой.
 */
function attachRoom(r) {
  const left = MAX_FILES - (r.photos?.length ?? 0);
  if (left <= 0) return `К обращению уже приложено ${MAX_FILES} файлов — это предел`;
  if (left === MAX_FILES) return 'Фотография помогает больше описания. До пяти файлов, каждый до 10 МБ';
  return `Можно приложить ещё ${left} ${plural(left, 'файл', 'файла', 'файлов')}, каждый до 10 МБ`;
}

/**
 * Кто увидит обращение — называем всех, а не только главного адресата.
 *
 * Право читать обращения дома и отвечать в переписке дано председателю
 * ПО ВСЕМУ ДОМУ, включая дома с управляющей компанией, — а строка ниже
 * раньше показывалась только при её отсутствии. Получалось зеркало той
 * же неправды, которую эта же работа чинила: раньше приложение обещало
 * доступ, которого не было, теперь есть доступ, о котором молчат. Человек
 * пишет жалобу на соседа сверху, считая адресатом только УК, — а прочитает
 * её ещё и совет дома, возможно, тот самый сосед.
 */
function addresseeLine(hm) {
  if (!hm) return '';

  /**
   * Организация, известная реестру, — это ещё не читатель.
   *
   * Кабинет диспетчера заводится отдельной командой, и 11 сентября
   * замерено: 14 221 дом области в реестре, кабинет есть у восьми.
   * Пока строка смотрела только на `orgName`, всем прочим обещался
   * диспетчер, которого не существует.
   */
  const reader = hm.orgName && hm.orgHasCabinet;

  if (reader && hm.hasChairman) {
    return html`<div class="warn-line" style="margin-top:2px">
        Обращение увидят управляющая компания «${esc(hm.orgName)}» и совет дома.
      </div>`;
  }
  if (reader) {
    // Единственный адресат ясен без отдельной строки
    return '';
  }
  if (hm.orgName && hm.hasChairman) {
    return html`<div class="warn-line" style="margin-top:2px">
        Обращение увидит совет дома. Управляющая компания «${esc(hm.orgName)}»
        за вашим домом закреплена, но кабинета в сервисе у неё пока нет —
        туда запись попадёт, когда он появится.
      </div>`;
  }
  if (hm.hasChairman) {
    return html`<div class="warn-line" style="margin-top:2px">
        Обращение увидит совет дома: управляющей компании у вашего дома нет.
      </div>`;
  }
  if (hm.orgName) {
    return html`<div class="warn-line" style="margin-top:2px">
        За вашим домом закреплена «${esc(hm.orgName)}», но кабинета в сервисе
        у неё пока нет, а председателя у дома тоже. Запись сохранится с датой
        и никуда не денется — её увидит тот, кто первым возьмётся за дом.
      </div>`;
  }
  return html`<div class="warn-line" style="margin-top:2px">
      Адресата пока нет — за домом никто не закреплён. Запись сохранится
      с датой и никуда не денется: её увидит тот, кто возьмётся за дом.
    </div>`;
}

/**
 * Авария — сначала позвонить, потом записать.
 *
 * Аудит 26 сентября: «Течёт стояк, заливает 3 этаж» уходила зелёной
 * галочкой с текстом «запись дождётся того, кто возьмётся за дом», а
 * телефон УК лежал в самом низу карточки заявки. Человеку, у которого
 * заливает подъезд, запись с датой не поможет — нужен звонок. Блок
 * показывается при выборе «Авария» и повторяет экран «Аварийные службы».
 */
function emergencyBlock(property, visible) {
  const phone = property?.ukPhone;
  const org = property?.ukName;
  return html`
    <div class="ask-card" id="reqEmergency" ${visible ? '' : 'hidden'}>
      <div class="ask-h">Если заливает, пахнет газом или угроза жизни — звоните</div>
      <div class="ask-d" style="margin-bottom:10px">
        Запись в приложении — доказательство с датой, но аварию устраняют по звонку.
      </div>
      <div class="list">
        ${phone ? html`
          <a class="row tappable" href="tel:${esc(telHref(phone))}">
            <div class="content"><div class="t">${esc(org ?? 'Управляющая компания')}</div>
            <div class="d">${esc(phone)}</div></div>
          </a>` : ''}
        <a class="row tappable" href="tel:104">
          <div class="content"><div class="t">Аварийная газовая служба</div><div class="d">104</div></div>
        </a>
        <a class="row tappable" href="tel:112">
          <div class="content"><div class="t">Единая служба спасения</div><div class="d">112</div></div>
        </a>
      </div>
    </div>`;
}

/**
 * `prefill` — категория и текст, когда жалобу открывают с другого экрана:
 * «Вызов мастера» ведёт сюда, если сломано общее имущество.
 */
export function renderComplaintForm(state, kind = 'complaint', prefill = {}) {
  const property = state.currentProperty;
  const isMaster = kind === 'master';

  /**
   * Форма НЕ закрывается никогда.
   *
   * Раньше отсутствие УК закрывало её совсем, и ядро продукта — жалоба
   * с датой, которую нельзя удалить, — было недоступно ровно тем домам,
   * у которых нет управляющей компании: ТСЖ, непосредственное
   * управление, частные дома. Доказательство нужно человеку и тогда,
   * когда прочитать жалобу сегодня некому.
   */
  const addressee = addresseeLine(property?.houseManagement);

  /**
   * Порядок строк: сначала «что это за функция сегодня», потом «кто увидит
   * ваше обращение». Второе бессмысленно читать раньше первого.
   */
  return html`
    ${isMaster ? wipNote('master') : ''}
    ${addressee}
    <div class="field-label" style="margin-top:2px">Категория</div>
    <div class="chips" id="catChips">
      ${CATEGORIES.map((c) => html`
        <span class="chip ${prefill.category === c ? 'sel' : ''}" data-action="pick-cat" data-v="${esc(c)}">${esc(c)}</span>
      `).join('')}
    </div>
    <div class="field-error" id="reqCatErr"></div>
    ${emergencyBlock(property, prefill.category === 'Авария')}

    <div class="field-label">Адрес</div>
    <div class="readonly-field">${esc(displayAddress(property?.addressRaw ?? ''))}</div>

    <div class="field-label">Опишите проблему</div>
    <textarea id="reqDesc" placeholder="Например: течёт труба под раковиной на кухне, вода идёт на пол">${esc(prefill.text ?? '')}</textarea>
    <div class="field-error" id="reqDescErr"></div>

    ${isMaster ? html`
      <div class="field-label">Когда удобно принять мастера</div>
      ${dateField({
        id: 'masterDay',
        value: tomorrow(),
        placeholder: 'Выберите день',
        min: today(),
      })}
      <div class="chips" id="slotChips" style="margin-top:10px">
        ${MASTER_WINDOWS.map((w, i) => html`
          <span class="chip" data-action="pick-slot" data-w="${i}">${esc(w.label)}</span>
        `).join('')}
      </div>
      <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin-top:10px">
        Окно не обязательно — это пожелание, которое диспетчер увидит вместе
        с заявкой. Точное время он согласует с вами сам, вне приложения.
      </div>
    ` : ''}

    <div class="field-label">Фотографии и документы</div>
    <label class="btn-primary secondary">
      Прикрепить файл
      <input type="file" id="reqFiles" hidden multiple
             accept="image/*,application/pdf" data-action="pick-files">
    </label>
    <div id="reqFilesList" class="dt-p" style="font-size:13px;color:var(--tx-2)">
      Фотография протечки или скан акта помогают диспетчеру больше, чем
      описание. Можно приложить до пяти файлов, каждый до 10 МБ.
    </div>

    ${property?.houseManagement?.orgHasCabinet ? html`
      <div class="dt-p">
        Сроки реакции, о которых управляющая компания договорилась в сервисе:
        авария — 2 часа, лифт — 8 часов, сантехника и электрика — сутки,
        остальное — трое суток.
      </div>` : ''}

    <button class="btn-primary" id="reqSubmit" data-action="submit-request" data-kind="${esc(kind)}"
            data-draft="${esc(prefill.draftId ?? '')}">
      ${isMaster ? 'Вызвать мастера' : 'Отправить обращение'}
    </button>`;
}

/**
 * Часы по-русски: 2 часа, 8 часов, 24 часа, 72 часа.
 *
 * Прежняя формула «меньше пяти — часа, иначе часов» давала «24 часов»
 * ровно там, где житель читает срок реакции по своей заявке.
 */
function hoursWord(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'часов';
  const mod10 = n % 10;
  if (mod10 === 1) return 'час';
  if (mod10 >= 2 && mod10 <= 4) return 'часа';
  return 'часов';
}

/**
 * Что сказать о судьбе обращения — та же цепочка «кто увидит», что решает
 * строку адресата на форме (addresseeLine), только в прошедшем времени
 * и с обещанием, которое приложение способно сдержать.
 *
 * Раньше текст был один на все три случая: «диспетчер увидит сразу, статус
 * придёт уведомлением» — сразу после формы, которая честно говорила
 * «адресата пока нет». У дома без организации диспетчера не существует,
 * статус не поменяет никто, и уведомление никогда не придёт.
 */
function successText(hm, slaHours, word) {
  /**
   * Срок реакции и уведомление обещаем ТОЛЬКО при живом кабинете.
   *
   * Прежнее условие — `hm?.orgName` — выполнялось у каждого дома
   * из реестра, то есть у 14 213 домов области, где читать заявку
   * некому. Житель получал номер, срок и обещание уведомления,
   * а через сутки — красное «Срок вышел», из которого следовало,
   * что УК его проигнорировала. Компания при этом о заявке не знала.
   */
  if (hm?.orgName && hm?.orgHasCabinet) {
    return `Диспетчер увидит заявку сразу. Срок реакции по этой категории —
            ${slaHours} ${word}. Статус придёт уведомлением.`;
  }
  if (hm?.hasChairman) {
    return `Обращение увидит совет дома. Статус менять некому — кабинета
            управляющей компании в сервисе пока нет, — но запись останется
            с датой и никуда не денется.`;
  }
  if (hm?.orgName) {
    return `Обращение сохранено с датой. За вашим домом закреплена
            «${hm.orgName}», но кабинета в сервисе у неё пока нет:
            запись дождётся того, кто возьмётся за дом.`;
  }
  return `За вашим домом пока никто не закреплён, но обращение сохранено
          с датой — его увидит тот, кто возьмётся за дом.`;
}

export function renderSuccess({ number, slaHours, houseManagement, category, ukPhone, ukName }) {
  const word = hoursWord(slaHours);
  /**
   * Позвонить — когда запись одна не поможет: авария или адресат,
   * который заявку сегодня не прочитает (кабинета у УК нет).
   */
  const noReader = !(houseManagement?.orgName && houseManagement?.orgHasCabinet);
  const callUk = ukPhone && (category === 'Авария' || noReader);
  return html`
    <div class="success-wrap">
      <div class="success-ic">
        <svg width="30" height="30" viewBox="0 0 28 28" fill="none"><path d="M6 14.5L11 19.5L22 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="success-h">Обращение отправлено</div>
      <div class="success-p">
        ${successText(houseManagement, slaHours, word)}
      </div>
      <div class="success-num">№ ${esc(number)}</div>
      ${callUk ? html`
        <a class="btn-primary" style="max-width:260px;margin-bottom:10px" href="tel:${esc(telHref(ukPhone))}">
          Позвонить в ${esc(ukName ?? 'УК')}
        </a>
        <div class="success-p" style="font-size:13px">
          ${category === 'Авария'
            ? 'При аварии звоните сразу: заявку в приложении не прочитают за минуты.'
            : 'Номер из реестра — назовите номер обращения, он сохранён с датой.'}
        </div>` : ''}
      <button class="btn-primary" style="max-width:260px" data-action="requests">
        К моим обращениям
      </button>
    </div>`;
}

/**
 * Выбранные файлы — миниатюрой и с кнопкой «убрать».
 *
 * Раньше под кнопкой появлялось только имя файла, а ошибочно выбранный
 * убрать было нельзя — только выбирать заново все (аудит 26 сентября).
 * Список лежит рядом с полем: `#reqFiles` → `#reqFilesList`.
 */
const FILE_HINTS = {
  reqFiles: 'Фотография протечки или скан акта помогают диспетчеру больше, чем описание. Можно приложить до пяти файлов, каждый до 10 МБ.',
};

function showPicked(input) {
  const list = document.querySelector(`#${input.id}List`);
  if (!list) return;
  const picked = Array.from(input.files ?? []).slice(0, 5);
  if (!picked.length) {
    list.textContent = list.dataset.hint ?? FILE_HINTS[input.id] ?? '';
    return;
  }
  list.innerHTML = picked.map((f, i) => html`
    <div class="picked-file">
      ${f.type.startsWith('image/')
        ? `<img class="picked-thumb" alt="" src="${esc(URL.createObjectURL(f))}">`
        : '<span class="picked-thumb doc">PDF</span>'}
      <span class="picked-name">${esc(f.name)} · ${esc(fileSize(f.size))}</span>
      <button type="button" class="picked-remove" data-action="unpick-file"
              data-input="${esc(input.id)}" data-i="${i}" aria-label="Убрать файл">×</button>
    </div>`).join('');
}

/** Действия экранов заявок. Возвращает true, если действие обработано. */
export async function handleRequestAction(action, target, ctx) {
  switch (action) {
    case 'req-tab':
      window.__reqTab = target.dataset.tab;
      // Смена вкладки — это новый взгляд на список: показанное считаем заново
      archiveShown = ARCHIVE_STEP;
      // refresh, а не show: переключение «Активные / Архив» — тот же экран,
      // и шага «назад» оно добавлять не должно (как у вкладок «Совета дома»)
      await ctx.refresh();
      return true;

    case 'req-more':
      archiveShown += ARCHIVE_STEP;
      // refresh, а не show: «Показать ещё» не должно добавлять шаг «назад»
      await keepScroll(() => ctx.refresh());
      return true;

    case 'pick-cat':
    case 'pick-slot': {
      // Повторный тап по выбранному окну снимает выбор: иначе от
      // случайно нажатого времени было не избавиться
      const wasSelected = target.classList.contains('sel');
      target.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
      if (!(action === 'pick-slot' && wasSelected)) target.classList.add('sel');
      if (action === 'pick-cat') {
        document.querySelector('#reqCatErr')?.classList.remove('show');
        const sos = document.querySelector('#reqEmergency');
        if (sos) sos.hidden = target.dataset.v !== 'Авария';
      }
      return true;
    }

    case 'rate': {
      const stars = Number(target.dataset.stars);
      try {
        await api.rateRequest(target.dataset.id, stars);
        platform.haptic('medium');
        toast('Спасибо за оценку');
        const ask = await api.pickPrompt().then((r) => r.prompt).catch(() => null);
        if (ask && await confirmAction({
          title: 'Оцените и сам дом',
          text: 'Пять строк звёзд. Ваш отзыв увидят те, кто думает переехать в ваш дом.',
          confirmLabel: 'Оценить дом',
        })) {
          await ctx.show('pick-review', { key: ask.houseKey });
          return true;
        }
        await ctx.show('request', { id: target.dataset.id });
      } catch (error) {
        toast(error.message);
      }
      return true;
    }

    case 'dispute-request': {
      const text = await askText({
        title: 'Что осталось не сделано?',
        text: 'Заявка вернётся в работу, диспетчер увидит ваш ответ.',
        placeholder: 'Например: кран по-прежнему течёт',
        confirmLabel: 'Вернуть в работу',
      });
      if (!text) return true;
      try {
        await api.disputeRequest(target.dataset.id, text);
        platform.haptic('medium');
        toast('Заявка снова в работе');
        await ctx.refresh();
      } catch (error) {
        toast(error.message);
      }
      return true;
    }

    case 'toggle-req-info': {
      const info = document.querySelector('.page.active #reqInfo') ?? document.querySelector('#reqInfo');
      if (!info) return true;
      info.hidden = !info.hidden;
      target.setAttribute('aria-expanded', String(!info.hidden));
      return true;
    }

    case 'send-comment': {
      const field = document.querySelector('#reqReply');
      const err = document.querySelector('#reqReplyErr');
      const text = field?.value.trim() ?? '';

      if (text.length < 2) {
        field?.classList.add('error');
        if (err) {
          err.textContent = 'Напишите ответ — пустое сообщение диспетчеру не поможет';
          err.classList.add('show');
        }
        field?.focus();
        return true;
      }
      field?.classList.remove('error');
      err?.classList.remove('show');

      await withLoading(target, async () => {
        try {
          const result = await api.commentRequest(target.dataset.id, text);

          /**
           * Файлы уходят после сообщения, как и при создании заявки.
           * Не дошли — само сообщение уже в переписке, и терять его
           * из-за файла нельзя. Про неудачу говорим прямо: молча
           * потерянная фотография протечки хуже отказа.
           */
          const picked = Array.from(
            document.querySelector('#reqReplyFiles')?.files ?? [],
          );
          const failed = [];
          for (const file of picked) {
            try {
              await api.attachFile(target.dataset.id, file);
            } catch (error) {
              failed.push(`${file.name}: ${error.message}`);
            }
          }

          platform.haptic('medium');
          toast(failed.length
            ? `Ответ отправлен, но файлы не приложились — ${failed.join('; ')}`
            : result.reopened ? 'Ответ отправлен — заявка снова в работе' : 'Ответ отправлен');
          await ctx.show('request', { id: target.dataset.id });
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    case 'submit-request': {
      const desc = document.querySelector('#reqDesc');
      const err = document.querySelector('#reqDescErr');
      const text = desc?.value.trim() ?? '';

      if (text.length < 8) {
        desc?.classList.add('error');
        if (err) {
          err.textContent = 'Опишите проблему подробнее — хотя бы пару слов';
          err.classList.add('show');
        }
        desc?.focus();
        return true;
      }
      desc.classList.remove('error');
      err?.classList.remove('show');

      /**
       * Категорию выбирает человек, а не форма.
       *
       * Была заранее выбрана «Сантехника», и авария с протечкой в щитке
       * уходила сантехнической — со сроком «сутки» вместо двух часов.
       */
      const catErr = document.querySelector('#reqCatErr');
      if (!document.querySelector('#catChips .chip.sel')) {
        if (catErr) {
          catErr.textContent = 'Выберите, что случилось: от этого зависит срок';
          catErr.classList.add('show');
          catErr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        return true;
      }
      catErr?.classList.remove('show');

      /**
       * Обращение принадлежит квартире, и без неё отправлять нечего.
       *
       * Состояние достижимо: у человека с отклонённой заявкой объекта
       * в профиле нет вовсе. Раньше здесь читалось `.propertyId`
       * у пустого значения, исключение перехватывалось общим catch,
       * и человек видел техническое сообщение вместо понятного отказа.
       */
      const propertyId = ctx.state.currentProperty?.propertyId;
      if (!propertyId) {
        toast('Сначала добавьте свой адрес — обращение подаётся по квартире');
        return true;
      }

      await withLoading(target, async () => {
        try {
          const category = document.querySelector('#catChips .chip.sel')?.dataset.v ?? 'Другое';
          const day = document.querySelector('#masterDay')?.value ?? '';
          const windowIndex = document.querySelector('#slotChips .chip.sel')?.dataset.w;
          const slot = masterSlotFrom(day, windowIndex);
          const result = await api.createRequest({
            propertyId,
            kind: target.dataset.kind,
            category,
            description: text,
            slotStart: slot.slotStart,
            slotEnd: slot.slotEnd,
            // Черновик бота MAX гасится, чтобы кнопка не заполнила форму второй раз
            draftId: target.dataset.draft || undefined,
          });
          /**
           * Файлы уходят ПОСЛЕ создания обращения: у вложения должен быть
           * хозяин, а до ответа сервера идентификатора ещё нет.
           *
           * Неудачу отдельного файла не превращаем в неудачу обращения:
           * само обращение уже принято, и терять его из-за не влезшей
           * фотографии нельзя. Про такие файлы честно говорим.
           */
          const picked = document.querySelector('#reqFiles')?.files ?? [];
          const failed = [];
          for (const file of Array.from(picked).slice(0, 5)) {
            try {
              await api.attachFile(result.id, file);
            } catch (error) {
              failed.push(`${file.name}: ${error.message}`);
            }
          }

          platform.haptic('medium');
          platform.guardClosing(false);
          if (failed.length) toast(`Не удалось приложить — ${failed[0]}`);
          /**
           * `houseManagement` — с формы, не из ответа сервера: экран успеха
           * обязан сказать правду о том, кто на самом деле увидит заявку,
           * а не безусловно обещать диспетчера, которого может не быть.
           */
          await ctx.show('request-success', {
            ...result,
            category,
            houseManagement: ctx.state.currentProperty?.houseManagement,
            ukPhone: ctx.state.currentProperty?.ukPhone,
            ukName: ctx.state.currentProperty?.ukName,
          });
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    /**
     * Открыть вложение.
     *
     * Прямой ссылкой в новую вкладку не обойтись: файл отдаётся только
     * с сессией, а внутри мессенджера открытая вкладка её не унесёт.
     * Поэтому качаем запросом и показываем как временный объект браузера.
     */
    case 'open-photo': {
      const thumbs = [...document.querySelectorAll('.page.active .att-thumb[data-url]')];
      openPhotoViewer(thumbs.map((t) => t.dataset.url), Number(target.dataset.i) || 0);
      return true;
    }

    case 'photo-close':
      closePhotoViewer();
      return true;

    /**
     * Открыть документ-вложение (фото открывает open-photo).
     *
     * Прямой ссылкой в новую вкладку не обойтись: файл отдаётся только
     * с сессией, а внутри мессенджера открытая вкладка её не унесёт.
     * Поэтому качаем запросом и открываем как временный объект браузера.
     */
    case 'open-file': {
      await withLoading(target, async () => {
        try {
          const { href } = await fileObjectUrl(target.dataset.url);
          window.open(href, '_blank', 'noopener');
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    case 'pick-reply-files':
    case 'pick-files': {
      // Показываем, что именно выбрано: молчащая кнопка выглядит сломанной
      showPicked(target);
      return true;
    }

    case 'unpick-file': {
      const input = document.querySelector(`#${target.dataset.input}`);
      if (!input) return true;
      const keep = new DataTransfer();
      Array.from(input.files ?? []).forEach((f, i) => {
        if (i !== Number(target.dataset.i)) keep.items.add(f);
      });
      input.files = keep.files;
      showPicked(input);
      return true;
    }

    default:
      return false;
  }
}

/**
 * Вложение как временный объект браузера — один на файл за весь сеанс.
 *
 * Файл отдаётся только с сессией, прямой ссылкой его не открыть. Ссылку
 * на картинку не отзываем: свёрнутое и снова раскрытое превью показывает
 * тот же объект, а отозванный Safari показал бы битой картинкой.
 * Документы открываются в окне — их ссылка живёт пять минут.
 */
const fileUrls = new Map();

async function fileObjectUrl(src) {
  if (fileUrls.has(src)) return fileUrls.get(src);
  const blob = await api.fetchFile(src);
  const href = URL.createObjectURL(blob);
  const image = blob.type.startsWith('image/');
  if (image) fileUrls.set(src, { href, image });
  else setTimeout(() => URL.revokeObjectURL(href), 300000);
  return { href, image };
}

/* ─────────────── фото на весь экран ─────────────── */

/**
 * Просмотр фото вложения поверх всего приложения.
 *
 * Закрыть — крестиком, смахиванием вниз или нативной «Назад» MAX
 * (setBackHook). Соседнее фото — смахиванием вбок. Двигаем только
 * transform и opacity — остальное на слабых телефонах дёргается.
 */
let viewer = null;

export function closePhotoViewer() {
  if (!viewer) return;
  const el = viewer.el;
  viewer = null;
  setBackHook(null);
  el.classList.remove('on');
  setTimeout(() => el.remove(), 220);
}

function openPhotoViewer(urls, index) {
  closePhotoViewer();
  const el = document.createElement('div');
  el.className = 'photo-view';
  el.innerHTML = html`
    <div class="photo-view-bg"></div>
    <img class="photo-view-img" alt="Фото вложения">
    <div class="photo-view-bar">
      <span class="photo-view-n"></span>
      <button class="photo-view-x" data-action="photo-close" aria-label="Закрыть"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>`;
  document.body.append(el);
  viewer = { el, urls, index };
  setBackHook(() => { closePhotoViewer(); return true; });

  const img = el.querySelector('.photo-view-img');
  const bg = el.querySelector('.photo-view-bg');
  const show = async (i) => {
    viewer.index = i;
    el.querySelector('.photo-view-n').textContent = urls.length > 1 ? `${i + 1} из ${urls.length}` : '';
    try {
      const { href } = await fileObjectUrl(urls[i]);
      if (viewer?.el === el && viewer.index === i) img.src = href;
    } catch (error) {
      toast(error.message);
    }
  };
  show(index);
  // Пересчёт вёрстки, а не requestAnimationFrame: в свёрнутом вебвью кадр
  // может не прийти, и просмотр остался бы прозрачным
  void el.offsetHeight;
  el.classList.add('on');

  // Жест: вниз — закрыть, вбок — соседнее фото
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.photo-view-x')) return;
    start = { x: e.clientX, y: e.clientY };
    img.style.transition = 'none';
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dy) > Math.abs(dx)) {
      img.style.transform = `translateY(${Math.max(dy, 0)}px)`;
      bg.style.opacity = String(Math.max(1 - Math.max(dy, 0) / 400, 0.3));
    } else {
      img.style.transform = `translateX(${dx}px)`;
    }
  });
  const end = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    img.style.transition = '';
    img.style.transform = '';
    bg.style.opacity = '';
    if (!viewer) return;
    if (dy > 110 && dy > Math.abs(dx)) return closePhotoViewer();
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) && urls.length > 1) {
      show((viewer.index + (dx < 0 ? 1 : urls.length - 1)) % urls.length);
      return;
    }
    // Касание фона без жеста — закрыть, как у любого просмотрщика
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && e.target === bg) closePhotoViewer();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
