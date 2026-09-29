import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  uk, property, account, appUser, userProperty, bill, house, managingOrg, chairman,
} from '../../db/schema.ts';
import { parseReceipt, type Receipt } from '../qr/receipt.ts';
import { parseAddress, houseKeyCandidates, looseHouseKey } from '../address/normalize.ts';
import { pickHouse, addressWithFlat } from '../address/pick-house.ts';
import { newId, humanCode } from '../ids.ts';
import { canOwnPrivateHouse } from './private-house.ts';
import { markMultiFlat, setHouseFormUnlessOperator, effectiveHouse, houseLayerColumns } from '../house/form.ts';
import type { Database } from '../../db/client.ts';
import { rememberBringer } from '../bills/bringers.ts';
import { PLACEHOLDER_NAME } from './names.ts';

/**
 * Привязка человека к лицевому счёту по QR квитанции.
 *
 * Это самое ответственное место продукта: здесь решается, кого пустить
 * к чужому адресу, начислениям и истории платежей.
 *
 * ПРАВИЛО. Квитанция — это ЗАЯВКА, а не пропуск. Любая новая привязка,
 * на свободном счёте или на занятом, заводится со статусом `pending`,
 * и доступ открывает живой человек — председатель совета дома.
 * Управляющая компания его назначает, но жителей не подтверждает:
 * диспетчер заходит в кабинет хорошо если раз в месяц, и очередь
 * встала бы навсегда.
 *
 * ПОЧЕМУ ТАК. Прежнее правило звучало «свободный счёт занимает первый,
 * кто предъявил квитанцию». На деле это означало «первый, кто НАЗВАЛ
 * адрес»: строка платёжного QR приходит обычным HTTP-запросом, подписи
 * ГОСТ Р 56042-2014 не предусматривает, и отличить снятую камерой
 * от набранной руками невозможно. Проверено на живом стенде —
 * придуманная строка открывала чужую квартиру с ролью собственника,
 * а перебор номеров квартир захватывал дом целиком.
 *
 * ЧТО ЗДЕСЬ ЕЩЁ ВАЖНО. Право раздавать доступ нельзя выводить из того же
 * доказательства, которое оно охраняет. Раньше первый пришедший получал
 * и доступ, и власть подтверждать всех остальных; теперь власть приходит
 * только сверху — от председателя, которого назначает УК.
 *
 * РАЗНИЦА В ДОВЕРИИ.
 *   В MAX личность подтверждена подписью платформы — повторный вход
 *   опознаётся по max_user_id надёжно.
 *   В браузере доказательств нет вообще, поэтому в бою браузерный вход
 *   жителя закрыт (см. server/config.ts).
 */

export interface MaxIdentity {
  maxUserId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
  chatId: number | null;
}

export type BindResult =
  | {
      /** Доступ уже подтверждён — человек просто входит */
      status: 'ok';
      userId: string;
      propertyId: string;
      /**
       * Получатель платежа из этой квитанции.
       *
       * Не «управляющая компания»: у частного дома это водоканал
       * или энергосбыт, у квартиры — расчётный центр. Получатель есть
       * в любой квитанции, иначе платить было бы некому, поэтому поле
       * не обнуляемое.
       */
      ukId: string;
      role: 'owner' | 'member';
      /** true, если этот вход создал новую привязку */
      firstTime: boolean;
      receipt: Receipt;
    }
  | {
      /**
       * Заявка заведена и ждёт живого человека.
       *
       * Это ЕДИНСТВЕННЫЙ исход для всякой новой привязки — и когда счёт
       * свободен, и когда занят. Раньше свободный счёт делал предъявителя
       * собственником на месте, и захват дома сводился к перебору номеров
       * квартир: строку QR можно набрать руками, отличить её от снятой
       * камерой сервер не может.
       *
       * Сессия выдаётся сразу: без неё человек не мог бы ни рассказать
       * о себе, ни узнать, подтвердили ли его. Доступа к данным объекта
       * эта сессия не даёт.
       */
      status: 'pending';
      userId: string;
      propertyId: string;
      bindingId: string;
      /** Есть ли у дома председатель — от этого зависит, что показать человеку */
      hasChairman: boolean;
      /** Заполнены ли уже данные о себе */
      claimComplete: boolean;
      /**
       * Квартира объекта — пусто, если её нет вовсе (частный дом или
       * квитанция без квартиры). Экрану «расскажите о себе» нужно это,
       * чтобы не спрашивать номер квартиры повторно у того, для кого
       * его не существует: см. public/app/screens/login.js.
       */
      flat: string;
      receipt: Receipt;
    }
  | {
      /**
       * В квитанции нет адреса.
       *
       * По ГОСТ Р 56042-2014 payerAddress необязателен, и расчётные центры
       * его не печатают: в QR остаются реквизиты получателя и лицевой счёт.
       * Восстановить адрес по счёту нельзя — эта связка есть только
       * в биллинге получателя. Поэтому спрашиваем адрес у жителя,
       * но из справочника, а не строкой.
       */
      status: 'needs_address';
      persAcc: string;
      payeeInn: string | null;
      payeeName: string | null;
      receipt: Receipt;
    }
  | { status: 'invalid_qr'; reason: string };

export interface BindInput {
  qrString: string;
  identity?: MaxIdentity;
  /**
   * Кто сканирует, если он уже вошёл, — добавление второго адреса.
   *
   * Без этого квитанция другого адреса разбиралась бы как вход: по ФИО
   * из неё нашёлся бы или создался ОТДЕЛЬНЫЙ пользователь, и человек
   * получил бы второй аккаунт вместо второго адреса в своём.
   */
  existingUserId?: string;
  /**
   * Имя, которым представился человек.
   *
   * Раньше оно спрашивалось отдельным шагом только на ЗАНЯТОМ счёте
   * и сравнивалось с ФИО собственника: совпало — вход собственником,
   * не совпало — «не сходится с данными собственника». Разные ответы
   * на разные догадки превращали маршрут в оракул для перебора фамилий,
   * причём без всякого ограничения попыток. Сравнения больше нет:
   * имя просто едет в заявку, а решает человек.
   */
  displayName?: string;
  /**
   * Адрес, выбранный жителем в справочнике.
   *
   * Передаётся вторым шагом, когда в самой квитанции адреса не было.
   * Строка собрана сервером в формате квитанции — так адрес из справочника
   * и адрес из QR дают один и тот же houseKey, и соседи по дому сходятся.
   */
  addressRaw?: string;
  /** Человек сказал, что это частный дом, а не квартира */
  declaredPrivate?: boolean;
}

/**
 * Пометка в `user_property.invited_by`: доступ выдало правило частного дома.
 *
 * Отдельного поля «чем принято решение» в таблице нет, а понимать это надо:
 * это ЕДИНСТВЕННОЕ место продукта, где подтверждённый доступ выдаётся без
 * живого человека, и разбирать жалобу «у меня забрали дом» придётся
 * по строке. `invited_by` для того и подходит — это «кто открыл доступ»,
 * внешнего ключа у поля нет, а строка с двоеточием ни на один наш id
 * не похожа (те начинаются с `usr_`, `chr_` и т.п.).
 *
 * Вместе с ней в строке стоит `decided_at`, а `decided_by_chairman_id`
 * и `decided_by_dispatcher_id` пусты: решение есть, человека за ним нет.
 */
export const PRIVATE_HOUSE_GRANT = 'rule:private_house';

/**
 * Адрес, уже привязанный к лицевому счёту этой квитанции.
 *
 * Счёт уникален в паре с получателем платежа, а не сам по себе: номер
 * `857000000015641` у расчётного центра и у энергосбыта — разные счета.
 */
async function addressOfPersAcc(
  db: Database,
  payeeInn: string | null,
  persAcc: string,
): Promise<string | null> {
  if (!payeeInn) return null;

  const rows = await db
    .select({ addressRaw: property.addressRaw })
    .from(account)
    .innerJoin(uk, eq(uk.id, account.ukId))
    .innerJoin(property, eq(property.id, account.propertyId))
    .where(and(eq(uk.inn, payeeInn), eq(account.persAcc, persAcc)))
    .limit(1);

  return rows[0]?.addressRaw?.trim() || null;
}

export async function bindByReceipt(db: Database, input: BindInput): Promise<BindResult> {
  const parsed = parseReceipt(input.qrString);
  if (!parsed.ok) {
    return { status: 'invalid_qr', reason: parsed.reason };
  }
  const receipt = parsed.receipt;

  if (!receipt.payer.persAcc) {
    return { status: 'invalid_qr', reason: 'missing_pers_acc' };
  }

  /**
   * Без адреса объект заводить нельзя.
   *
   * Раньше он создавался с пустым addressRaw и пустым houseKey. Вход
   * проходил, но человек проваливался в пустоту: лента дома, опросы
   * и соседи у него не работали, потому что пустой ключ дома не совпадает
   * ни с чем. Выглядело это как сломанное приложение, а не как нехватка
   * данных в квитанции.
   *
   * Порядок источников: ручной ввод этого запроса → печатный адрес
   * квитанции → адрес, уже привязанный к лицевому счёту.
   *
   * Спрашивать его повторно незачем: счёт заведён, объект у него есть,
   * адрес известен. Без этого житель ходил по кругу — вышел из аккаунта,
   * отсканировал ту же квитанцию, указал адрес, назвался собственником
   * и снова получил форму адреса: имя и намерение уходят отдельным
   * запросом, в котором адреса нет.
   */
  const known = await addressOfPersAcc(db, receipt.payee.inn, receipt.payer.persAcc);

  const ownAddress = input.addressRaw?.trim() || receipt.payer.address?.trim() || '';
  const addressRaw = ownAddress || known || '';

  /**
   * Принёс ли адрес САМ человек.
   *
   * Если да — он его знает, и скрывать до подтверждения нечего. Если нет,
   * адрес подставлен нами по номеру лицевого счёта, и человеку он
   * неизвестен: связка «счёт → квартира» живёт только в биллинге УК.
   * Раздавать её любому, кто угадал номер, мы права не имеем.
   */
  const addressFromUser = Boolean(ownAddress);

  if (!addressRaw) {
    return {
      status: 'needs_address',
      persAcc: receipt.payer.persAcc,
      payeeInn: receipt.payee.inn,
      payeeName: receipt.payee.name,
      receipt,
    };
  }

  const ukRow = await upsertUk(db, receipt);
  const propertyRow = await upsertProperty(db, receipt, {
    addressRaw,
    /**
     * Источник — по тому, НАПЕЧАТАН ли адрес в квитанции.
     *
     * Раньше здесь стояло `input.addressRaw ? 'resident' : 'receipt'`,
     * и адрес, поднятый по лицевому счёту, помечался как печатный.
     * Ручной ввод жителя ждёт подтверждения УК, а «из квитанции» доверенный:
     * такая пометка задним числом сделала бы его проверенным.
     */
    source: receipt.payer.address?.trim() ? 'receipt' : 'resident',
  });
  if (!propertyRow) {
    return { status: 'invalid_qr', reason: 'unparsable_address' };
  }

  /**
   * Объект с номером квартиры доказывает, что дом многоквартирный.
   *
   * Это единственный признак многоквартирности, который приходит сам,
   * без реестра и без оператора: реестр лицензий знает только дома
   * лицензированных УК, а про ТСЖ и непосредственное управление молчит.
   * Признак нужен защите правила частного дома — чтобы дом, в котором
   * уже живут по квартирам, нельзя было объявить своим частным.
   *
   * Форму управления при этом НЕ трогаем: её ставит человек, и менять
   * её автоматом значит менять права молча.
   */
  if (propertyRow.flat) {
    await markMultiFlat(db, propertyRow.houseKey);
  }

  /**
   * Лицевой счёт этой квитанции.
   *
   * Их у квартиры несколько: ЖКУ, свет, газ, вывоз мусора. Раньше каждый
   * из них становился отдельным «адресом» в приложении — четыре карточки
   * на одну квартиру, разорванные начисления и заявка о протечке,
   * улетающая в энергосбыт.
   */
  const accountRow = await upsertAccount(db, propertyRow.id, ukRow.id, receipt);

  const userRow = await resolveUser(
    db, receipt, input.identity, input.existingUserId, input.displayName,
  );

  // Доступ уже подтверждён — просто входим
  const existing = await findBinding(db, userRow.id, propertyRow.id);
  if (existing && existing.status === 'active') {
    /**
     * Начисление пишем на объект СЧЁТА, а не на объект этого запроса.
     *
     * Они совпадают всегда, кроме одного случая: счёт уже заведён
     * на другой квартире. Тогда объект счёта — правда, а объект запроса —
     * чужая догадка, и писать начисление по ней значит переносить
     * чужие деньги.
     */
    await upsertBill(db, accountRow.id, accountRow.propertyId, receipt, userRow.id, true);
    return {
      status: 'ok',
      userId: userRow.id,
      propertyId: propertyRow.id,
      ukId: ukRow.id,
      role: existing.role as 'owner' | 'member',
      firstTime: false,
      receipt,
    };
  }

  /**
   * Всё остальное — заявка.
   *
   * Свободен счёт или занят, здесь больше не различается, и это главное
   * изменение. Пока свободный счёт делал предъявителя собственником
   * на месте, захват дома стоил одного скрипта: строку QR можно набрать
   * руками, а сервер отличить её от снятой камерой не в состоянии.
   * Проверено на живом стенде — придуманная строка открывала чужую
   * квартиру с ролью собственника.
   *
   * Теперь предъявление квитанции значит ровно то, чем оно является:
   * «я говорю, что живу здесь». Доступ даёт человек, который может это
   * проверить, — председатель совета дома. Управляющая компания его
   * назначает, но жителей не подтверждает: диспетчер заходит в кабинет
   * хорошо если раз в месяц.
   */
  /**
   * Частный дом: подтверждать некому и нечего — открывается его же дом.
   * Условия проверяет canOwnPrivateHouse, и слово человека там пятое
   * по счёту, а не первое.
   */
  const asOwner = !existing && await canOwnPrivateHouse(db, {
    houseKey: propertyRow.houseKey,
    flat: propertyRow.flat,
    declaredPrivate: input.declaredPrivate === true,
  });
  if (asOwner) {
    /**
     * Записываем форму дома, но НЕ поверх записи оператора: он дом видел,
     * а мы верим человеку на слово. Автоматика, затирающая решение живого
     * человека, заодно уничтожает след, по которому разбирают захват.
     */
    await setHouseFormUnlessOperator(db, propertyRow.houseKey, {
      form: 'private',
      source: 'resident',
      setBy: userRow.id,
    });
  }

  const inviteCode = existing?.inviteCode ?? humanCode();
  let bindingId = existing?.id ?? '';

  /**
   * Стал ли человек хозяином НА САМОМ ДЕЛЕ.
   *
   * Отдельно от `asOwner`: правило могло сработать, а вставка — проиграть
   * гонку (см. ниже). Тогда исход обычный, заявочный, и отвечать надо им.
   */
  let grantedOwner = false;

  if (!existing) {
    const claimName = input.displayName?.trim() || null;

    if (asOwner) {
      /**
       * Гонка: два одновременных скана проходят условия правила оба —
       * ни один ещё не видит жителя, заведённого другим. Второго
       * не пропустит частичный уникальный индекс
       * `user_property_single_owner_uq`, и это правильно: действующий
       * собственник у объекта один. Но наружу это должно выйти обычной
       * заявкой, а не «внутренней ошибкой сервера»: человек ни в чём
       * не виноват, он просто нажал вторым.
       *
       * Приём тот же, что в upsertAccount ниже и в lib/house/claim.ts:
       * `do nothing` вместо исключения 23505, дальше обычная ветка.
       */
      const [created] = await db
        .insert(userProperty)
        .values({
          id: newId('ubd'),
          userId: userRow.id,
          propertyId: propertyRow.id,
          role: 'owner',
          status: 'active',
          inviteCode,
          claimName,
          addressFromUser,
          /**
           * След решения. Все остальные переходы в `active` проставляют
           * `decidedAt` — эта строка не должна выглядеть иначе. А кто
           * решил, видно по пустым `decidedBy*` рядом с пометкой
           * PRIVATE_HOUSE_GRANT: не председатель и не диспетчер, а правило.
           */
          decidedAt: new Date(),
          decidedByChairmanId: null,
          decidedByDispatcherId: null,
          invitedBy: PRIVATE_HOUSE_GRANT,
        })
        /**
         * Без указания индекса — намеренно.
         *
         * Уникальных индексов у привязки ДВА: `user_property_single_owner_uq`
         * ловит двух разных людей на один объект, а `user_property_uq` —
         * один и тот же человек, нажавший дважды. Пока арбитром стоял
         * только первый, двойной тап законного собственника падал
         * исключением 23505 мимо всей обработки ниже.
         */
        .onConflictDoNothing()
        .returning({ id: userProperty.id });

      if (created) {
        bindingId = created.id;
        grantedOwner = true;
      }
    }

    if (!grantedOwner) {
      const [created] = await db
        .insert(userProperty)
        .values({
          id: newId('ubd'),
          userId: userRow.id,
          propertyId: propertyRow.id,
          role: 'member',
          status: 'pending',
          inviteCode,
          claimName,
          addressFromUser,
        })
        .onConflictDoNothing()
        .returning({ id: userProperty.id });

      /**
       * Вставка ничего не вернула — значит строка уже есть: либо её
       * завёл наш же предыдущий запрос долей секунды раньше, либо
       * правило выше проиграло гонку. Перечитываем и работаем с ней.
       */
      if (created) {
        bindingId = created.id;
      } else {
        const [raced] = await db
          .select({ id: userProperty.id, role: userProperty.role, status: userProperty.status })
          .from(userProperty)
          .where(and(
            eq(userProperty.userId, userRow.id),
            eq(userProperty.propertyId, propertyRow.id),
          ))
          .limit(1);
        if (!raced) throw new Error('привязка исчезла между вставкой и чтением');
        bindingId = raced.id;
        grantedOwner = raced.role === 'owner' && raced.status === 'active';
      }
    }
  } else if (existing.status === 'revoked') {
    /**
     * Отказ не должен превращаться в вечное ожидание.
     *
     * Пока эта ветка молчала, повторное сканирование не создавало ничего:
     * человек читал «Запрос отправлен», а в очереди подтверждающего его
     * не было вовсе, потому что там только ожидающие.
     *
     * Заявка открывается заново, а не удовлетворяется: решает по-прежнему
     * живой человек, и отказать он может снова.
     */
    await db
      .update(userProperty)
      .set({
        status: 'pending',
        inviteCode,
        // Принёс адрес сам — значит и после отказа он его знает
        ...(addressFromUser ? { addressFromUser: true } : {}),
        rejectReason: null,
        decidedAt: null,
        decidedByChairmanId: null,
        decidedByDispatcherId: null,
      })
      .where(eq(userProperty.id, existing.id));
  }

  /**
   * Квитанцию сохраняем и на неподтверждённой заявке — но только как
   * НОВЫЙ период, ничего не перезаписывая. Иначе первое начисление
   * жителя терялось бы до подтверждения, а он видел бы пустую историю
   * и решил, что приложение не приняло квитанцию.
   */
  await upsertBill(db, accountRow.id, accountRow.propertyId, receipt, userRow.id, false);

  if (grantedOwner) {
    return {
      status: 'ok',
      userId: userRow.id,
      propertyId: propertyRow.id,
      ukId: ukRow.id,
      role: 'owner',
      firstTime: true,
      receipt,
    };
  }

  const claim = await db
    .select({ claimName: userProperty.claimName, claimFlat: userProperty.claimFlat })
    .from(userProperty)
    .where(eq(userProperty.id, bindingId))
    .limit(1);

  return {
    status: 'pending',
    userId: userRow.id,
    propertyId: propertyRow.id,
    bindingId,
    hasChairman: await houseHasChairman(db, propertyRow.houseKey),
    // Квартиры может не быть вовсе — тогда заявка полна и без неё
    claimComplete: Boolean(claim[0]?.claimName && (claim[0]?.claimFlat || propertyRow.flat === '')),
    flat: propertyRow.flat,
    receipt,
  };
}

/**
 * Есть ли у дома действующий председатель.
 *
 * Нужно, чтобы честно сказать человеку, чего он ждёт. Если председателя
 * нет, подтвердить некому — и об этом надо сказать прямо, вместе с тем,
 * что делать: попросить управляющую компанию назначить председателя.
 */
async function houseHasChairman(db: Database, houseKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: chairman.id })
    .from(chairman)
    .where(and(eq(chairman.houseKey, houseKey), isNull(chairman.revokedAt)))
    .limit(1);
  return Boolean(rows[0]);
}

/* ─────────────── вспомогательное ─────────────── */

export async function upsertUk(db: Database, receipt: Receipt) {
  const values = {
    id: newId('uk'),
    name: receipt.payee.name,
    inn: receipt.payee.inn,
    kpp: receipt.payee.kpp,
    payeeAccount: receipt.payee.account,
    bankName: receipt.payee.bankName,
    bic: receipt.payee.bic,
    corrAccount: receipt.payee.corrAccount,
  };

  const rows = await db
    .insert(uk)
    .values(values)
    .onConflictDoUpdate({
      target: uk.inn,
      // Реквизиты в квитанции могут смениться — подхватываем свежие
      set: {
        name: values.name,
        payeeAccount: values.payeeAccount,
        bankName: values.bankName,
        bic: values.bic,
        corrAccount: values.corrAccount,
      },
    })
    .returning({ id: uk.id });

  return rows[0];
}

async function upsertProperty(
  db: Database,
  receipt: Receipt,
  input: { addressRaw: string; source: 'receipt' | 'resident' },
) {
  const address = parseAddress(input.addressRaw);

  /**
   * Пустой ключ дома в базу не попадает.
   *
   * Он не просто бесполезен: все объекты с пустым ключом формально
   * оказываются одним «домом». Сейчас их спасает фильтр пустых значений
   * при выборке, но это защита в одном месте, а запись — в другом.
   */
  if (!address.houseKey) return null;

  /**
   * Кто обслуживает дом — из реестра лицензий, а не из квитанции.
   *
   * Получатель платежа управляющей организацией не является: свет, газ
   * и мусор идут ресурсникам напрямую, а жилищную квитанцию печатает
   * расчётный центр, которого в реестре УО нет вовсе.
   */
  /**
   * Ищем дом в реестре — сначала по строгому ключу.
   *
   * Написания «Ленина 85/3» и «Ленина 85, к. 3» сюда доходят уже
   * одинаковыми: дробь разбирается как корпус (см. parseHouseNumber).
   */
  const candidates = houseKeyCandidates(input.addressRaw);
  const columns = {
    ...houseLayerColumns,
    houseKey: house.houseKey,
    // Написание дома, принятое в реестре: его увидят и житель, и УК
    addressRaw: house.addressRaw,
    gisStatus: managingOrg.gisStatus,
  };

  /**
   * Ищем среди домов с реестровым адресом: из набора данных региона или
   * добавленных управляющей компанией. Строка `house`, которую завело
   * приложение (отметка «многоквартирный», форма от оператора), адреса
   * не несёт и ключ жителю не навязывает.
   */
  const lookup = (where: SQL | undefined) => db
    .select(columns)
    .from(house)
    .leftJoin(managingOrg, eq(managingOrg.id, house.registryOrgId))
    .where(and(where, isNotNull(house.addressRaw)));

  let houseRows = candidates.length ? await lookup(inArray(house.houseKey, candidates)) : [];

  /**
   * Запасной путь: тот же дом, но без региона.
   *
   * Регион печатают не все. Живая квитанция начинается сразу с города —
   * «г Ростов-на-Дону, пр-кт Ленина, д.85 корп. 3, кв.27», — а реестр
   * тот же дом пишет с регионом. Строгие ключи расходятся, дом не
   * находится: житель оказывается без управляющей компании, а компания
   * не видит жителя, хотя дом у неё в списке есть. Обратное тоже бывает:
   * часть адресов реестра региона не содержит («346780, г Азов, ул Мира»).
   *
   * Принимаем такое совпадение ТОЛЬКО если оно единственное. Город, улица
   * и номер дома повторяются в разных субъектах — Советск, улица Ленина,
   * дом 1 есть в трёх областях сразу. Когда кандидатов несколько, лучше
   * оставить жителя без УК с честным объяснением, чем молча приписать
   * его к чужому дому за тысячу километров.
   */
  if (houseRows.length === 0) {
    const loose = looseHouseKey(input.addressRaw);
    if (loose) {
      const byLoose = await lookup(eq(house.houseKeyLoose, loose)).limit(2);
      if (byLoose.length === 1) houseRows = byLoose;
    }
  }

  /**
   * Организация дома — по тем же правилам, что и в состоянии дома:
   * лицензия реестра, затем решение человека, затем реестр без лицензии.
   */
  const found = houseRows.map((row) => ({ ...row, orgId: effectiveHouse(row).orgId }));

  /**
   * Кандидатов бывает несколько, и выбирать наугад нельзя.
   *
   * Пока стоял `limit 1` без сортировки, житель дома «Ленина 85/3»
   * получал организацию дома «Ленина 85, к. 3» — какую вернёт база.
   * Правила выбора и почему они такие — в pick-house.ts.
   */
  const managed = pickHouse(found, address.houseKey);
  const managingOrgId = managed?.orgId ?? null;

  /**
   * Ключ берём ИЗ РЕЕСТРА, если дом там нашёлся.
   *
   * Иначе соседи разойдутся между собой: один принёс квитанцию с «85/3»,
   * другой с «85, к. 3», и у них получились бы разные дома. Реестр —
   * единственный общий источник правды об адресе.
   */
  const houseKey = managed?.houseKey ?? address.houseKey;

  /**
   * И написание дома тоже — по той же причине.
   *
   * Квитанция печатает «д. 85, к. 3», реестр пишет «д. 85/3». Пока текст
   * оставался квитанционным, житель видел «Ленина 85к3», а его УК в своём
   * кабинете «Ленина 85/3»: один дом двумя строками. Квартиру подставляем
   * свою — в реестре её нет.
   */
  const canonicalRaw = managed?.addressRaw
    ? addressWithFlat(managed.addressRaw, address.flat)
    : null;

  // Разбор реестровой строки даёт улицу, номер дома и корпус в её словах
  const finalAddress = canonicalRaw ? parseAddress(canonicalRaw) : address;
  const finalRaw = canonicalRaw ?? input.addressRaw;

  const rows = await db
    .insert(property)
    .values({
      id: newId('prp'),
      managingOrgId,
      addressRaw: finalRaw,
      addressSource: input.source,
      houseKey,
      postalCode: finalAddress.postalCode,
      region: finalAddress.region,
      city: finalAddress.city,
      street: finalAddress.street,
      house: finalAddress.house,
      block: finalAddress.block,
      /**
       * Пустая строка — «квартира неизвестна», а НЕ «частный дом».
       *
       * По ГОСТ Р 56042-2014 номер квартиры в QR необязателен, и расчётные
       * центры его часто не печатают. Прежний комментарий утверждал
       * обратное, и на этом утверждении едва не построилось правило
       * мгновенного хозяйства — см. lib/auth/private-house.ts.
       */
      flat: address.flat ?? '',
    })
    .onConflictDoUpdate({
      target: [property.houseKey, property.flat],
      /**
       * Адрес из квитанции перекрывает выбранный жителем, но не наоборот:
       * печатный адрес достовернее, а вот затирать его чужим ручным вводом
       * при повторном сканировании нельзя.
       */
      /**
       * Реестровое написание перекрывает всё: оно общее для жителя и УК.
       * Если дома в реестре нет, работает прежнее правило — адрес
       * из квитанции достовернее ручного ввода, но не наоборот.
       */
      /**
       * ПОДТВЕРЖДЁННЫЙ УК АДРЕС НЕ ПЕРЕПИСЫВАЕТСЯ НИКОГДА.
       *
       * Раньше `addressSource` мог быть выставлен в 'receipt' любым
       * запросом с подходящим QR: посторонний присылал строку с тем же
       * домом и квартирой и снимал пометку «указан жителем». Диспетчер
       * специально смотрит на несверенные адреса — и переставший быть
       * несверенным адрес выпадал из его очереди. Сверку УК (`'uk'`)
       * не трогаем вовсе, остальное обновляем только вверх по доверию.
       */
      set: canonicalRaw
        ? {
            addressRaw: sql`case when ${property.addressSource} = 'uk' then ${property.addressRaw} else ${canonicalRaw} end`,
            houseKey,
            street: finalAddress.street,
            house: finalAddress.house,
            block: finalAddress.block,
            ...(input.source === 'receipt'
              ? { addressSource: sql`case when ${property.addressSource} = 'uk' then 'uk' else 'receipt' end` }
              : {}),
          }
        : input.source === 'receipt'
          ? {
              addressRaw: sql`case when ${property.addressSource} = 'uk' then ${property.addressRaw} else ${input.addressRaw} end`,
              houseKey,
              addressSource: sql`case when ${property.addressSource} = 'uk' then 'uk' else 'receipt' end`,
            }
          : { addressRaw: sql`case when ${property.addressSource} in ('receipt', 'uk') then ${property.addressRaw} else ${input.addressRaw} end` },
    })
    .returning({
      id: property.id,
      managingOrgId: property.managingOrgId,
      houseKey: property.houseKey,
      flat: property.flat,
    });

  const row = rows[0];

  /**
   * Реестр могли загрузить уже после того, как житель привязался.
   * Тогда объект висит без управляющей организации, и первое же
   * обращение к нему это чинит — без повторного сканирования квитанции.
   */
  if (!row.managingOrgId && managingOrgId) {
    await db
      .update(property)
      .set({ managingOrgId })
      .where(eq(property.id, row.id));
  }

  return row;
}

/**
 * Лицевой счёт квитанции.
 *
 * Уникален парой «организация + номер»: один и тот же номер у энергосбыта
 * и у водоканала — разные счета, а повторный скан той же квитанции
 * обязан находить прежний.
 */
export async function upsertAccount(
  db: Database,
  propertyId: string,
  ukId: string,
  receipt: Receipt,
) {
  /**
   * Существующий счёт НЕ переезжает на другой объект.
   *
   * Раньше конфликт по паре «организация + номер счёта» безусловно
   * переписывал `property_id`, и это делалось без всякой проверки того,
   * кто прислал запрос. Достаточно было отправить QR с чужим номером
   * счёта и своим адресом — и счёт уезжал: у жертвы в личном кабинете
   * исчезали номер счёта и поставщик, а последующие начисления
   * записывались на объект постороннего. Проверено на живом стенде.
   *
   * Намерение было доброе — «житель ошибся адресом», — но лечить чужую
   * ошибку не должен посторонний. Счёт остаётся там, где он заведён;
   * переносит его УК из своего кабинета, где видно и счёт, и квартиру.
   */
  const existing = await db
    .select({ id: account.id, propertyId: account.propertyId })
    .from(account)
    .where(and(eq(account.ukId, ukId), eq(account.persAcc, receipt.payer.persAcc!)))
    .limit(1);

  if (existing[0]) {
    return { id: existing[0].id, propertyId: existing[0].propertyId, moved: false };
  }

  const rows = await db
    .insert(account)
    .values({
      id: newId('acc'),
      propertyId,
      ukId,
      persAcc: receipt.payer.persAcc!,
      service: guessService(receipt),
    })
    /**
     * Гонка двух одновременных сканов одной квитанции: оба не нашли счёт,
     * оба вставляют. Уникальный индекс пропустит одного, второму отдаём
     * существующую строку вместо ошибки.
     */
    .onConflictDoNothing({ target: [account.ukId, account.persAcc] })
    .returning({ id: account.id, propertyId: account.propertyId });

  if (rows[0]) return { ...rows[0], moved: false };

  const [raced] = await db
    .select({ id: account.id, propertyId: account.propertyId })
    .from(account)
    .where(and(eq(account.ukId, ukId), eq(account.persAcc, receipt.payer.persAcc!)))
    .limit(1);

  return { id: raced.id, propertyId: raced.propertyId, moved: false };
}

async function findActiveOwner(db: Database, propertyId: string) {
  const rows = await db
    .select({ userId: userProperty.userId })
    .from(userProperty)
    .where(
      and(
        eq(userProperty.propertyId, propertyId),
        eq(userProperty.role, 'owner'),
        eq(userProperty.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function findBinding(db: Database, userId: string, propertyId: string) {
  const rows = await db
    .select()
    .from(userProperty)
    .where(and(eq(userProperty.userId, userId), eq(userProperty.propertyId, propertyId)))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveUser(
  db: Database,
  receipt: Receipt,
  identity: MaxIdentity | undefined,
  existingUserId?: string,
  displayName?: string,
) {
  // Человек уже вошёл и добавляет ещё один адрес — искать его заново незачем
  if (existingUserId) {
    const rows = await db.select().from(appUser).where(eq(appUser.id, existingUserId)).limit(1);
    if (rows[0]) return rows[0];
  }

  // Режим MAX: личность подтверждена подписью платформы
  if (identity) {
    const existing = await db
      .select()
      .from(appUser)
      .where(eq(appUser.maxUserId, identity.maxUserId))
      .limit(1);

    if (existing[0]) {
      // chat_id мог появиться только сейчас — без него уведомление слать некуда
      if (identity.chatId && existing[0].maxChatId !== identity.chatId) {
        await db
          .update(appUser)
          .set({ maxChatId: identity.chatId })
          .where(eq(appUser.id, existing[0].id));
      }
      return existing[0];
    }

    const fullName = [identity.lastName, identity.firstName].filter(Boolean).join(' ')
      || receipt.payer.fullName
      || identity.firstName;

    /**
     * Двойной тап на входе — самый частый случай во всём продукте.
     *
     * Связь в мессенджере медленная, кнопка отвечает не сразу, человек
     * жмёт ещё раз. Оба запроса не находят себя в базе и вставляют
     * пользователя оба; второго не пустит `app_user_max_uq`, и наружу
     * это выходило «внутренней ошибкой сервера» на ровном месте.
     *
     * Приём тот же, что в upsertAccount ниже: `do nothing` вместо
     * исключения, а дальше перечитать того, кого успел завести первый.
     */
    const rows = await db
      .insert(appUser)
      .values({
        id: newId('usr'),
        fullName,
        maxUserId: identity.maxUserId,
        maxUsername: identity.username,
        maxPhotoUrl: identity.photoUrl,
        maxChatId: identity.chatId,
      })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];

    const [raced] = await db
      .select()
      .from(appUser)
      .where(eq(appUser.maxUserId, identity.maxUserId))
      .limit(1);
    if (!raced) throw new Error('пользователь исчез между вставкой и чтением');
    return raced;
  }

  /**
   * Веб-режим.
   *
   * Свободный счёт занимает тот, кто предъявил квитанцию, — имя берём
   * из неё. На занятом счёте имя приходит от самого человека: до этого
   * места мы доходим только после шага 'needs_name'.
   *
   * Прежней подстановки «ФИО из квитанции совпало с собственником —
   * значит это он» здесь больше нет. Квитанция ВСЕГДА выписана на
   * собственника, поэтому правило срабатывало на ком угодно: любой,
   * у кого есть фотография квитанции, входил в чужой кабинет, а завести
   * домочадца было невозможно в принципе.
   */
  const fullName = displayName?.trim() || receipt.payer.fullName || PLACEHOLDER_NAME;

  const rows = await db
    .insert(appUser)
    .values({ id: newId('usr'), fullName })
    .returning();
  return rows[0];
}

export async function upsertBill(
  db: Database,
  accountId: string,
  propertyId: string,
  receipt: Receipt,
  userId: string,
  /**
   * Подтверждён ли доступ у того, кто принёс квитанцию.
   *
   * От этого зависит, можно ли ПЕРЕЗАПИСАТЬ уже известное начисление.
   * Подтверждённый житель приносит свежую квитанцию за тот же период —
   * это норма, суммы уточняются. Неподтверждённый приносит строку,
   * которую мог набрать руками: разрешить ему менять чужие суммы
   * значит отдать постороннему право переписывать деньги в квартире.
   * Поэтому он может только ДОБАВИТЬ период, которого ещё нет.
   */
  confirmed: boolean,
) {
  if (!receipt.period || receipt.sumKopecks === null) return;

  const values = {
    id: newId('bil'),
    accountId,
    propertyId,
    period: receipt.period,
    sumKopecks: receipt.sumKopecks,
    purpose: receipt.purpose,
    rawQr: receipt.rawString,
    source: 'qr_scan',
    createdBy: userId,
  };

  if (!confirmed) {
    await db.insert(bill).values(values)
      .onConflictDoNothing({ target: [bill.accountId, bill.period] });
    // Начисление уже завёл другой — та же бумага даёт на него те же права
    await rememberBringer(db, {
      accountId, period: receipt.period, sumKopecks: receipt.sumKopecks, userId,
    });
    return;
  }

  await db
    .insert(bill)
    .values(values)
    // Повторный скан той же квитанции обновляет запись, а не плодит дубли
    .onConflictDoUpdate({
      target: [bill.accountId, bill.period],
      set: { sumKopecks: receipt.sumKopecks, rawQr: receipt.rawString },
    });
  await rememberBringer(db, {
    accountId, period: receipt.period, sumKopecks: receipt.sumKopecks, userId,
  });
}

/**
 * Вид услуги по квитанции.
 *
 * Нужен, чтобы отличить жилищную квитанцию от ресурсной: заявку о протечке
 * принимает управляющая организация, а не энергосбыт. Определяем по
 * названию получателя и назначению платежа — других признаков в QR нет,
 * поле категории ГОСТ на практике заполняют как попало.
 */
export function guessService(receipt: Receipt): string {
  const text = `${receipt.payee.name ?? ''} ${receipt.purpose ?? ''}`.toLowerCase();

  if (/энергосбыт|энерго|электрич|тнс|мосэнерго|россет/.test(text)) return 'electricity';
  if (/газпром|межрегионгаз|газораспредел|за газ/.test(text)) return 'gas';
  if (/водоканал|за воду|водоснабж|аквасервис/.test(text)) return 'water';
  if (/теплосет|теплоэнерго|за отопление|тепловая/.test(text)) return 'heat';
  if (/тко|твёрдых коммунальных|твердых коммунальных|мусор|экоцентр|регоператор/.test(text)) return 'waste';
  if (/капитальн|капремонт|фонд капитал/.test(text)) return 'overhaul';
  if (/жку|жилищн|содержание|управляющ|ук |тсж|жск|жкх|ивц|еирц|ерц|расчётн|расчетн/.test(text)) return 'housing';

  return 'other';
}

/**
 * Кто перед нами: управляющая организация или поставщик ресурса.
 *
 * От этого зависит, кому уйдёт заявка о протечке. Ошибиться в пользу
 * «управляющей» нельзя: заявка уедет в энергосбыт и там умрёт.
 */
export function guessUkKind(receipt: Receipt): 'managing' | 'utility' | 'unknown' {
  const service = guessService(receipt);
  if (service === 'housing') return 'managing';
  if (service === 'other') return 'unknown';
  return 'utility';
}

/**
 * Собственник подтвердил доступ домочадцу.
 *
 * Роль здесь всегда «жилец»: собственника называет только председатель
 * или УК. Иначе подтверждённый собственник мог бы штамповать собственников,
 * и право раздавать доступ снова стало бы самовоспроизводящимся —
 * ровно то, из-за чего один скрипт захватывал целый дом.
 */
export async function approveBinding(
  db: Database,
  ownerUserId: string,
  bindingId: string,
): Promise<boolean> {
  const rows = await db.select().from(userProperty).where(eq(userProperty.id, bindingId)).limit(1);
  const binding = rows[0];
  if (!binding || binding.status !== 'pending') return false;

  /**
   * Подтверждать вслепую нельзя: пока человек не назвал имя и квартиру,
   * в списке стоит «неизвестно кто просит доступ».
   */
  if (!binding.claimName) return false;

  const owner = await findActiveOwner(db, binding.propertyId);
  if (!owner || owner.userId !== ownerUserId) return false;

  await db
    .update(userProperty)
    .set({ status: 'active', role: 'member', invitedBy: ownerUserId, decidedAt: new Date() })
    .where(eq(userProperty.id, bindingId));
  return true;
}

/** Кто имеет доступ к объекту — для экрана шеринга у собственника. */
export async function listHousehold(db: Database, userId: string, propertyId: string) {
  const mine = await findBinding(db, userId, propertyId);
  if (!mine || mine.status !== 'active') return null;

  const rows = await db
    .select({
      bindingId: userProperty.id,
      userId: userProperty.userId,
      role: userProperty.role,
      status: userProperty.status,
      since: userProperty.createdAt,
      name: appUser.fullName,
      viaMax: appUser.maxUserId,
    })
    .from(userProperty)
    .innerJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(eq(userProperty.propertyId, propertyId));

  return {
    // Отзывать доступ может только собственник — кнопку показываем лишь ему
    canManage: mine.role === 'owner',
    members: rows
      .filter((r) => r.status !== 'revoked')
      .map((r) => ({
        bindingId: r.bindingId,
        name: r.name,
        role: r.role,
        status: r.status,
        since: r.since,
        viaMax: r.viaMax !== null,
        isMe: r.userId === userId,
      })),
  };
}

/**
 * Собственник отзывает доступ домочадца.
 *
 * Возвращает id пользователя, чьи сессии надо погасить: пока живёт сессия,
 * отозванный доступ остаётся рабочим, и отзыв — пустой жест.
 */
export async function revokeBinding(
  db: Database,
  ownerUserId: string,
  bindingId: string,
): Promise<{ ok: false } | { ok: true; revokedUserId: string }> {
  const rows = await db.select().from(userProperty).where(eq(userProperty.id, bindingId)).limit(1);
  const binding = rows[0];
  if (!binding) return { ok: false };

  // Собственника нельзя отозвать — ни чужими руками, ни своими:
  // объект остался бы без владельца, и подтверждать доступ стало бы некому
  if (binding.role === 'owner') return { ok: false };

  const owner = await findActiveOwner(db, binding.propertyId);
  if (!owner || owner.userId !== ownerUserId) return { ok: false };

  await db
    .update(userProperty)
    .set({ status: 'revoked' })
    .where(eq(userProperty.id, bindingId));

  return { ok: true, revokedUserId: binding.userId };
}
