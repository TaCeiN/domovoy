/**
 * Адаптер платформы: одно приложение работает и внутри MAX, и как обычный сайт.
 *
 * Различия спрятаны здесь целиком. Экраны не должны знать, где они запущены —
 * иначе проверки «а мы в MAX?» расползутся по всему коду, и поддерживать
 * два режима станет невозможно.
 */

const bridge = () => (typeof window !== 'undefined' ? window.WebApp : undefined);

/** Сколько ждать ответа MAX на просьбу поделиться номером */
const CONTACT_TIMEOUT_MS = 20_000;

/**
 * Вызов моста, результат которого не нужен.
 *
 * Методы моста возвращают промис, а вне MAX он отклоняется («транспорт
 * недоступен»). `try/catch` вокруг вызова асинхронный отказ не ловит:
 * в консоли копились «Uncaught (in promise)» на каждый тактильный отклик
 * (аудит 26 сентября). Глушим именно отказ, не сам вызов.
 */
function quiet(result) {
  if (result && typeof result.then === 'function') result.then(undefined, () => {});
}

export const platform = {
  /** Внутри MAX доступен глобальный WebApp из max-web-app.js */
  get inMax() {
    return Boolean(bridge()?.initData);
  },

  get name() {
    return bridge()?.platform ?? 'web';
  },

  /**
   * iPhone. Нужен не ради красоты — на нём другой порядок способов сканирования.
   *
   * MAX убран из App Store 3 июня 2026, и на айфоне мессенджер живёт
   * веб-версией, добавленной на домашний экран. Мини-приложение там —
   * это iframe с чужого origin, а `getUserMedia` в таком iframe работает
   * только если родитель выставил `allow="camera"`, чего мы не контролируем.
   * Зато `<input type="file" capture>` — системный выбор файла, ему
   * разрешения фрейма не нужны, и он отдаёт нам БАЙТЫ.
   *
   * `WebApp.platform` здесь не помощник: в веб-клиенте он вернёт `web`
   * и на айфоне, и на десктопе.
   */
  get isIos() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent ?? '';
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    // iPadOS 13+ притворяется десктопным Safari, выдаёт его только тачскрин
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  },

  /**
   * Строка вида «ios 2026.14.3 iPhone 16» — для логов сервера, не для логики.
   *
   * Вне MAX возвращает null: скрипт платформы подключён на каждой странице
   * и объявляет `window.WebApp` даже в обычном браузере, поэтому проверять
   * надо не наличие моста, а подписанные initData.
   */
  get clientTag() {
    const b = bridge();
    if (!b?.initData) return null;
    return [b.platform, b.version, b.deviceName].filter(Boolean).join(' ') || null;
  },

  /**
   * Подписанные стартовые параметры.
   *
   * MAX кладёт их во фрагмент URL, а фрагмент браузер на сервер не отправляет —
   * поэтому клиент обязан передать строку явно заголовком. Это самая частая
   * ошибка первой интеграции.
   */
  get initData() {
    return bridge()?.initData ?? null;
  },

  /** Payload диплинка: max.ru/<bot>?startapp=<payload> */
  /**
   * Параметр запуска: в MAX — `start_param` мессенджера, в браузере —
   * `?startapp=` в адресе. Тот же формат, чтобы ссылка «Поделиться»
   * открывала то же место, откуда бы её ни открыли (29.09).
   */
  get startParam() {
    return bridge()?.initDataUnsafe?.start_param
      ?? new URLSearchParams(location.search).get('startapp')
      ?? null;
  },

  /**
   * Имя для приветствия до ответа сервера.
   * Только для отрисовки: доверять этим данным нельзя, подпись проверяет бэкенд.
   */
  get unsafeName() {
    const u = bridge()?.initDataUnsafe?.user;
    if (!u) return null;
    return [u.last_name, u.first_name].filter(Boolean).join(' ') || u.first_name;
  },

  /**
   * Нативная кнопка «Назад» в шапке MAX вместо нашей истории браузера.
   *
   * ОДИН обработчик на всё приложение. Раньше `show()` подписывал новый
   * при каждом переходе, а отписки не было вовсе: после пяти переходов
   * вглубь одно нажатие «Назад» вызывало возврат пять раз и выбрасывало
   * человека в корень. Теперь подписка ставится ровно один раз, а меняется
   * только то, куда она ведёт.
   */
  backButton: {
    _bound: false,
    _handler: null,

    show(handler) {
      const b = bridge()?.BackButton;
      if (!b) return false;

      this._handler = handler;
      if (!this._bound) {
        b.onClick(() => this._handler?.());
        this._bound = true;
      }
      b.show();
      return true;
    },

    hide() {
      this._handler = null;
      bridge()?.BackButton?.hide();
    },
  },

  /** Тактильный отклик. На десктопе и в вебе метода нет — молча пропускаем. */
  haptic(style = 'light') {
    try {
      quiet(bridge()?.HapticFeedback?.impactOccurred(style));
    } catch { /* не критично */ }
  },

  /** Не терять заполненную форму при случайном закрытии. */
  guardClosing(on) {
    try {
      const b = bridge();
      quiet(on ? b?.enableClosingConfirmation?.() : b?.disableClosingConfirmation?.());
    } catch { /* не критично */ }
  },

  /**
   * Забрать вертикальный свайп себе.
   *
   * ПОЛНОЭКРАННОГО РЕЖИМА В MAX НЕТ. У Telegram с версии 8.0 есть
   * `requestFullscreen`, у моста MAX — нет: полный список событий
   * (`WebAppOpenCodeReader`, `WebAppGetViewportSize`, `WebAppShare`
   * и прочие) такого метода не содержит, и высоту окна задаёт сам
   * мессенджер.
   *
   * Ближайшее, что даёт мост, — отключить вертикальные свайпы. Без этого
   * тяга пальцем вверх по длинному списку сворачивает мини-апп вместо
   * прокрутки, и человек теряет экран посреди дела.
   */
  lockVerticalSwipes() {
    try {
      quiet(bridge()?.disableVerticalSwipes?.());
    } catch { /* не критично: на десктопе и в вебе метода нет */ }
  },

  /** Поделиться кодом приглашения контакту в MAX. */
  async share(text) {
    const b = bridge();
    /**
     * Только внутри MAX. Скрипт моста подключён и в браузере, `shareContent`
     * там есть, но вне мессенджера молча ничего не делает — кнопка
     * «Поделиться» выглядела сломанной (нашлось 29.09 на карточке ЖК).
     */
    if (this.inMax && b?.shareContent) {
      await b.shareContent({ text });
      return true;
    }
    if (navigator.share) {
      await navigator.share({ text });
      return true;
    }
    await navigator.clipboard?.writeText(text);
    return false;
  },

  /**
   * Телефон, подтверждённый аккаунтом MAX, — второй фактор.
   * Подписанные данные проверяет сервер.
   *
   * Возвращает `{ contact }` или `{ reason }`, чтобы экран сказал человеку,
   * что именно случилось:
   * - `unavailable` — не в MAX или мост не умеет просить номер;
   * - `declined` — MAX ответил ошибкой или человек отказался;
   * - `timeout` — MAX не ответил вовсе.
   */
  async requestContact() {
    const b = bridge();
    /**
     * Только внутри MAX. Скрипт платформы объявляет `WebApp.requestContact`
     * и в обычном браузере, но там вызову некуда уйти («транспорт
     * недоступен»), и обещание не завершается НИКОГДА: переключатель
     * «Показать мой телефон» ждал ответа вечно и не щёлкал, без подсказки.
     * Та же проверка, что у downloadFile.
     */
    if (!this.inMax || !b?.requestContact) return { reason: 'unavailable' };

    /**
     * И внутри MAX ответа может не быть: веб-версия мессенджера (на айфоне
     * MAX живёт только ею) не обязана уметь просить номер. Не ждём вечно:
     * 20 секунд хватает, чтобы прочитать окно и нажать «Поделиться».
     */
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ reason: 'timeout' }), CONTACT_TIMEOUT_MS);
    });
    const ask = (async () => {
      try {
        const result = await b.requestContact();
        return result && !result.error ? { contact: result } : { reason: 'declined' };
      } catch {
        return { reason: 'declined' };
      }
    })();
    try {
      return await Promise.race([ask, timeout]);
    } finally {
      clearTimeout(timer);
    }
  },


  /**
   * Открыть ссылку системой телефона, а не внутри мини-приложения.
   *
   * Нужна для перехода в приложение банка по схеме `bank100000000111://`:
   * вебвью мессенджера такие ссылки открывать не обязан, а мост MAX
   * отдаёт адрес самому телефону. Вне MAX — обычный переход.
   */
  openLink(url) {
    const b = bridge();
    if (this.inMax && b?.openLink) {
      try {
        b.openLink(url);
        return;
      } catch { /* ниже — обычный переход */ }
    }
    window.location.href = url;
  },

  /**
   * Открыть ссылку внутри MAX: профиль по нику, «Отправить в MAX».
   * Мост открывает в мессенджере только адреса `https://max.ru/…`,
   * остальные — во внешнем браузере. Вне MAX — новая вкладка.
   */
  openMaxLink(url) {
    const b = bridge();
    if (this.inMax && b?.openMaxLink) {
      try {
        b.openMaxLink(url);
        return;
      } catch { /* ниже — обычный переход */ }
    }
    window.open(url, '_blank', 'noopener');
  },

  /**
   * Сохранить файл на телефон.
   *
   * В MAX — нативное скачивание по ссылке: картинку из памяти страницы мост
   * не принимает, поэтому `url` — адрес, который открывается без сессии.
   * В браузере — скачивание через ссылку с атрибутом download.
   * Возвращает true, если сохранение запущено.
   */
  async downloadFile(url, fileName) {
    const b = bridge();
    if (this.inMax && b?.downloadFile) {
      try {
        await b.downloadFile(url, fileName);
        return true;
      } catch { /* ниже — браузерный путь */ }
    }
    try {
      const blob = await (await fetch(url)).blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      return true;
    } catch {
      return false;
    }
  },

  /** Реальная высота вьюпорта внутри вебвью. */
  async viewportHeight() {
    try {
      const size = await bridge()?.getViewportSize?.();
      return size?.height ? parseInt(size.height, 10) : null;
    } catch {
      return null;
    }
  },
};
