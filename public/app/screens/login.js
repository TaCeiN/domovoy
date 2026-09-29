import { api, ApiError } from '../api.js';
import { platform } from '../platform.js';
import { scanFromFile } from '../qr.js';
import { displayAddress, esc, html, toast, withLoading, errorState } from '../ui.js';
import { APP_NAME, maxAutoLogin } from '../config.js';
import { demoBlockMarkup, mountDemoBlock, takeDemoRole } from './demo.js';
import { receiptFields } from '../receipt-fields.js';

/**
 * Вход по QR квитанции.
 *
 * Это первый экран и главный вау-момент демо: человек наводит камеру
 * на бумажную квитанцию и оказывается внутри — с именем, адресом
 * и лицевым счётом. Ни SMS, ни формы, ни пароля.
 */


/**
 * Единственный путь — фотография квитанции.
 *
 * ПОЧЕМУ ТОЛЬКО ОНА. Сканер мессенджера настроек не имеет вовсе — весь
 * его контракт это `openCodeReader(fileSelect)`, — и на живых устройствах
 * он не читает даже случайный QR с экрана. Вдобавок он отдаёт СТРОКУ,
 * то есть выбирает кодировку за нас и на windows-1251 ошибается.
 *
 * Своя камера через `getUserMedia` требует ОТДЕЛЬНОГО разрешения нашей
 * странице: пожилой человек, увидев внезапный системный запрос, жмёт
 * «Запретить» — и второй раз браузер уже не спросит.
 *
 * Фотография не требует ни того, ни другого: снимок делает системная
 * камера, а к нам приходят БАЙТЫ в полном разрешении, из которых мы
 * сами читаем кодировку по заголовку кода.
 */

export function renderLogin(state) {
  const { config, error, name, addingAddress, attachTo, attachLabel } = state;

  /**
   * В бою вход по квитанции работает только внутри MAX.
   *
   * Говорим это СРАЗУ, а не после сканирования. Иначе человек, открывший
   * сайт в браузере, наводит камеру на квитанцию, ждёт — и только тогда
   * получает отказ. Обещание, которое не выполняется, хуже отсутствующей
   * кнопки: выглядит как поломка приложения.
   */
  if (config && config.webLogin === false && !platform.inMax) {
    return html`
      <div class="page active" id="page-login">
        <div class="onb-hero">
          <div class="onb-logo">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><path d="M4 10.5L12 4L20 10.5V19.5C20 20 19.6 20.5 19 20.5H5C4.4 20.5 4 20 4 19.5V10.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          </div>
          <div class="dt-title" style="margin-top:0">${esc(APP_NAME)}</div>
          <div class="success-p" style="margin:10px auto 0">
            Приложение открывается внутри мессенджера MAX. Там личность
            подтверждает сама платформа — поэтому вход по квитанции
            безопасен и не требует пароля.
          </div>
        </div>

        <div class="dt-card">
          <div class="meter-name">Как войти</div>
          <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
            Найдите в MAX бота
            ${config.botUsername ? html`<b>@${esc(config.botUsername)}</b>` : 'вашего дома'}
            и откройте мини-приложение. Дальше — отсканировать QR-код
            с квитанции ЖКУ, всё остальное приложение сделает само.
          </div>
          ${config.botUsername ? html`
            <a class="btn-primary"
               href="https://max.ru/${esc(config.botUsername)}?startapp"
               target="_blank" rel="noopener">Открыть в MAX</a>` : ''}
        </div>

        ${demoBlockMarkup(config)}

        <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
          Вы из управляющей компании? <a href="./dispatcher/">Кабинет УК</a>
          работает в браузере.
        </div>
      </div>`;
  }




  return html`
    <div class="page active" id="page-login">
      <div class="onb-hero">
        <div class="onb-logo">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><path d="M4 10.5L12 4L20 10.5V19.5C20 20 19.6 20.5 19 20.5H5C4.4 20.5 4 20 4 19.5V10.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
        </div>
        ${addingAddress
          // Заголовок уже стоит в шапке экрана — повторять его незачем
          ? ''
          : html`<div class="dt-title" style="margin-top:0">
              ${name ? `${esc(name)},<br>подтвердите адрес` : esc(APP_NAME)}
            </div>`}
        <div class="success-p" style="margin:10px auto 0" id="loginLead">
          ${attachTo
            /**
             * Три разных сценария за одним экраном, и каждый надо назвать.
             *
             * Здесь квартира уже известна: человек пришёл из неё самой.
             * Адрес спрашивать не будем — и это стоит сказать прямо,
             * потому что раньше форма адреса и была главной мукой.
             */
            ? `Квитанция добавится к квартире ${esc(attachLabel ?? '')}.
               Адрес спрашивать не будем — он уже известен.`
            : addingAddress
              ? `Это новый адрес — сфотографируйте квитанцию по нему. Свет,
                 газ и вывоз мусора для уже добавленной квартиры добавляются
                 внутри неё самой.`
              : `Сфотографируйте квитанцию ЖКУ — приложение прочитает
                 платёжный QR-код и само определит адрес, лицевой счёт
                 и вашу управляющую компанию`}
        </div>
      </div>


      <div id="loginError">${error ? errorState(error) : ''}</div>

      <!--
        Возврат после собственного выхода.

        Внутри MAX приложение обычно входит само, но после нажатия «Выйти»
        автовход выключен — иначе кнопка ничего бы не значила. Значит
        человеку нужен явный путь обратно, и он не должен требовать
        квитанции: личность подтверждает мессенджер, счёт уже привязан.
      -->
      ${platform.inMax && maxAutoLogin.suppressed() ? html`
        <div class="dt-card" style="margin-top:14px">
          <div class="meter-name">Вы вышли из приложения</div>
          <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
            Квитанция снова не нужна: MAX подтвердит, что это вы.
          </div>
          <button class="btn-primary" data-action="max-login">Войти через MAX</button>
        </div>` : ''}

      <div id="scanActions">
        <!--
          Одна кнопка, и это фотография.

          Снимок делает системная камера: отдельного разрешения нашей
          странице не нужно, а к нам приходят БАЙТЫ в полном разрешении —
          кодировку по заголовку кода мы читаем сами. Живой сканер требовал
          бы разрешения на камеру, а сканер мессенджера не настраивается
          вовсе и на win-1251 ошибается.
        -->
        <label class="btn-primary">
          Сфотографировать квитанцию
          <input type="file" accept="image/*" id="qrFile" hidden>
        </label>
      </div>

      ${addingAddress || attachTo ? '' : demoBlockMarkup(config)}

      <div class="field-label" style="margin-top:26px">Где искать QR-код</div>
      <div class="dt-p" style="margin-top:0">
        Платёжный QR печатается на квитанции рядом с суммой к оплате.
        В нём уже есть всё нужное — вводить ничего не придётся.
      </div>

      ${config?.devTools ? `
        <div class="field-label" ${addingAddress ? 'style="margin-top:26px"' : ''}>
          Вставить строку QR вручную
        </div>
        <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin-bottom:10px">
          Для проверки без камеры: строка напечатана в QR квитанции.
        </div>
        <textarea id="qrManual" placeholder="ST00011|Name=...|persAcc=..."></textarea>
        <button class="btn-primary secondary" data-action="manual">
          ${addingAddress ? 'Добавить по строке' : 'Войти по строке'}
        </button>
      ` : ''}
      ${attachTo || !platform.inMax ? '' : `
        <!--
          Код приглашения — на КАЖДОМ входе в MAX, а не только при добавлении
          адреса. Вне MAX поля нет: вход по коду требует личности, которую
          подтверждает мессенджер, и в браузере поле всегда отвечало
          «откройте через MAX» (аудит 26 сентября).

          Приглашённому жильцу фотографировать нечего: квитанция на квартиру
          одна и лежит у собственника, который его и позвал. Без этого поля
          человек с кодом упирается в единственную кнопку «Сфотографировать
          квитанцию» и дальше не проходит вовсе.
        -->
        <div class="field-label" style="margin-top:26px">Код приглашения</div>
        <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin-bottom:10px">
          Если собственник квартиры прислал вам код, квитанция не нужна.
        </div>
        <input type="text" id="inviteCode" placeholder="Например, K7MH9P"
               autocomplete="off" autocapitalize="characters"
               style="letter-spacing:.16em;text-transform:uppercase">
        <div class="field-error" id="inviteErr"></div>
        <button class="btn-primary secondary" data-action="redeem-invite">
          Войти по коду
        </button>
        ${platform.inMax ? html`
          <div class="field-label" style="margin-top:26px">Выбираете, где жить?</div>
          <button class="btn-primary secondary" data-action="pick">
            Подбор дома — отзывы жителей и всё о доме
          </button>` : ''}
      `}
    </div>`;
}

/** Обработчики экрана входа. Возвращает функцию очистки. */
export function bindLogin(root, { onSuccess, rerender, refreshMe, attachTo }) {
  /**
   * Шаг после квитанции — поверх размытого экрана входа.
   *
   * Карточки «расскажите о себе», адрес и «заявка отправлена» рисовались
   * посреди экрана, а под ними оставались «Сфотографировать квитанцию»,
   * «Где искать QR-код» и код приглашения. Человек, у которого квитанция
   * уже принята, читал их как следующий шаг и сканировал заново. Теперь
   * всё, кроме карточки, размыто и не нажимается: путь один — вперёд,
   * в приложение.
   */
  const focusStep = (on) => {
    const box = root.querySelector('#loginError');
    const page = box?.parentElement;
    if (!box || !page) return;
    if (on) page.scrollTop = 0;
    page.classList.toggle('login-focused', on);
    box.classList.toggle('login-step', on);
    for (const el of page.children) {
      if (el !== box) el.inert = on;
    }
    if (on) box.scrollTop = 0;
  };

  const showError = (error) => {
    focusStep(false);
    const box = root.querySelector('#loginError');
    if (box) box.innerHTML = errorState(error);
  };

  /**
   * Отправка отсканированной строки.
   *
   * Квитанцию запоминаем: на занятом лицевом счёте сервер сначала спросит
   * имя, и повторно наводить камеру человеку не придётся.
   */
  let lastQr = null;
  /** Улица, выбранная в подсказке: код нужен серверу, а не текст поля */
  let chosenStreet = null;
  /**
   * Дом, выбранный из списка домов улицы. Пусто — человек либо ещё
   * не выбрал, либо нажал «Моего дома нет в списке» и вводит номер сам.
   */
  let chosenHouse = null;
  /** Ответ «регион не определили»: нужен форме адреса после выбора региона */
  let regionMissingInfo = null;
  /** Заявка, которую сейчас дозаполняет человек */
  let pendingBinding = null;
  /**
   * Заявка на дом из квитанции, когда человек сказал «Адрес не мой».
   * Отзывается перед повторной отправкой той же квитанции с выбранным
   * адресом: иначе председатель чужого дома увидел бы заявку, которой нет.
   */
  let withdrawBeforeResubmit = null;
  /**
   * Нужен ли номер квартиры в форме «расскажите о себе».
   *
   * Приложение уже знает про объект: если у него нет квартиры (свой дом
   * или квитанция без квартиры), спрашивать то же самое второй раз
   * незачем — сервер отдаёт это полем `flat` вместе с заявкой.
   */
  let pendingNeedsFlat = true;

  async function submit(qr, button, extra) {
    if (!qr) return;
    lastQr = qr;

    await withLoading(button, async () => {
      try {
        if (withdrawBeforeResubmit) {
          await api.withdrawClaim(withdrawBeforeResubmit).catch(() => {});
          withdrawBeforeResubmit = null;
        }
        /**
         * Внутри объекта у квитанции другой смысл: не «впустите меня»,
         * а «этот счёт от этой квартиры». Поэтому и маршрут другой —
         * там уже есть сессия и выбранный объект, и адрес не спрашивается.
         */
        const result = attachTo
          ? await api.attachReceipt(attachTo, qr, extra)
          : await api.loginQr(qr, extra);

        /**
         * Квитанция заводит ЗАЯВКУ, а не открывает квартиру.
         *
         * Ответ один и тот же — занят лицевой счёт или свободен. Раньше
         * ответы различались, и по ним перебирались номера счетов
         * и фамилии собственников.
         */
        if (result?.status === 'pending') {
          platform.haptic('medium');
          if (result.claimComplete) await showPending(result);
          else showClaimForm(result);
          return;
        }

        platform.haptic('medium');
        onSuccess(result);
      } catch (error) {
        /**
         * В квитанции нет адреса — спрашиваем его один раз.
         *
         * По ГОСТ Р 56042-2014 адрес плательщика необязателен, и расчётные
         * центры его не печатают. Восстановить дом по одному лицевому счёту
         * невозможно: эта связка есть только в биллинге получателя платежа.
         */
        if (error instanceof ApiError && error.code === 'needs_address') {
          showAddressForm(error.body);
          return;
        }
        if (error instanceof ApiError && error.code === 'region_not_loaded') {
          showRegionMissing(error.body);
          return;
        }
        /** В бою вход по квитанции живёт только внутри MAX */
        if (error instanceof ApiError && error.code === 'web_login_disabled') {
          showWebLoginClosed(error.message);
          return;
        }

        /**
         * Кодировку испортил сканер — повторный скан ИМ ЖЕ даст тот же мусор.
         *
         * Единственный выход — путь, который отдаёт нам байты: фотография.
         * Поэтому здесь не сообщение об ошибке, а кнопка, которая сразу
         * открывает камеру системным выбором файла.
         */
        const reason = error instanceof ApiError ? error.body?.reason : null;
        if (reason === 'mangled' || reason === 'unparsable_address') {
          showPhotoFallback(error.message);
          return;
        }

        showError(error);
      }
    });
  }

  /**
   * Шаг «кто вы».
   *
   * Квитанция выписана на собственника, поэтому по ней собственник
   * и домочадец выглядят одинаково — угадать нельзя, надо спросить.
   * Раньше приложение молча решало само, и ломалось в обе стороны: то
   * владелец не мог добавить свежую квитанцию, то посторонний попадал
   * в чужой кабинет.
   */
  /**
   * Шаг «расскажите о себе».
   *
   * ЗАЧЕМ ОН ЕСТЬ. Доступ открывает председатель совета дома — человек,
   * который знает соседей в лицо. Но узнать он должен КОГО-ТО: в MAX
   * у половины аккаунтов нет фамилии, а у части вместо имени ник.
   * Поэтому ФИО и квартиру житель называет сам, а свободной строкой
   * может объяснить, кто он.
   *
   * Прежней формы «кто вы: жилец или собственник» здесь больше нет.
   * Она спрашивала человека о том, что проверить всё равно нельзя,
   * а ответ «это мой счёт» превращал экран в оракул для перебора ФИО:
   * угаданная фамилия сразу открывала чужой кабинет.
   */
  function showClaimForm(result) {
    const box = root.querySelector('#loginError');
    if (!box) return;

    pendingBinding = result.bindingId;
    /**
     * «Проверьте данные» вместо «Расскажите о себе» (просьба владельца 29.09).
     *
     * ФИО, адрес, квартира и лицевой счёт уже напечатаны в квитанции —
     * переспрашивать их значит заставлять пожилого человека перепечатывать
     * то, что он только что сфотографировал. Показываем прочитанное
     * и даём поправить: вдруг мы где-то ошиблись.
     *
     * Квартира: пустая строка от сервера — у объекта её нет (свой дом),
     * поля не рисуем. Иначе — номер из ответа или из самой квитанции,
     * и его можно исправить: сервер сохранит исправленный (`claimFlat`).
     */
    const fromQr = receiptFields(lastQr);
    pendingNeedsFlat = result.flat !== '';
    const knownFlat = result.flat || fromQr.flat || '';
    const knownName = fromQr.fullName || platform.unsafeName || '';

    focusStep(true);
    box.innerHTML = html`
      <div class="dt-card" style="margin-top:0">
        <div class="meter-name">Проверьте данные</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          Мы прочитали их из квитанции. Если что-то не так — поправьте.
          ${result.hasChairman
            ? 'По этим данным председатель совета поймёт, кто вы, и откроет соседей и ленту дома.'
            : 'Соседей и ленту дома откроет председатель совета, когда он у дома появится.'}
        </div>

        <div class="field-label">Фамилия и имя</div>
        <input type="text" id="claimName" value="${esc(knownName)}" placeholder="Например: Иванова Мария" autocomplete="name">
        ${fromQr.fullName ? html`
          <div class="claim-hint">Квитанция не на вас? Впишите своё имя.</div>` : ''}

        ${fromQr.address ? html`
          <div class="field-label">Адрес</div>
          <div class="claim-ro">${esc(displayAddress(fromQr.address))}</div>
          <button class="link-btn" data-action="wrong-address">Адрес не мой</button>` : ''}

        ${pendingNeedsFlat ? html`
          <div class="field-label">Квартира</div>
          <input type="text" id="claimFlat" value="${esc(knownFlat)}" placeholder="Например: 12" autocomplete="off" inputmode="numeric">
        ` : ''}

        ${fromQr.persAcc ? html`
          <div class="field-label">Лицевой счёт</div>
          <div class="claim-ro">${esc(fromQr.persAcc)}${fromQr.payeeName ? html`<span class="claim-sub">${esc(fromQr.payeeName)}</span>` : ''}</div>` : ''}

        <div class="field-label">Что передать председателю <span class="claim-opt">— необязательно</span></div>
        <textarea id="claimNote" placeholder="Например: живу с 2019 года, квартира на пятом этаже"></textarea>

        <div class="field-error" id="claimErr"></div>

        <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
          Начисления, счётчики и обращение в УК доступны сразу.
          Эти данные видит только тот, кто подтверждает доступ.
        </div>

        <button class="btn-primary" data-action="send-claim">Всё верно — отправить</button>
      </div>`;
    if (!knownName) root.querySelector('#claimName')?.focus();
  }

  /** Вход по квитанции вне мессенджера в бою закрыт — объясняем честно. */
  function showWebLoginClosed(message) {
    const box = root.querySelector('#loginError');
    if (!box) return;

    focusStep(false);
    box.innerHTML = html`
      <div class="dt-card" style="margin-top:0">
        <div class="meter-name">Вход работает внутри MAX</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${esc(message)}
        </div>
      </div>`;
  }

  /**
   * Переход на фотографию квитанции.
   *
   * Нажатие пробрасывается на спрятанный `#qrFile` — тот же обработчик,
   * что и у кнопки «Загрузить фото», и та же проверка байтов. Отдельного
   * пути кода нет специально: два способа получить файл разъехались бы
   * при первой же правке.
   */
  function showPhotoFallback(message, title = 'Код прочитался неразборчиво') {
    const box = root.querySelector('#loginError');
    if (!box) return;

    /**
     * Кнопку в карточке рисуем, только если её ещё нет на экране.
     *
     * Внутри мессенджера «Сфотографировать квитанцию» и так стоит первой,
     * и вторая такая же прямо над ней читалась как сбой вёрстки: два
     * одинаковых синих прямоугольника подряд, и непонятно, чем они
     * отличаются. Здесь достаточно объяснить и показать пальцем.
     */
    focusStep(false);
    box.innerHTML = html`
      <div class="dt-card" style="margin-top:0">
        <div class="meter-name">${esc(title)}</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${esc(message)}
          Нажмите «Сфотографировать квитанцию» ниже — снимок отдаёт байты
          в полном разрешении, и код читается там, где сканер сдаётся.
        </div>
      </div>`;
  }

  /**
   * Выбор адреса из справочника.
   *
   * Улицу человек выбирает из подсказки, а номер дома и квартиры вводит
   * руками. Свободный ввод улицы был бы проще в коде и хуже в жизни: соседи
   * по одному дому написали бы адрес пятью способами, houseKey разошёлся,
   * и лента дома развалилась бы на пять «домов» по одному жильцу.
   */
  function showAddressForm(info) {
    const box = root.querySelector('#loginError');
    if (!box) return;

    focusStep(true);
    box.innerHTML = html`
      <div class="dt-card" style="margin-top:0">
        ${info?.reason === 'wrong' ? html`
          <div class="meter-name">Выберите свой адрес</div>
          <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
            Квитанция останется той же — лицевой счёт ${esc(info?.persAcc ?? '')}.
            Заявка уйдёт на дом, который вы выберете.
          </div>` : html`
          <div class="meter-name">В квитанции нет адреса</div>
          <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
            ${esc(info?.payeeName ?? 'Получатель')} печатает квитанции без адреса —
            там только лицевой счёт ${esc(info?.persAcc ?? '')}. Укажите адрес
            один раз, дальше он подставится сам.
          </div>`}
        <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
          Выберите улицу, затем свой дом из списка и укажите квартиру
        </div>

        <div class="field-label">Улица${info?.regionName ? `, ${esc(info.regionName)}` : ''}</div>
        <input type="text" id="addrStreet" placeholder="Начните вводить название"
               autocomplete="off" data-region="${esc(info?.regionCode ?? '')}">
        <div class="addr-hits" id="addrHits" hidden></div>
        <div class="field-error" id="addrErr"></div>

        <div id="addrHouseBlock" hidden>
          <div class="field-label">Дом</div>
          <div class="chips addr-houses" id="addrHouses"></div>
          <button class="link-btn" data-action="manual-house" id="addrManualBtn">Моего дома нет в списке</button>
        </div>

        <div class="addr-row" id="addrManual" hidden>
          <div>
            <div class="field-label">Дом</div>
            <input type="text" id="addrHouse" placeholder="85 или 15А, 4Б/1" autocomplete="off">
          </div>
          <div>
            <div class="field-label">Корпус</div>
            <input type="text" id="addrBlock" placeholder="—" autocomplete="off">
          </div>
          <div>
            <div class="field-label">Строение</div>
            <input type="text" id="addrBuilding" placeholder="—" autocomplete="off">
          </div>
        </div>

        <div class="field-label">Где вы живёте</div>
        <div class="chips" id="addrKindChips">
          <span class="chip sel" data-action="pick-addr-kind" data-v="flat">В квартире</span>
          <span class="chip" data-action="pick-addr-kind" data-v="private">В своём доме</span>
        </div>

        <div id="addrFlatBlock">
          <div class="field-label">Номер квартиры</div>
          <input type="text" id="addrFlat" placeholder="27" autocomplete="off">
        </div>
        <div class="dt-p" id="addrPrivateNote" style="font-size:13px;color:var(--tx-2);margin-top:8px" hidden>
          Хорошо, у своего дома квартиры не бывает — спрашивать не будем.
        </div>
        <div class="dt-p" id="addrManualHint" style="font-size:13px;color:var(--tx-2);margin-top:8px" hidden>
          Букву и дробь пишите прямо в номере дома: «15А», «4Б/1».
        </div>

        <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
          Управляющая компания увидит, что адрес указали вы, и подтвердит его.
        </div>

        <button class="btn-primary" data-action="submit-address">Продолжить</button>
      </div>`;

    bindStreetSearch();
    root.querySelector('#addrStreet')?.focus();
  }

  /**
   * Регион не подключён — но чаще всего он подключён, просто не тот.
   *
   * Код региона считается по ИНН ПОЛУЧАТЕЛЯ ПЛАТЕЖА, а не по месту
   * жительства: `regionCodeFromInn` берёт первые две цифры ИНН юрлица.
   * Межрегиональный ресурсник, зарегистрированный в другом субъекте,
   * даёт чужой код — и житель Ростовской области читал «справочник
   * адресов ВАШЕГО региона (код 77) пока не загружен» при полностью
   * загруженном регионе 61. Воспроизведено на живом стенде 11 сентября:
   * в том же ответе сервер честно перечислял, что загружена как раз
   * Ростовская область.
   *
   * Прежний экран не предлагал ни одного действия и давал совет,
   * не связанный с причиной, — «попросите управляющую компанию
   * подключиться к сервису». К загрузке справочника ФНС управляющая
   * компания отношения не имеет.
   *
   * Теперь загруженные регионы кликабельны: список уже приезжает
   * в том же ответе полем `available`.
   */
  function showRegionMissing(info) {
    const box = root.querySelector('#loginError');
    if (!box) return;

    const available = info?.available ?? [];
    // Форма адреса покажет их следующим шагом — терять незачем
    regionMissingInfo = info ?? null;

    focusStep(true);
    box.innerHTML = html`
      <div class="dt-card" style="margin-top:0">
        <div class="meter-name">Не удалось определить ваш регион</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${withdrawBeforeResubmit
            ? 'Дом ищем в справочнике региона, который определяем по реквизитам'
            : 'В этой квитанции нет адреса, а регион мы определяем по реквизитам'}
          получателя платежа${info?.payeeName ? html` — «${esc(info.payeeName)}»` : ''}.
          Он зарегистрирован не там, где вы живёте, или его регион
          в сервис пока не загружен.
        </div>
        ${available.length ? html`
          <div class="field-label">Выберите свой регион</div>
          <div class="chips" id="regionChips">
            ${available.map((r) => html`
              <span class="chip" data-action="pick-region"
                    data-code="${esc(r.code)}" data-name="${esc(r.name)}">
                ${esc(r.name)}
              </span>`).join('')}
          </div>
          <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin-top:10px">
            Другие регионы подключаем по мере загрузки справочника адресов.
          </div>`
        : html`
          <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
            Справочник адресов пока не загружен ни по одному региону.
            Отсканируйте квитанцию, в которой адрес напечатан, — тогда
            справочник не понадобится вовсе.
          </div>`}
      </div>`;
  }

  /** Подсказка улиц. Запрос уходит с задержкой: иначе он летит на каждую букву. */
  function bindStreetSearch() {
    const field = root.querySelector('#addrStreet');
    const hits = root.querySelector('#addrHits');
    if (!field || !hits) return;

    let timer = null;

    field.addEventListener('input', () => {
      chosenStreet = null;
      chosenHouse = null;
      const houseBlock = root.querySelector('#addrHouseBlock');
      if (houseBlock) houseBlock.hidden = true;
      clearTimeout(timer);
      const value = field.value.trim();

      if (value.length < 2) {
        hits.hidden = true;
        return;
      }

      timer = setTimeout(async () => {
        try {
          const data = await api.streets(field.dataset.region, value);
          hits.innerHTML = data.streets.length
            ? data.streets.map((s) => html`
                <button class="addr-hit" data-action="pick-street"
                        data-code="${esc(s.code)}" data-label="${esc(s.label)}">
                  ${esc(s.label)}
                </button>`).join('')
            : '<div class="addr-empty">Ничего не найдено</div>';
          hits.hidden = false;
        } catch (error) {
          /**
           * Справочник этого региона не загружен — регион взят по ИНН
           * получателя и мог оказаться чужим. Сервер в том же ответе
           * перечисляет загруженные: даём выбрать свой.
           */
          if (error instanceof ApiError && error.code === 'region_not_loaded') {
            showRegionMissing({ ...error.body, payeeName: regionMissingInfo?.payeeName, persAcc: regionMissingInfo?.persAcc });
            return;
          }
          hits.innerHTML = `<div class="addr-empty">${esc(error.message)}</div>`;
          hits.hidden = false;
        }
      }, 250);
    });
  }

  /** Экран ожидания. Проверка статуса — по кнопке, а не опросом сервера. */
  /**
   * Заявка отправлена — и это ЕДИНСТВЕННОЕ, что остаётся на экране.
   *
   * Кнопки сканирования прячем целиком. Пока они стояли рядом, человек
   * сканировал ту же квитанцию снова и снова, каждый раз получая тот же
   * ответ, — а заодно мог отсканировать чужую и завести вторую заявку,
   * не понимая, что делает. Ждать нечего: приложение его запомнило.
   *
   * Главное действие — сразу перейти в приложение: начисления, счётчики
   * и обращение в УК по квартире работают уже сейчас. Лишней бюрократии
   * и статусов неподключенного дома не показываем — человеку они только
   * мешают.
   */
  async function showPending(result) {
    const box = root.querySelector('#loginError');
    if (!box) return;

    pendingBinding = result.bindingId ?? pendingBinding;

    /**
     * Подробности берём из своего профиля, а не из ответа на квитанцию:
     * там их нет, и передавать их через два экрана значило бы держать
     * копию данных, которые сервер и так отдаёт по одному запросу.
     */
    let claim = null;
    try {
      const me = await api.me();
      claim = (me.myPendingAccess ?? []).find((p) => p.bindingId === pendingBinding) ?? null;
    } catch {
      // Профиль не загрузился — карточку всё равно показываем, без подробностей
    }

    root.querySelector('#scanActions')?.setAttribute('hidden', '');
    root.querySelector('#loginLead')?.setAttribute('hidden', '');

    focusStep(true);
    box.innerHTML = html`
      <div class="dt-card" style="margin-top:0;text-align:center;padding:24px 18px">
        <div class="success-ic" style="margin:0 auto 16px">
          <svg width="30" height="30" viewBox="0 0 28 28" fill="none"><path d="M6 14.5L11 19.5L22 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div style="font-size:22px;font-weight:700;color:var(--tx-strong);letter-spacing:-.02em">
          Квитанция принята
        </div>
        <div class="dt-p" style="font-size:15px;color:var(--tx-2);margin:8px auto 0;line-height:1.45;max-width:320px">
          Квартира привязана. Начисления, показания счётчиков и обращение в УК доступны прямо сейчас.
        </div>

        ${(claim?.addressRaw || claim?.claimName) ? html`
          <div style="background:var(--fade-2);border-radius:var(--r-s);padding:12px 14px;margin-top:18px;text-align:left">
            ${claim?.addressRaw ? html`
              <div style="font-size:14px;font-weight:600;color:var(--tx);line-height:1.35">
                ${esc(displayAddress(claim.addressRaw))}
              </div>` : ''}
            <div style="font-size:13px;color:var(--tx-2);margin-top:4px">
              ${esc(claim?.claimName || '')}${claim?.claimFlat && !claim?.addressRaw?.includes(`кв. ${claim.claimFlat}`) ? html` · кв. ${esc(claim.claimFlat)}` : ''}
            </div>
            ${claim?.claimNote ? html`
              <div style="font-size:12px;color:var(--tx-3);margin-top:4px">
                ${esc(claim.claimNote)}
              </div>` : ''}
          </div>` : ''}

        <button class="btn-primary" data-action="enter-app" style="margin-top:20px">
          Перейти в приложение
        </button>

        <div class="dt-p" style="font-size:13px;color:var(--tx-3);margin-top:12px;line-height:1.4">
          Повторно сканировать квитанцию не нужно — приложение вас запомнило. Лента дома и соседи откроются после подтверждения.
        </div>

        <button class="link-btn" data-action="withdraw-claim" style="margin-top:8px;font-size:13px;color:var(--tx-3)">
          Отозвать заявку
        </button>
      </div>`;
  }

  /**
   * Отзыв — с предупреждением, потому что он необратим.
   *
   * Заявка удаляется из базы вместе с тем, что человек о себе рассказал.
   * Сказать это надо ДО нажатия, а не тостом после.
   */
  function showWithdrawConfirm() {
    const box = root.querySelector('#loginError');
    if (!box) return;

    focusStep(true);
    box.innerHTML = html`
      <div class="dt-card" style="margin-top:0">
        <div class="meter-name">Отозвать заявку?</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          Заявка удалится вместе с тем, что вы о себе рассказали, —
          председатель её больше не увидит. Отсканировать квитанцию заново
          можно в любой момент.
        </div>
        <button class="btn-primary" data-action="withdraw-confirm">
          Да, отозвать
        </button>
        <button class="btn-primary secondary" data-action="withdraw-cancel">
          Оставить заявку
        </button>
      </div>`;
  }





  const onClick = async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    // Демо-дом: вошёл персонажем — дальше обычный запуск приложения
    if (action === 'demo-take') {
      await takeDemoRole(target, () => onSuccess({ status: 'ok' }));
      return;
    }


    if (action === 'manual') {
      const value = root.querySelector('#qrManual')?.value.trim();
      if (!value) return toast('Вставьте строку QR');
      await submit(value, target, { source: 'manual' });
    }
    /**
     * Человек назвал свой регион сам — дальше обычная форма адреса.
     *
     * Это не «режим» и не выбор в настройках, а ответ на один вопрос
     * анкеты: тот же приём, что «В квартире / В своём доме» ниже.
     */
    if (action === 'pick-region') {
      showAddressForm({
        regionCode: target.dataset.code,
        regionName: target.dataset.name,
        payeeName: regionMissingInfo?.payeeName ?? null,
        persAcc: regionMissingInfo?.persAcc ?? null,
        // Пришли из «Адрес не мой» — та же форма с тем же заголовком
        reason: withdrawBeforeResubmit ? 'wrong' : undefined,
      });
      return;
    }

    if (action === 'pick-street') {
      chosenStreet = { code: target.dataset.code, label: target.dataset.label };
      chosenHouse = null;
      const field = root.querySelector('#addrStreet');
      if (field) field.value = target.dataset.label;
      const hits = root.querySelector('#addrHits');
      if (hits) hits.hidden = true;

      /**
       * Дома улицы — списком. Номер, набранный руками, разводил один дом
       * надвое: «85/3» у одного соседа и «85 к3» у другого. Выбранный
       * из списка дом даёт ровно тот ключ, что у соседей с квитанцией.
       */
      const houseBlock = root.querySelector('#addrHouseBlock');
      const list = root.querySelector('#addrHouses');
      const manual = root.querySelector('#addrManual');
      let houses = [];
      try {
        houses = (await api.houses(chosenStreet.code)).houses;
      } catch {
        // Список не пришёл — номер можно ввести руками, как раньше
      }

      if (houses.length === 0) {
        if (houseBlock) houseBlock.hidden = true;
        if (manual) manual.hidden = false;
      const manualHint = root.querySelector('#addrManualHint');
      if (manualHint) manualHint.hidden = false;
        root.querySelector('#addrHouse')?.focus();
        return;
      }

      if (list) {
        list.innerHTML = houses.map((h) => html`
          <span class="chip" data-action="pick-house" data-key="${esc(h.houseKey)}">${esc(h.number)}</span>`).join('');
      }
      if (manual) manual.hidden = true;
      const manualHint = root.querySelector('#addrManualHint');
      if (manualHint) manualHint.hidden = true;
      const manualBtn = root.querySelector('#addrManualBtn');
      if (manualBtn) manualBtn.hidden = false;
      if (houseBlock) houseBlock.hidden = false;
      return;
    }

    if (action === 'pick-house') {
      chosenHouse = target.dataset.key;
      root.querySelectorAll('#addrHouses .chip').forEach((c) => c.classList.remove('sel'));
      target.classList.add('sel');
      return;
    }

    /** Новостройки ещё нет в ГАР — номер вводится руками, как раньше */
    if (action === 'manual-house') {
      chosenHouse = null;
      root.querySelectorAll('#addrHouses .chip').forEach((c) => c.classList.remove('sel'));
      const manual = root.querySelector('#addrManual');
      if (manual) manual.hidden = false;
      const manualHint = root.querySelector('#addrManualHint');
      if (manualHint) manualHint.hidden = false;
      target.hidden = true;
      root.querySelector('#addrHouse')?.focus();
      return;
    }

    /**
     * Выбор «квартира» / «свой дом».
     *
     * Своего переключателя режимов в приложении нет и не будет — это просто
     * ответ на один вопрос анкеты, тот же приём, что и выбор категории
     * обращения (см. requests.js, .chips/.chip.sel). Выбрал «свой дом» —
     * поле номера квартиры прячется и не участвует в отправке: спрашивать
     * то, чего у дома не бывает, незачем.
     */
    if (action === 'pick-addr-kind') {
      root.querySelectorAll('#addrKindChips .chip').forEach((c) => c.classList.remove('sel'));
      target.classList.add('sel');

      const isPrivate = target.dataset.v === 'private';
      const flatBlock = root.querySelector('#addrFlatBlock');
      const note = root.querySelector('#addrPrivateNote');
      if (flatBlock) flatBlock.hidden = isPrivate;
      if (note) note.hidden = !isPrivate;
      if (isPrivate) {
        const flatInput = root.querySelector('#addrFlat');
        if (flatInput) flatInput.value = '';
      }
      return;
    }

    if (action === 'submit-address') {
      const errorBox = root.querySelector('#addrErr');
      const house = root.querySelector('#addrHouse')?.value.trim() ?? '';
      const isPrivate = root.querySelector('#addrKindChips .chip.sel')?.dataset.v === 'private';
      const flat = isPrivate ? '' : (root.querySelector('#addrFlat')?.value.trim() ?? '');

      const complain = (text) => {
        if (errorBox) {
          errorBox.textContent = text;
          errorBox.classList.add('show');
        }
      };

      if (!chosenStreet) return complain('Выберите улицу из подсказки');
      const manualOpen = root.querySelector('#addrManual')?.hidden === false;
      if (!chosenHouse && !manualOpen) return complain('Выберите дом из списка');
      if (!chosenHouse && !house) return complain('Укажите номер дома');
      // Квартиру не требуем: у своего дома её нет
      errorBox?.classList.remove('show');

      await submit(lastQr, target, {
        address: chosenHouse
          ? { houseKey: chosenHouse, flat: flat || undefined }
          : {
              streetCode: chosenStreet.code,
              house,
              block: root.querySelector('#addrBlock')?.value.trim() || undefined,
              building: root.querySelector('#addrBuilding')?.value.trim() || undefined,
              flat: flat || undefined,
            },
        declaredPrivate: isPrivate,
      });
      return;
    }

    /**
     * Адрес из квитанции не тот — выбрать свой дом из ГАР.
     *
     * Заявка на дом из квитанции уже заведена: её отзовём перед повторной
     * отправкой той же квитанции с выбранным адресом (явный адрес сильнее
     * напечатанного — lib/auth/bind.ts, `input.addressRaw || receipt.payer.address`).
     * Регион — по ИНН получателя, как его считает сервер.
     */
    if (action === 'wrong-address') {
      const fromQr = receiptFields(lastQr);
      withdrawBeforeResubmit = pendingBinding;
      regionMissingInfo = { payeeName: fromQr.payeeName, persAcc: fromQr.persAcc };
      showAddressForm({
        regionCode: fromQr.regionCode ?? '',
        regionName: null,
        payeeName: fromQr.payeeName,
        persAcc: fromQr.persAcc,
        reason: 'wrong',
      });
      return;
    }

    if (action === 'send-claim') {
      const name = root.querySelector('#claimName')?.value.trim() ?? '';
      const flat = root.querySelector('#claimFlat')?.value.trim() ?? '';
      const note = root.querySelector('#claimNote')?.value.trim() ?? '';
      const error = root.querySelector('#claimErr');

      const complain = (text) => {
        if (error) {
          error.textContent = text;
          error.classList.add('show');
        }
      };

      if (name.length < 3) return complain('Укажите фамилию и имя');
      if (pendingNeedsFlat && !flat) return complain('Укажите номер квартиры');
      error?.classList.remove('show');

      await withLoading(target, async () => {
        try {
          await api.sendClaim(pendingBinding, { name, flat, note });
          platform.haptic('medium');
          /**
           * Состояние приложения обновляем ЗДЕСЬ, не уходя с экрана.
           *
           * Объект уже появился на сервере, и без этого профиль показывал
           * старый список до следующей перезагрузки: человек добавлял
           * вторую квартиру и не находил её.
           */
          await refreshMe?.();
          await showPending({ bindingId: pendingBinding });
        } catch (e) {
          complain(e.message);
        }
      });
      return;
    }

    if (action === 'enter-app') {
      /**
       * Выход в приложение прямо отсюда.
       *
       * Раньше после отправки заявки в интерфейс попадали только
       * перезапуском мини-аппа: экран заявки был тупиком, хотя уровень 0
       * по этой квартире уже открыт.
       */
      onSuccess({ status: 'pending' });
      return;
    }

    if (action === 'withdraw-claim') {
      showWithdrawConfirm();
      return;
    }

    if (action === 'withdraw-cancel') {
      await showPending({ bindingId: pendingBinding });
      return;
    }

    if (action === 'withdraw-confirm') {
      /**
       * Отзыв удаляет заявку на сервере, а не прячет её на экране.
       * После этого экран возвращается к сканированию: заявки больше нет,
       * и предлагать «проверить доступ» стало бы неправдой.
       */
      await withLoading(target, async () => {
        try {
          await api.withdrawClaim(pendingBinding);
          pendingBinding = null;
          platform.haptic('medium');
          await refreshMe?.();
          toast('Заявка отозвана');
          if (rerender) await rerender();
          else {
            root.querySelector('#scanActions')?.removeAttribute('hidden');
            root.querySelector('#loginLead')?.removeAttribute('hidden');
            focusStep(false);
            const box = root.querySelector('#loginError');
            if (box) box.innerHTML = '';
          }
        } catch (e) {
          toast(e.message);
        }
      });
      return;
    }

  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const value = await scanFromFile(file);
      await submit(value, null, { source: 'photo' });
    } catch (error) {
      /**
       * «Не удалось загрузить» здесь неправда: снимок загрузился, кода
       * на нём не нашлось. Человеку нужен совет, что сделать со снимком,
       * а не сообщение о сбое.
       */
      showPhotoFallback(error.message, 'Код на фото не нашёлся');
    } finally {
      event.target.value = '';
    }
  };

  root.addEventListener('click', onClick);
  mountDemoBlock(root);
  root.querySelector('#qrFile')?.addEventListener('change', onFile);

  /** «Подключить дом» нажали на карточке заявки — показать её уже с поданной просьбой */
  const onHouseClaimed = () => {
    if (pendingBinding) showPending({ bindingId: pendingBinding });
  };
  document.addEventListener('house-claimed', onHouseClaimed);

  return () => {
    root.removeEventListener('click', onClick);
    document.removeEventListener('house-claimed', onHouseClaimed);
  };
}

/**
 * Вход внутри MAX: если человек уже привязал счёт, квитанция не нужна.
 * Возвращает 'ok' | 'needs_receipt' | null.
 */
export async function tryMaxLogin() {
  if (!platform.inMax) return null;
  try {
    const result = await api.loginMax();
    return result?.status ?? null;
  } catch {
    return null;
  }
}
