import { esc, html, toast, openSheet, closeSheet, withLoading } from './ui.js';
import { api } from './api.js';
import { API_BASE } from './config.js';
import { platform } from './platform.js';
import { POPULAR_BANKS, OTHER_BANKS } from './banks.js';

/**
 * Оплата квитанции: переход в приложение банка.
 *
 * ЭТО ЗАГЛУШКА MVP, и она честная ровно настолько, насколько можно.
 * Настоящую ссылку СБП на сумму квитанции выпускает только банк получателя,
 * а договоров у сервиса нет (спека 2026-09-17-pay-bank-redirect). Поэтому:
 *
 *   «Оплатить» → шторка с суммой и QR квитанции → «Сохранить и открыть банк»
 *   → QR уходит в галерею → «через 3 секунды откроем выбор банка»
 *   → выбор банка → приложение банка → житель платит «по QR из галереи»
 *   → возвращается в MAX → «Оплата прошла?» → отметка об оплате.
 *
 * Приложение по-прежнему НЕ ЗНАЕТ, прошёл ли платёж: «Да, оплатил» — это
 * отметка жителя, и везде она так и называется — «по вашим отметкам».
 */

const PENDING_KEY = 'domovoy-pay-pending';
const COUNTDOWN_SECONDS = 3;
/** Возврат раньше этого — не возврат из банка, а мигание экрана при переходе */
const ASK_AFTER_MS = 1500;
/** Через час спрашивать «Оплата прошла?» уже странно */
const FORGET_AFTER_MS = 60 * 60 * 1000;
/** Страница всё ещё на экране через столько — приложение банка не открылось */
const NOT_OPENED_MS = 2500;

/** Текущая оплата: квитанция и ссылка на её QR */
let flow = null;
let countdownTimer = null;

const pending = {
  read() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null'); } catch { return null; }
  },
  write(value) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(value)); } catch { /* приватный режим */ }
  },
  clear() {
    try { localStorage.removeItem(PENDING_KEY); } catch { /* приватный режим */ }
  },
};

/** Квитанция из ответа /bills или из data-атрибутов кнопки — к одному виду */
function billFrom(source) {
  return {
    id: source.id,
    sum: source.sum,
    sumKopecks: Number(source.sumKopecks ?? 0),
    provider: source.provider ?? '',
    serviceLabel: source.serviceLabel ?? 'Квитанция',
    periodLabel: source.periodLabel ?? '',
    hasQr: source.hasQr === true || source.hasQr === 'true',
  };
}

/* ─────────────── шаги ─────────────── */

async function startPayment(bill) {
  flow = { bill, qr: null };

  if (bill.hasQr) {
    try {
      flow.qr = await api.post(`/api/bills/${encodeURIComponent(bill.id)}/pay-qr`, {});
    } catch {
      // QR не выдали — оплата всё равно ведёт в банк, просто без картинки
      flow.qr = null;
    }
  }

  const qrUrl = flow.qr ? absoluteUrl(flow.qr.url) : null;

  openSheet(html`
    <div class="pay-sheet">
      <div class="pay-sheet-kind">${esc(bill.serviceLabel)}${bill.periodLabel ? ` · ${esc(bill.periodLabel)}` : ''}</div>
      <div class="pay-sheet-sum">${esc(bill.sum)}</div>
      <div class="pay-sheet-to">${esc(bill.provider)}</div>

      ${qrUrl ? html`
        <img class="pay-qr" src="${esc(qrUrl)}" alt="QR-код квитанции" width="200" height="200">
        <ol class="pay-steps">
          <li>Сохраним этот QR в галерею телефона</li>
          <li>Откроем приложение банка</li>
          <li>В банке: <b>Оплата по QR</b> → <b>Загрузить из галереи</b></li>
        </ol>
        <button class="btn-primary" data-action="pay-save-open">Сохранить и открыть банк</button>` : html`
        <div class="pay-steps-note">
          QR этой квитанции у нас нет — в банке найдите получателя
          по реквизитам с бумажной квитанции.
        </div>
        <button class="btn-primary" data-action="pay-open">Открыть банк</button>`}
    </div>`, 'Оплата квитанции');
}

async function saveQr() {
  if (!flow?.qr) return false;
  const saved = await platform.downloadFile(absoluteUrl(flow.qr.url), flow.qr.fileName);
  toast(saved
    ? 'QR сохранён — в банке выберите «Оплата по QR» → «Из галереи»'
    : 'Не удалось сохранить QR — сделайте снимок экрана');
  return saved;
}

function startCountdown() {
  if (!flow) return;
  let left = COUNTDOWN_SECONDS;

  openSheet(html`
    <div class="pay-sheet">
      <div class="pay-count" aria-live="polite"><b id="payCount">${left}</b></div>
      <div class="pay-sheet-title">Переходим в банк</div>
      <div class="pay-steps-note">Через ${COUNTDOWN_SECONDS} секунды откроем выбор банка для оплаты ${esc(flow.bill.sum)}</div>
      <button class="btn-primary" data-action="pay-now">Выбрать сейчас</button>
    </div>`, 'Переход в банк');

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const counter = document.querySelector('#payCount');
    // Шторку закрыли — отсчёт больше никому не нужен
    if (!counter) { clearInterval(countdownTimer); return; }
    left -= 1;
    if (left > 0) {
      counter.textContent = String(left);
      return;
    }
    clearInterval(countdownTimer);
    showBanks();
  }, 1000);
}

function bankButton(bank, popular) {
  const letter = esc(bank.name.replace(/[^A-Za-zА-Яа-яЁё]/g, '').charAt(0).toUpperCase() || '₽');
  return html`
    <button class="${popular ? 'pay-bank-tile' : 'pay-bank-row'}" data-action="pay-bank"
            data-schema="${esc(bank.schema)}" data-name="${esc(bank.name)}"
            data-search="${esc(bank.name.toLowerCase())}">
      <!-- Буква лежит под логотипом: не загрузился логотип — видна буква, а не пустой квадрат -->
      <span class="pay-bank-logo">${letter}${bank.logo
        ? html`<img src="${esc(bank.logo)}" alt="" loading="lazy" decoding="async">` : ''}</span>
      <span class="pay-bank-name">${esc(bank.name)}</span>
    </button>`;
}

function showBanks() {
  clearInterval(countdownTimer);
  if (!flow) return;

  openSheet(html`
    <div class="pay-sheet">
      <div class="pay-sheet-title">Выберите банк</div>
      <div class="pay-steps-note">Оплата ${esc(flow.bill.sum)} · ${esc(flow.bill.provider)}</div>
      <div class="pay-bank-grid">${POPULAR_BANKS.map((b) => bankButton(b, true)).join('')}</div>
      <input type="search" id="payBankQuery" class="pay-bank-search" placeholder="Найти банк" aria-label="Найти банк">
      <div class="pay-bank-list" id="payBankList">${OTHER_BANKS.map((b) => bankButton(b, false)).join('')}</div>
    </div>`, 'Выбор банка');

  /**
   * Логотип банка у НСПК может пропасть: 17.09.2026 у одного из 196 вместо
   * картинки была страница 404, и браузер её заблокировал. Картинку, которая
   * не загрузилась, убираем — под ней буква. Событие error не всплывает,
   * поэтому слушаем на каждой картинке.
   */
  for (const img of document.querySelectorAll('#appSheet .pay-bank-logo img')) {
    img.addEventListener('error', () => img.remove(), { once: true });
  }

  const query = document.querySelector('#payBankQuery');
  query?.addEventListener('input', () => {
    const needle = query.value.trim().toLowerCase();
    for (const row of document.querySelectorAll('#appSheet [data-action="pay-bank"]')) {
      row.hidden = Boolean(needle) && !row.dataset.search.includes(needle);
    }
  });
}

function openBank(target) {
  if (!flow) return;
  const { schema, name } = target.dataset;

  pending.write({
    billId: flow.bill.id,
    sum: flow.bill.sum,
    bank: name,
    at: Date.now(),
  });
  closeSheet();

  /**
   * Схема банка с адресом НСПК — так ссылки открывает сама НСПК.
   * Номера платежа у нас нет, поэтому приложение банка откроется без
   * реквизитов: дальше «Оплата по QR → из галереи».
   */
  platform.openLink(`${schema}://qr.nspk.ru/`);

  setTimeout(() => {
    if (document.visibilityState === 'visible' && pending.read()?.bank === name) {
      toast(`Приложение «${name}» не открылось — проверьте, что оно установлено`);
    }
  }, NOT_OPENED_MS);
}

/* ─────────────── возврат из банка ─────────────── */

function askIfPaid() {
  const current = pending.read();
  if (!current || document.visibilityState !== 'visible') return;

  const age = Date.now() - current.at;
  if (age < ASK_AFTER_MS) return;
  if (age > FORGET_AFTER_MS) { pending.clear(); return; }
  if (document.querySelector('#appSheet [data-action="pay-yes"]')) return;

  openSheet(html`
    <div class="pay-sheet">
      <div class="pay-sheet-title">Оплата прошла?</div>
      <div class="pay-steps-note">
        Вы переходили в «${esc(current.bank)}», чтобы оплатить ${esc(current.sum)}.
        Если платёж прошёл — отметим квитанцию оплаченной. Это ваша отметка:
        банк нам о платеже не сообщает.
      </div>
      <button class="btn-primary" data-action="pay-yes">Да, оплатил</button>
      <button class="btn-primary secondary" data-action="pay-no">Нет, позже</button>
    </div>`, 'Оплата прошла?', {
    // «Закрыть» повторяла бы «Нет, позже»
    closeButton: false,
    /**
     * Закрыл мимо кнопок — значит ответ «не сейчас». Раньше отметка об уходе
     * в банк оставалась, и вопрос всплывал при каждом открытии мини-аппа
     * в течение часа.
     */
    onDismiss: () => pending.clear(),
  });
}

/**
 * Слушать возврат в мини-апп. Вызывается один раз при запуске: вернувшись
 * из банка, человек попадает в тот же экран, а если MAX перезапустил
 * мини-апп — вопрос задаётся при первом показе.
 */
export function initPayReturn() {
  document.addEventListener('visibilitychange', askIfPaid);
  window.addEventListener('pageshow', askIfPaid);
  setTimeout(askIfPaid, 800);
}

/* ─────────────── действия ─────────────── */

function absoluteUrl(path) {
  return new URL(API_BASE + path, window.location.href).href;
}

/** true — действие обработано оплатой */
export async function handlePayAction(action, target, ctx) {
  switch (action) {
    /** «Оплатить» на главной: одна неоплаченная квитанция — сразу к ней */
    case 'pay': {
      const property = ctx.state.currentProperty;
      if (!property) return true;
      await withLoading(target, async () => {
        try {
          const data = await api.bills(property.propertyId);
          const unpaid = data.bills.filter((b) => b.status !== 'paid');
          if (unpaid.length === 1) await startPayment(billFrom(unpaid[0]));
          else ctx.go('payment');
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    /** «Оплатить» у конкретной квитанции в истории начислений */
    case 'pay-bill':
      await withLoading(target, () => startPayment(billFrom(target.dataset)));
      return true;

    case 'pay-save-open':
      await withLoading(target, saveQr);
      startCountdown();
      return true;

    case 'pay-open':
      startCountdown();
      return true;

    case 'pay-now':
      showBanks();
      return true;

    case 'pay-bank':
      openBank(target);
      return true;

    case 'pay-yes': {
      const current = pending.read();
      await withLoading(target, async () => {
        try {
          if (current?.billId) await api.markPaid(current.billId, true);
          pending.clear();
          closeSheet();
          platform.haptic('medium');
          toast('Отметили: оплачено по вашим отметкам');
          await ctx.refreshMe();
          await ctx.refresh();
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    case 'pay-no':
      pending.clear();
      closeSheet();
      return true;

    default:
      return false;
  }
}
