import {
  pgTable, text, integer, bigint, timestamp, uniqueIndex, index, jsonb, boolean, doublePrecision, primaryKey, customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Схема «Домовой».
 *
 * Центральная сущность — ЛИЦЕВОЙ СЧЁТ (property), а не пользователь:
 * именно он приходит из QR квитанции и связывает жителя, дом и УК.
 *
 * Денежные суммы везде в КОПЕЙКАХ целым числом. Ни одного float:
 * Sum из QR приходит копейками (381630 = 3 816,30 ₽), и переводить
 * в рубли можно только на выводе.
 */

const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/* ─────────────── Управляющая компания ─────────────── */

/**
 * Получатель платежа по квитанции.
 *
 * НЕ управляющая компания. Это тот, кому уходят деньги: энергосбыт за свет,
 * межрегионгаз за газ, регоператор за вывоз мусора, расчётный центр за ЖКУ.
 * Дом обслуживает совсем другая организация — см. managingOrg.
 *
 * Проверено на живых данных: ИНН ГУП РО «ИВЦ ЖКХ», который печатает
 * квитанции за ЖКУ, в реестре управляющих организаций ГИС ЖКХ вообще
 * не значится. Выводить управляющую компанию из платёжки нельзя.
 */
export const uk = pgTable('uk', {
  id: id(),
  name: text('name').notNull(),
  inn: text('inn').notNull(),
  kpp: text('kpp'),
  // Реквизиты получателя из QR — нужны, чтобы отдать оплату наружу
  payeeAccount: text('payee_account'),
  bankName: text('bank_name'),
  bic: text('bic'),
  corrAccount: text('corr_account'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('uk_inn_uq').on(t.inn)]);

/* ─────────────── Объект и лицевой счёт ─────────────── */

/**
 * Объект недвижимости: квартира или частный дом.
 *
 * Раньше этой сущностью был ЛИЦЕВОЙ СЧЁТ, и одна квартира с квитанциями
 * за ЖКУ, свет, газ и мусор превращалась в четыре «адреса»: начисления
 * дробились, счётчики висели на одном из них, а заявка о протечке уезжала
 * в энергосбыт, у которого нет ни сантехников, ни обязанности.
 *
 * Теперь объект один, а лицевых счетов у него сколько угодно — см. account.
 */
export const property = pgTable('property', {
  id: id(),
  /**
   * Кто обслуживает дом — из реестра лицензий ГИС ЖКХ, а не из квитанции.
   *
   * Проставляется по houseKey при привязке объекта. Пусто, если дома нет
   * в загруженном реестре: тогда заявку отправлять некому, и приложение
   * говорит об этом прямо.
   */
  managingOrgId: text('managing_org_id').references(() => managingOrg.id),
  addressRaw: text('address_raw').notNull(),
  // Ключ дома без квартиры: по нему собираются соседи, объявления и опросы
  houseKey: text('house_key').notNull(),
  postalCode: text('postal_code'),
  region: text('region'),
  city: text('city'),
  street: text('street'),
  house: text('house'),
  block: text('block'),
  /**
   * Номер квартиры. Пустая строка — частный дом, а не «неизвестно».
   *
   * Именно строка, а не NULL: квартира входит в уникальность объекта,
   * а NULL в Postgres не равен NULL — на частных домах уникальность
   * просто не работала бы, и один дом заводился бы дважды.
   */
  flat: text('flat').notNull().default(''),
  /**
   * Откуда взялся адрес.
   *
   * 'receipt' — из QR квитанции, доверяем полностью.
   * 'resident' — житель выбрал сам, потому что в QR адреса не было:
   *   по ГОСТ Р 56042-2014 поле payerAddress необязательное, и расчётные
   *   центры его не печатают. Такой адрес обязан быть виден как
   *   несверенный, пока УК не подтвердит.
   * 'uk' — подтверждён управляющей компанией.
   */
  addressSource: text('address_source').notNull().default('receipt'),
  addressVerifiedAt: timestamp('address_verified_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  /**
   * Квартира определяется домом и номером квартиры, а не лицевым счётом.
   *
   * coalesce нужен для частных домов: там квартиры нет, а NULL в Postgres
   * не равен NULL — без приведения к пустой строке уникальность на таких
   * объектах не работала бы вовсе.
   */
  uniqueIndex('property_house_flat_uq').on(t.houseKey, t.flat),
  index('property_house_key_idx').on(t.houseKey),
]);

/**
 * Лицевой счёт: связка «объект — получатель платежа».
 *
 * Их у квартиры столько, сколько квитанций приходит. Именно к счёту
 * привязаны начисления: сумма за свет и сумма за ЖКУ — разные деньги
 * разным организациям, складывать их в одну строку нельзя.
 */
export const account = pgTable('account', {
  id: id(),
  propertyId: text('property_id').notNull().references(() => property.id),
  ukId: text('uk_id').notNull().references(() => uk.id),
  persAcc: text('pers_acc').notNull(),
  /** housing | electricity | gas | water | heat | waste | overhaul | other */
  service: text('service').notNull().default('other'),
  createdAt: createdAt(),
}, (t) => [
  // Номер счёта уникален в пределах организации, но не глобально
  uniqueIndex('account_uk_persacc_uq').on(t.ukId, t.persAcc),
  index('account_property_idx').on(t.propertyId),
]);

/* ─────────────── Реестр управляющих организаций ─────────────── */

/**
 * Управляющая организация из сводного федерального реестра лицензий.
 *
 * Источник — открытый API ГИС ЖКХ (`/rls/api/rest/services/license/public/search`),
 * по Ростовской области это 733 лицензии. Организация попадает сюда
 * СПРАВОЧНИКОМ: наличие записи не значит, что компания подключена
 * к сервису. Кабинет ей заводят отдельно, когда она подпишет договор.
 */
export const managingOrg = pgTable('managing_org', {
  id: id(),
  inn: text('inn').notNull(),
  kpp: text('kpp'),
  ogrn: text('ogrn'),
  name: text('name').notNull(),
  shortName: text('short_name'),
  phone: text('phone'),
  regionCode: text('region_code').notNull(),
  licenseNumber: text('license_number'),
  licenseStatus: text('license_status'),
  /** Идентификатор организации в ГИС ЖКХ — по нему тянутся её дома */
  gisOrgGuid: text('gis_org_guid'),
  /**
   * Статус в ГИС ЖКХ: REGISTERED, BLOCKED и прочие.
   *
   * Заблокированные не выбрасываем: у них есть дома и живые жители.
   * Но дом за такой организацией закрепляется только если его не забрала
   * действующая компания.
   */
  gisStatus: text('gis_status'),
  /** Контакты из реестра фонда (ФРТ): без них с домом не договориться */
  email: text('email'),
  site: text('site'),
  /** Идентификатор организации на портале фонда — по нему дома ссылаются на неё */
  frtId: text('frt_id'),
  /** Сколько домов у неё по данным реестра */
  houseCount: integer('house_count').notNull().default(0),
  importedAt: timestamp('imported_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('managing_org_inn_uq').on(t.inn),
  index('managing_org_region_idx').on(t.regionCode),
]);

/**
 * Дом — единственный список домов региона.
 *
 * ДВА СЛОЯ ЗНАНИЯ В ОДНОЙ СТРОКЕ.
 *
 * Реестровый слой (`registry_*`, адрес, GUID, квартиры, координаты) пишет
 * только набор данных региона (`npm run dataset:load`, см. lib/dataset/)
 * и ручное добавление дома управляющей компанией. Повторная загрузка
 * набора переписывает его целиком.
 *
 * Человеческий слой (`form`, `org_id`, `source`, `set_by`, `set_at`,
 * `multi_flat`) пишут оператор, председательская автоматика и правило
 * частного дома. Загрузчик набора его НЕ трогает никогда — иначе каждое
 * обновление реестра молча отменяло бы решения живых людей.
 *
 * Как слои складываются в итоговую форму — lib/house/form.ts, `effectiveHouse`.
 *
 * ПОЧЕМУ ОДНА ТАБЛИЦА. Раньше дома реестра лежали в `managed_house` с
 * обязательной организацией, и дом без УК — ТСЖ, ЖСК, частный — завести
 * было некуда. Два списка домов к тому же расходились между собой.
 */
export const house = pgTable('house', {
  houseKey: text('house_key').primaryKey(),
  /**
   * 'unknown' — состояние по умолчанию, и оно ЧЕСТНОЕ: пока никто
   * не сказал, мы правда не знаем. Отличать «не знаем» от «ничего нет»
   * важно — это разные тексты на экране жителя.
   */
  form: text('form').notNull().default('unknown'),
  /** Обслуживающая организация по слову человека */
  orgId: text('org_id').references(() => managingOrg.id),
  /**
   * Многоквартирный ли дом по отметке приложения. Выводится ТОЛЬКО из данных
   * и никогда со слов человека: на нём держится защита правила частного дома.
   * Реестр даёт тот же признак своими колонками — см. `effectiveHouse`.
   */
  multiFlat: boolean('multi_flat'),
  /** 'registry' | 'resident' | 'operator' — откуда знание человеческого слоя */
  source: text('source').notNull().default('registry'),
  setBy: text('set_by'),
  setAt: timestamp('set_at', { withTimezone: true }),
  createdAt: createdAt(),

  /* ── реестровый слой ── */

  /** GUID дома в ФИАС: по нему дом сшивается между ГАР и ГИС ЖКХ */
  fiasGuid: text('fias_guid'),
  /** Адрес дома в написании реестра; пусто у домов, о которых знают только люди */
  addressRaw: text('address_raw'),
  /**
   * Ключ без региона — запасной путь поиска.
   *
   * Регион печатают не все: живая квитанция начинается сразу с города.
   * Не уникален СПЕЦИАЛЬНО: город, улица и номер повторяются в разных
   * субъектах, поэтому совпадение принимается, только если оно
   * единственное, — см. lib/auth/bind.ts.
   */
  houseKeyLoose: text('house_key_loose'),
  regionCode: text('region_code'),
  /** Место дома в адресном дереве: улица, а у дома без улицы — населённый пункт */
  streetGuid: text('street_guid'),
  /** По реестру фонда: mkd | blocked | special; пусто — в фонде дома нет */
  houseKind: text('house_kind'),
  /**
   * ФНС пометила дом многоквартирным (параметр ГАР «Многоквартирный дом»).
   * Пусто — набор без параметров ГАР, а не «частный».
   */
  garMkd: boolean('gar_mkd'),
  /** Кадастровый номер здания из ГАР */
  cadastralNumber: text('cadastral_number'),
  /** Идентификатор дома в ГИС ЖКХ */
  gisHouseGuid: text('gis_house_guid'),
  /** Жилых помещений по ГИС ЖКХ */
  flatCount: integer('flat_count'),
  /** Квартир у дома в ГАР — признак многоквартирности из данных, а не со слов */
  garFlats: integer('gar_flats'),
  /** Способ управления по реестру: uk | tsj | zhsk | direct | private | unknown */
  registryForm: text('registry_form'),
  /** Организация по реестру */
  registryOrgId: text('registry_org_id').references(() => managingOrg.id),
  /** Координаты из OpenStreetMap; пусто, если дом на карте не нашёлся */
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  /* паспорт из реестра фонда — для подбора дома */
  builtYear: integer('built_year'),
  floors: integer('floors'),
  entrances: integer('entrances'),
  elevators: integer('elevators'),
  wallMaterial: text('wall_material'),
  /** Газ в доме по паспорту фонда; пусто — фонд молчит */
  gas: boolean('gas'),
  /** Признан аварийным */
  emergency: boolean('emergency'),
  importedAt: timestamp('imported_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('house_fias_uq').on(t.fiasGuid).where(sql`${t.fiasGuid} is not null`),
  index('house_loose_idx').on(t.houseKeyLoose),
  index('house_region_idx').on(t.regionCode),
  index('house_registry_org_idx').on(t.registryOrgId),
  index('house_street_idx').on(t.streetGuid),
  index('house_geo_idx').on(t.lat, t.lon),
]);

/* ─────────────── Справочник адресов ─────────────── */

/**
 * Регионы, справочник которых загружен.
 *
 * Отдельная таблица, а не константа в коде: «подключить ещё один субъект»
 * должно быть запуском импорта, а не правкой исходников и выкладкой.
 * Житель со «слепой» квитанцией видит честное «этот регион пока не
 * подключён» ровно до тех пор, пока строки здесь нет.
 */
export const region = pgTable('region', {
  /** Код субъекта РФ: две цифры, как в КЛАДР и в ИНН юрлица */
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull(),          // 'loading' | 'loaded'
  source: text('source'),                    // например 'ГАР 2026.09.15, ФРТ 2026-09-01'
  /** Населённых пунктов (уровни 5–6 дерева) */
  placeCount: integer('place_count').notNull().default(0),
  /** Улиц и планировочных структур (уровни 7–8 дерева) */
  streetCount: integer('street_count').notNull().default(0),
  loadedAt: timestamp('loaded_at', { withTimezone: true }),
});

/**
 * Адресное дерево региона из ГАР ФНС: субъект → район → город или
 * населённый пункт → планировочная структура → улица.
 *
 * ЗАЧЕМ ДЕРЕВО, А НЕ СПИСОК УЛИЦ. Раньше справочник был из КЛАДР, и житель
 * без адреса в квитанции выбирал улицу, а номер дома вводил руками:
 * КЛАДР домов не знает. ГАР знает все дома, и у каждого есть место в этом
 * дереве (`house.street_guid`) — житель выбирает дом из списка, и его ключ
 * гарантированно совпадает с соседями.
 *
 * Иерархия — административная: её пишут квитанции и ГИС ЖКХ
 * («р-н Аксайский, г Аксай»), а не муниципальная («м.р-н», «г.п.»).
 */
export const addressObject = pgTable('address_object', {
  /** GUID ФИАС объекта */
  guid: text('guid').primaryKey(),
  regionCode: text('region_code').notNull(),
  parentGuid: text('parent_guid'),
  /** 1 субъект, 2 район, 5 город, 6 населённый пункт, 7 планировочная структура, 8 улица */
  level: integer('level').notNull(),
  /** Сокращение типа без завершающей точки: «г», «ул», «тер. СНТ» */
  type: text('type').notNull(),
  name: text('name').notNull(),
  /** Нижний регистр без «ё» — по нему идёт поиск */
  searchName: text('search_name').notNull(),
}, (t) => [
  index('address_object_search_idx').on(t.regionCode, t.level, t.searchName),
  index('address_object_parent_idx').on(t.parentGuid),
]);

/* ─────────────── Пользователь ─────────────── */

export const appUser = pgTable('app_user', {
  id: id(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  // Заполнен в режиме MAX, пуст в браузерном
  maxUserId: bigint('max_user_id', { mode: 'number' }),
  maxUsername: text('max_username'),
  maxPhotoUrl: text('max_photo_url'),
  // chat_id из initData — без него уведомление отправить некуда
  maxChatId: bigint('max_chat_id', { mode: 'number' }),
  /**
   * Режим уведомлений: all | important | off | custom.
   *
   * Режим и подробные переключатели живут рядом сознательно. Человек
   * выбирает пресет, а потом правит одну галочку — и режим сам становится
   * «свой». Хранить только галочки значило бы потерять его выбор,
   * хранить только режим — не дать поправить одну строчку.
   */
  notifyMode: text('notify_mode').notNull().default('all'),
  /** Переключатели по видам уведомлений: { kind: boolean } */
  notifyPrefs: jsonb('notify_prefs'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('app_user_max_uq').on(t.maxUserId)]);

/**
 * Связь пользователя с объектом. Одна таблица закрывает сразу две фичи:
 * несколько адресов у человека и несколько человек на одном адресе.
 *
 * ЗАЯВКА, А НЕ ПРОПУСК. Квитанция сама по себе не доказывает ничего:
 * её строка приходит обычным HTTP-запросом, и отличить снятую камерой
 * от набранной руками нельзя — подписи ГОСТ Р 56042-2014 не предусмотрел.
 * Пока первый предъявивший становился собственником, перебором номеров
 * квартир захватывался весь дом, а настоящие жители оказывались
 * просителями у захватчика. Поэтому привязка теперь заводится в статусе
 * `pending`, а полный доступ даёт живой человек — председатель совета
 * дома, который знает соседей в лицо, или диспетчер УК, у которого есть
 * биллинг.
 */
export const userProperty = pgTable('user_property', {
  id: id(),
  userId: text('user_id').notNull().references(() => appUser.id),
  propertyId: text('property_id').notNull().references(() => property.id),
  /** 'owner' | 'member'. До подтверждения роль не значит ничего. */
  role: text('role').notNull(),
  /** 'pending' | 'active' | 'revoked' */
  status: text('status').notNull(),
  inviteCode: text('invite_code'),
  invitedBy: text('invited_by'),

  /**
   * Адрес пришёл ОТ САМОГО ЧЕЛОВЕКА, а не подставлен сервером.
   *
   * Разница решает, показывать ли адрес до подтверждения. Если человек
   * принёс его в своей квитанции или сам выбрал улицу в справочнике —
   * он его и так знает, скрывать бессмысленно. А вот адрес, который
   * сервер сам поднял по номеру лицевого счёта (`addressOfPersAcc`),
   * человеку неизвестен: связка «счёт → квартира» живёт только
   * в биллинге УК, и раздавать её мы права не имеем.
   */
  addressFromUser: boolean('address_from_user').notNull().default(false),

  /* ── что человек рассказал о себе, пока ждёт подтверждения ── */

  /**
   * Как человек представился.
   *
   * Отдельно от `app_user.full_name`: в MAX у половины аккаунтов нет
   * фамилии, а иногда нет и имени — там ник. Председателю нужно понять,
   * кто перед ним, поэтому ФИО спрашивается явно и хранится рядом
   * с заявкой, а не подменяет имя аккаунта.
   */
  claimName: text('claim_name'),
  /** Квартиру называет сам житель: в квитанции её может не быть */
  claimFlat: text('claim_flat'),
  /** Телефон для связи, если человек захотел его оставить */
  claimPhone: text('claim_phone'),
  /** Свободная строка председателю: «я из 27-й, сын Ивановых» */
  claimNote: text('claim_note'),

  /* ── кто и когда решил ── */

  decidedByChairmanId: text('decided_by_chairman_id').references(() => chairman.id),
  decidedByDispatcherId: text('decided_by_dispatcher_id').references(() => dispatcher.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /** Почему отказали — житель должен понимать, что делать дальше */
  rejectReason: text('reject_reason'),

  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('user_property_uq').on(t.userId, t.propertyId),
  index('user_property_property_idx').on(t.propertyId),
  /**
   * Один действующий собственник на объект — правилом базы, а не кода.
   *
   * Проверка «уже есть владелец?» и вставка шли разными запросами без
   * транзакции: три одновременных скана свободного счёта давали трёх
   * активных собственников одной квартиры. Дальше «кто собственник»
   * решал `limit 1` без сортировки, то есть заново на каждом запросе —
   * включая подтверждение и отзыв доступа. Частичный уникальный индекс
   * делает это невозможным независимо от того, что напутает код.
   */
  uniqueIndex('user_property_single_owner_uq')
    .on(t.propertyId)
    .where(sql`${t.role} = 'owner' and ${t.status} = 'active'`),
  index('user_property_pending_idx').on(t.status, t.propertyId),
]);

/* ─────────────── Квитанции и счётчики ─────────────── */

export const bill = pgTable('bill', {
  id: id(),
  /** Начисление принадлежит лицевому счёту: у света и у ЖКУ суммы разные */
  accountId: text('account_id').notNull().references(() => account.id),
  propertyId: text('property_id').notNull().references(() => property.id),
  period: text('period').notNull(),                    // 'YYYY-MM'
  sumKopecks: bigint('sum_kopecks', { mode: 'number' }).notNull(),
  purpose: text('purpose'),
  rawQr: text('raw_qr'),
  source: text('source').notNull(),                    // 'qr_scan' | 'manual'
  /**
   * Отметка об оплате.
   *
   * Ставит её ЖИТЕЛЬ, а не система: узнать, прошёл ли платёж, приложение
   * не может — в платёжном QR по ГОСТ Р 56042-2014 есть только сумма
   * к оплате, а доступа к биллингу УК, к ГИС ЖКХ и к банку у нас нет.
   * Поэтому поле называет источник знания честно, и интерфейс обязан
   * говорить «по вашим отметкам», а не «оплачено».
   */
  paidAt: timestamp('paid_at', { withTimezone: true }),
  paidKopecks: bigint('paid_kopecks', { mode: 'number' }),
  paidSource: text('paid_source'),                    // 'resident' | 'uk' | 'provider'
  createdBy: text('created_by').references(() => appUser.id),
  createdAt: createdAt(),
}, (t) => [
  // Одна квитанция на период и счёт: повторный скан обновляет, а не плодит
  uniqueIndex('bill_account_period_uq').on(t.accountId, t.period),
  index('bill_property_idx').on(t.propertyId),
]);

/**
 * Кто ещё принёс ту же квитанцию.
 *
 * ЗАЧЕМ. Начисление одно на счёт и период, и `bill.created_by` помнит
 * только первого. Муж и жена с одной платёжкой, два эксперта с одной
 * тестовой квитанцией: второй сканировал ту же бумагу, а до подтверждения
 * видел «Квитанций пока нет» — ему показывали только им же созданное.
 *
 * Строка появляется, только если сумма в принесённом QR совпала с уже
 * записанной: это та же квитанция, и человек держит её в руках так же,
 * как первый. Другая сумма — другая бумага, её права не дают.
 */
export const billBringer = pgTable('bill_bringer', {
  billId: text('bill_id').notNull().references(() => bill.id),
  userId: text('user_id').notNull().references(() => appUser.id),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.billId, t.userId] })]);

export const meter = pgTable('meter', {
  id: id(),
  propertyId: text('property_id').notNull().references(() => property.id),
  kind: text('kind').notNull(),        // cold | hot | elec | gas | heat (elec_t1/t2 — старые записи)
  /**
   * Где стоит: «кухня», «ванная». Холодной воды в квартире часто два
   * счётчика, и без подписи их не различить.
   */
  place: text('place'),
  /**
   * Кто завёл счётчик. До подтверждения человек видит и пишет только
   * свои счётчики: иначе посторонний со строкой QR читал чужие показания
   * и занимал месяц в чужом дневнике. Пусто — старые записи, до поля.
   */
  createdBy: text('created_by').references(() => appUser.id),
  serial: text('serial'),
  // Просроченная поверка переводит начисление на норматив — частая боль жителей
  verificationDue: timestamp('verification_due', { withTimezone: true }),
  createdAt: createdAt(),
});

export const meterReading = pgTable('meter_reading', {
  id: id(),
  meterId: text('meter_id').notNull().references(() => meter.id),
  period: text('period').notNull(),
  value: text('value').notNull(),      // строкой: показания бывают дробные
  photoUrl: text('photo_url'),
  createdBy: text('created_by').references(() => appUser.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('meter_reading_uq').on(t.meterId, t.period)]);

/* ─────────────── Заявки ─────────────── */

export const request = pgTable('request', {
  id: id(),
  number: integer('number').notNull(),
  propertyId: text('property_id').notNull().references(() => property.id),
  /** Заявку разбирает управляющая организация дома — если она есть */
  orgId: text('org_id').references(() => managingOrg.id),
  /**
   * Область сквозной нумерации: id организации либо `house:<houseKey>`.
   *
   * ПОЧЕМУ НЕ org_id. Номер называют по телефону, и он обязан быть
   * уникальным в пределах того, кто заявку разбирает. У дома без
   * организации разбирает совет дома — значит область это дом.
   * Уникальность по org_id с NULL не работает вовсе: NULL не равен NULL,
   * и дубликаты номеров прошли бы молча.
   */
  numberScope: text('number_scope').notNull(),
  authorId: text('author_id').notNull().references(() => appUser.id),
  kind: text('kind').notNull(),        // 'complaint' | 'master'
  category: text('category').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull(),    // new | in_work | need_info | done | rejected
  // Срок по регламенту: это то, что продаёт продукт управляющей компании
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  masterSlotStart: timestamp('master_slot_start', { withTimezone: true }),
  masterSlotEnd: timestamp('master_slot_end', { withTimezone: true }),
  assigneeName: text('assignee_name'),
  rejectReason: text('reject_reason'),
  createdAt: createdAt(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('request_scope_number_uq').on(t.numberScope, t.number),
  index('request_status_idx').on(t.numberScope, t.status),
  index('request_property_idx').on(t.propertyId),
]);

export const requestEvent = pgTable('request_event', {
  id: id(),
  requestId: text('request_id').notNull().references(() => request.id),
  type: text('type').notNull(),
  text: text('text').notNull(),
  actor: text('actor').notNull(),      // 'resident' | 'dispatcher' | 'chairman' | 'system'
  /**
   * Имя написавшего: «Смирнова Анна», «Диспетчер Ольга».
   *
   * Одной роли мало. На адресе бывает несколько жильцов (домочадцы),
   * и без имени в переписке не понять, кто из них ответил; у УК так же
   * не видно, какой именно диспетчер вёл заявку.
   */
  actorName: text('actor_name'),
  createdAt: createdAt(),
}, (t) => [index('request_event_request_idx').on(t.requestId)]);

/**
 * Вложение к обращению: фотография протечки, акт, скан предписания.
 *
 * ПОЧЕМУ НЕ ССЫЛКА. Раньше здесь лежал только `url`, и приём его от
 * клиента убрали в аудит: без своего хранилища это был способ подсунуть
 * диспетчеру ссылку на что угодно. Теперь файл лежит у нас, а наружу
 * уходит не адрес, а маршрут с проверкой доступа.
 */
export const requestPhoto = pgTable('request_photo', {
  id: id(),
  requestId: text('request_id').notNull().references(() => request.id),
  /** Оставлен для старых записей; новые вложения его не используют */
  url: text('url').notNull(),
  /** Имя файла на диске: идентификатор вложения плюс расширение */
  storedName: text('stored_name'),
  /** Как файл назывался у человека — показываем в списке */
  originalName: text('original_name'),
  mime: text('mime'),
  sizeBytes: integer('size_bytes'),
  /** Кто приложил: житель или диспетчер — подпись под вложением */
  uploadedBy: text('uploaded_by').references(() => appUser.id),
  uploadedByDispatcher: text('uploaded_by_dispatcher').references(() => dispatcher.id),
  createdAt: createdAt(),
}, (t) => [index('request_photo_request_idx').on(t.requestId)]);

export const rating = pgTable('rating', {
  id: id(),
  requestId: text('request_id').notNull().references(() => request.id),
  stars: integer('stars').notNull(),
  comment: text('comment'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('rating_request_uq').on(t.requestId)]);

/* ─────────────── Жизнь дома ─────────────── */

/** ОПРОС, а не ОСС: юридической силы нет, и мы это нигде не обещаем. */
export const poll = pgTable('poll', {
  id: id(),
  /**
   * Управляющая организация — если она у дома есть.
   *
   * БЫЛО notNull, И ЭТО БЫЛА ТА ЖЕ СТЕНА, ЧТО У chairman.org_id. Опрос
   * принадлежит ДОМУ — см. house_key и poll_house_idx ниже, — а не
   * организации, но схема требовала организацию, и дом на ТСЖ,
   * непосредственном управлении или вовсе без управления не мог
   * получить совет дома, даже с председателем на месте.
   */
  orgId: text('org_id').references(() => managingOrg.id),
  /** Опрос завёл председатель, а не УК. Жителю важно, кто спрашивает. */
  chairmanId: text('chairman_id').references(() => chairman.id),
  houseKey: text('house_key').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  opensAt: timestamp('opens_at', { withTimezone: true }).notNull().defaultNow(),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  status: text('status').notNull(),    // 'open' | 'closed'
  createdAt: createdAt(),
}, (t) => [index('poll_house_idx').on(t.houseKey)]);

export const pollOption = pgTable('poll_option', {
  id: id(),
  pollId: text('poll_id').notNull().references(() => poll.id),
  text: text('text').notNull(),
  position: integer('position').notNull(),
});

export const pollVote = pgTable('poll_vote', {
  id: id(),
  pollId: text('poll_id').notNull().references(() => poll.id),
  optionId: text('option_id').notNull().references(() => pollOption.id),
  userId: text('user_id').notNull().references(() => appUser.id),
  createdAt: createdAt(),
}, (t) => [
  // Один голос на человека. Переголосовать можно только через UPDATE
  uniqueIndex('poll_vote_uq').on(t.pollId, t.userId),
]);

export const post = pgTable('post', {
  id: id(),
  orgId: text('org_id').references(() => managingOrg.id),
  houseKey: text('house_key').notNull(),
  authorId: text('author_id').references(() => appUser.id), // null = от УК
  type: text('type').notNull(),        // 'uk' | 'resident'
  category: text('category').notNull(),// outage | meeting | news | market
  title: text('title').notNull(),
  body: text('body').notNull(),
  contact: text('contact'),            // для объявлений соседей
  /**
   * Автор показал соседям свой подтверждённый телефон и ник MAX.
   * Сам номер здесь не хранится: читается из профиля в момент показа,
   * чтобы сменённый или убранный номер не жил в старых объявлениях.
   */
  sharePhone: boolean('share_phone').notNull().default(false),
  /**
   * Кто из председателей опубликовал.
   *
   * Отдельно от `author_id`, хотя председатель и есть житель: должность
   * может смениться, а подпись под старым объявлением должна остаться
   * той, что была в момент публикации.
   */
  chairmanId: text('chairman_id').references(() => chairman.id),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * До какого момента объявление актуально.
   *
   * Без срока баннер «нет воды до 18:00» висел на главном экране жителя,
   * пока УК не опубликует следующее отключение. Пустое значение —
   * бессрочное объявление: новость или собрание.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** Снято вручную. Мягко: история публикаций дома не должна пропадать. */
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [index('post_house_idx').on(t.houseKey, t.publishedAt)]);

/**
 * Фотография объявления: карточка товара у соседей, обложка объявления дома.
 *
 * ОДНА на объявление, и это закреплено уникальным индексом. Галерея здесь
 * не нужна: карточка товара — одно фото над заголовком. Вторая фотография
 * потребовала бы решать, какая из них обложка, и заводить листалку
 * на экране. Понадобится — снимем индекс, а пока лишнего не строим.
 *
 * Файл лежит в том же хранилище, что и вложения обращений, но в своём
 * каталоге `posts/<postId>/`, чтобы с ними не столкнуться.
 */
export const postPhoto = pgTable('post_photo', {
  id: id(),
  postId: text('post_id').notNull().references(() => post.id),
  /** Имя файла на диске: идентификатор плюс расширение по содержимому */
  storedName: text('stored_name').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedBy: text('uploaded_by').references(() => appUser.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('post_photo_post_uq').on(t.postId)]);

/**
 * Кто какое объявление прочитал.
 *
 * ПРОЧИТАНО = человек открыл карточку. Не «пролистал список» и не
 * «заходил в раздел»: отметка по последнему визиту объявляла бы
 * прочитанными все заголовки, которые человек только увидел в списке.
 *
 * Храним только прочитанные. Обратная таблица «кто чего не читал» росла
 * бы произведением жителей на объявления — а их в доме десятки и сотни.
 */
export const postRead = pgTable('post_read', {
  id: id(),
  postId: text('post_id').notNull().references(() => post.id),
  userId: text('user_id').notNull().references(() => appUser.id),
  readAt: createdAt(),
}, (t) => [uniqueIndex('post_read_uq').on(t.postId, t.userId)]);

/* ─────────────── Доступ ─────────────── */

export const dispatcher = pgTable('dispatcher', {
  id: id(),
  /** Кабинет принадлежит управляющей организации из реестра, а не получателю платежа */
  orgId: text('org_id').notNull().references(() => managingOrg.id),
  login: text('login').notNull(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('dispatcher_login_uq').on(t.login)]);

/**
 * Оператор сервиса — учётка выше диспетчера.
 *
 * ЗАЧЕМ ОНА ЕСТЬ. Дом без управляющей компании некому подключить изнутри:
 * председателя назначает УК, а её нет. Разрывает круг человек снаружи.
 * До этой таблицы он работал командами из консоли — это был компромисс
 * порядка работ, а не замысел.
 *
 * Учётка заводится командой, а не саморегистрацией: оператор — это
 * владелец сервиса, а не роль, которую кто-то может себе выписать.
 */
export const admin = pgTable('admin', {
  id: id(),
  login: text('login').notNull(),
  passwordHash: text('password_hash').notNull(),
  /** Человекочитаемое имя — им подписаны записи журнала */
  name: text('name').notNull(),
  createdAt: createdAt(),
  /** Выключен: вход закрыт, записи журнала остаются */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [uniqueIndex('admin_login_uq').on(t.login)]);

/**
 * Журнал действий оператора.
 *
 * ПОЧЕМУ ОН ОБЯЗАТЕЛЕН. У оператора есть право, которого нет ни у кого:
 * снять председателя, закрыть жителю доступ, поменять форму дома.
 * Продукт при этом стоит на доверии к записям — жалобу нельзя стереть.
 * Без журнала на вопрос «кто снял меня с должности» ответить нечем.
 *
 * Пишется ОДНОЙ функцией (lib/admin/audit.ts), которую зовёт каждое
 * действие. Не россыпью вставок по маршрутам: так однажды забудут,
 * и журнал станет врать молчанием — худший вид неправды для журнала.
 *
 * Записи переживают выключение учётки: внешний ключ на `admin` есть,
 * а удаления оператора нет вовсе — только `disabled_at`.
 */
export const adminAction = pgTable('admin_action', {
  id: id(),
  adminId: text('admin_id').notNull().references(() => admin.id),
  /** Машинное имя: 'chairman.create', 'house.form', 'binding.revoke' */
  action: text('action').notNull(),
  /** Над чем: 'house' и ключ дома, 'user_property' и id привязки */
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id').notNull(),
  /**
   * Человекочитаемая строка по-русски — её и читают в журнале.
   *
   * Машинное имя годится для фильтра, но не для ответа на вопрос
   * «что здесь произошло», а отвечать на него будут через полгода.
   */
  summary: text('summary').notNull(),
  payload: jsonb('payload'),
  createdAt: createdAt(),
}, (t) => [
  index('admin_action_at_idx').on(t.createdAt),
  index('admin_action_target_idx').on(t.targetKind, t.targetId),
]);

/**
 * Председатель совета дома — РОЛЬ ЖИТЕЛЯ, а не отдельная учётка.
 *
 * ЧТО ИЗМЕНИЛОСЬ И ПОЧЕМУ. Раньше это был отдельный аккаунт с логином
 * и паролем, а кабинет жил отдельной веб-страницей. На практике
 * председатель — такой же житель этого дома: у него та же квартира, те же
 * квитанции и тот же счётчик. Держать ему второй аккаунт значит заставлять
 * человека помнить, «под кем он сейчас», — а это ровно то, на чём
 * спотыкаются пожилые, которых в советах домов большинство.
 *
 * Теперь права проверяются по сессии ЖИТЕЛЯ: есть ли у его `app_user`
 * действующая строка здесь. Отдельного входа и отдельной сессии нет.
 *
 * Строка всё равно отдельная, а не флаг на `user_property`: право
 * председателя привязано к ДОМУ, а не к квартире, и снимается независимо
 * от того, что происходит с его привязкой к квартире.
 */
export const chairman = pgTable('chairman', {
  id: id(),
  /**
   * Управляющая организация — если она у дома есть.
   *
   * БЫЛО notNull, И ЭТО БЫЛА СТЕНА. Право председателя привязано
   * к ДОМУ, а не к организации, — так написано ниже в этом же
   * комментарии, — но схема требовала организацию, и дом на ТСЖ,
   * непосредственном управлении или вовсе без управления не мог
   * получить председателя в принципе. Не в интерфейсе — в базе.
   */
  orgId: text('org_id').references(() => managingOrg.id),
  houseKey: text('house_key').notNull(),
  /** Житель, который является председателем */
  userId: text('user_id').notNull().references(() => appUser.id),
  name: text('name').notNull(),
  flat: text('flat'),
  createdBy: text('created_by').references(() => dispatcher.id),
  /** 'dispatcher' | 'operator' — кто назначил */
  createdBySource: text('created_by_source').notNull().default('dispatcher'),
  createdAt: createdAt(),
  /** Снят с должности: права закрыты, публикации остаются. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  index('chairman_house_idx').on(t.houseKey),
  index('chairman_user_idx').on(t.userId),
  /**
   * Один действующий председатель на дом — правилом базы.
   *
   * Двое с равными правами публикуют противоречащие объявления от имени
   * одного совета дома, и житель не понимает, какое настоящее.
   */
  uniqueIndex('chairman_house_active_uq')
    .on(t.houseKey)
    .where(sql`${t.revokedAt} is null`),
]);

/**
 * Телефоны дома: лифтёрская служба, диспетчерская, домофон.
 *
 * ПОЧЕМУ ИХ ВПИСЫВАЕТ ЧЕЛОВЕК. Ни в ГАР, ни в реестрах фонда, ни в ГИС
 * ЖКХ этих номеров нет, а выдуманный номер на экране аварийных служб —
 * худшее, что можно показать: по нему звонят. Поэтому номер вписывает
 * тот, кто за него отвечает, — председатель, УК или оператор, — и житель
 * видит, кто именно.
 *
 * Это человеческий слой, как `house.form`: загрузчик набора региона
 * таблицу не трогает. Внешнего ключа на `house` нет намеренно —
 * председатель бывает и у дома, которого нет в реестре (см. `chairman`).
 */
export const houseContact = pgTable('house_contact', {
  id: id(),
  houseKey: text('house_key').notNull(),
  /** lift | uk_dispatch | intercom | electric | plumber | other — см. lib/house/contacts.ts */
  kind: text('kind').notNull(),
  /** Название только у `other`; у готовых типов берётся из справочника */
  label: text('label'),
  /** Как вписали, без переформатирования: так его и узнают на квитанции */
  phone: text('phone').notNull(),
  /** «круглосуточно», «подъезды 1–3» */
  note: text('note'),
  /** 'chairman' | 'dispatcher' | 'operator' — это житель и видит */
  updatedByRole: text('updated_by_role').notNull(),
  /** id строки chairman, dispatcher или admin */
  updatedBy: text('updated_by').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('house_contact_house_idx').on(t.houseKey),
  /** Одна лифтёрская на дом: две разные строки — два номера, и непонятно, какой настоящий */
  uniqueIndex('house_contact_kind_uq')
    .on(t.houseKey, t.kind)
    .where(sql`${t.kind} <> 'other'`),
]);

/**
 * Сессии в базе, а не JWT: отзыв доступа домочадца обязан убивать
 * его сессию немедленно, а stateless-токен продолжил бы работать
 * до истечения срока.
 */
export const session = pgTable('session', {
  id: id(),
  userId: text('user_id').references(() => appUser.id),
  dispatcherId: text('dispatcher_id').references(() => dispatcher.id),
  /**
   * Сессия оператора. Отдельная колонка, а не роль на `dispatcher_id`:
   * права разные, и путать их нельзя — кабинет УК видит один дом,
   * оператор видит всё.
   */
  adminId: text('admin_id').references(() => admin.id),
  /**
   * Сессии председателя больше нет.
   *
   * Он входит как обычный житель, а права проверяются по таблице
   * `chairman`. Отдельный тип сессии означал бы второй вход и второй
   * профиль — то, от чего мы как раз уходим.
   */
  tokenHash: text('token_hash').notNull(),
  platform: text('platform'),          // 'max' | 'web'
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('session_token_uq').on(t.tokenHash),
  index('session_user_idx').on(t.userId),
]);

/** Очередь уведомлений: транспорт выбирается по наличию maxChatId. */
export const notification = pgTable('notification', {
  id: id(),
  userId: text('user_id').notNull().references(() => appUser.id),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  deepLinkPayload: text('deep_link_payload'),
  transport: text('transport'),        // 'max_bot' | 'web_push'
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
  payload: jsonb('payload'),
  read: boolean('read').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index('notification_user_idx').on(t.userId, t.createdAt)]);

/**
 * Приглашение жильца собственником.
 *
 * ЗАЧЕМ ОНО ЕСТЬ. Домочадец не должен сканировать квитанцию: она одна
 * на квартиру и лежит у собственника. Раньше второй человек в семье
 * предъявлял ту же платёжку и вставал в очередь к председателю — тот
 * же путь, что у постороннего, и с той же задержкой.
 *
 * ПОЧЕМУ ЭТО НЕ ДЫРА. Приглашение выдаёт ПОДТВЕРЖДЁННЫЙ собственник
 * и только на СВОЮ квартиру: он знает, кто у него живёт, лучше
 * председателя. Код одноразовый и живёт 48 часов — пересланная в чат
 * ссылка не остаётся ключом от квартиры навсегда.
 */
export const invite = pgTable('invite', {
  id: id(),
  propertyId: text('property_id').notNull().references(() => property.id),
  /** Кто позвал: собственник отвечает за приглашённого */
  createdBy: text('created_by').notNull().references(() => appUser.id),
  /** Человекочитаемый код: его диктуют голосом, поэтому без похожих букв */
  code: text('code').notNull(),
  /** Пока только 'member': второго собственника запрещает индекс на привязке */
  role: text('role').notNull().default('member'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedBy: text('used_by').references(() => appUser.id),
  /** Отозвано собственником до того, как им воспользовались */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('invite_code_uq').on(t.code),
  index('invite_property_idx').on(t.propertyId),
]);

/**
 * Заявка жителя: «домом никто не занимается, подключите».
 *
 * ЗАЧЕМ. Дом без управляющей организации некому подключить изнутри:
 * председателя назначает УК, а УК нет. Это замкнутый круг, и разрывает
 * его только человек снаружи — оператор.
 *
 * ВИДА ЗАЯВКИ НЕТ НАМЕРЕННО. Житель всегда просит одно и то же, а что
 * это на самом деле — ТСЖ по ИНН, непосредственное управление или просто
 * назначить председателя — решает оператор, глядя на данные. Поле «вид»
 * пришлось бы заполнять тому, кто как раз и не знает ответа.
 */
/**
 * Отметка оператора «это событие я видел».
 *
 * Сами события не хранятся — они выводятся из данных (lib/admin/events.ts).
 * Здесь только память о просмотре, чтобы счётчик новых не показывал
 * одно и то же каждый день.
 */
export const operatorEventSeen = pgTable('operator_event_seen', {
  /** house_claim | unknown_house | no_org | orphan_request */
  kind: text('kind').notNull(),
  refId: text('ref_id').notNull(),
  seenBy: text('seen_by').notNull().references(() => admin.id),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('operator_event_seen_uq').on(t.kind, t.refId)]);

export const houseClaim = pgTable('house_claim', {
  id: id(),
  houseKey: text('house_key').notNull(),
  userId: text('user_id').notNull().references(() => appUser.id),
  note: text('note'),
  status: text('status').notNull().default('open'),  // open | done | rejected
  createdAt: createdAt(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: text('decided_by'),
}, (t) => [
  index('house_claim_status_idx').on(t.status, t.createdAt),
  /**
   * Одна открытая заявка от человека на дом.
   *
   * Иначе повторный тап по кнопке даёт оператору очередь из одинаковых
   * строк, и он разбирает не дома, а дубликаты.
   */
  uniqueIndex('house_claim_open_uq')
    .on(t.houseKey, t.userId)
    .where(sql`${t.status} = 'open'`),
]);

/* ─────────────── Подбор дома ─────────────── */

/**
 * Что рядом с домом: магазин, аптека, школа, детсад, остановка.
 *
 * Пишет только загрузчик набора (из выжимки OSM), регион заменяется
 * целиком. Лицензия ODbL: на экране обязательна подпись «© OpenStreetMap».
 */
export const poi = pgTable('poi', {
  id: id(),
  regionCode: text('region_code').notNull(),
  /** shop | pharmacy | school | kindergarten | stop */
  kind: text('kind').notNull(),
  name: text('name'),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
}, (t) => [
  index('poi_region_idx').on(t.regionCode),
  // Ближайшее ищется квадратом по координатам без вида — вид в индекс не входит
  index('poi_geo_idx').on(t.lat, t.lon),
]);

/**
 * ЗАГЛУШКА MVP: ЖК Ростова для показа подбора дома (docs/mock-complexes.md).
 *
 * Данные частично придуманы и в интерфейсе помечены «Примерные данные».
 * Пишет только `npm run mock:load`, целиком. Ни на что не ссылается —
 * убрать заглушку значит очистить таблицу (`mock:clear`), выпилить —
 * удалить таблицу миграцией вместе с lib/pick/mock/.
 * Непустая таблица включает режим заглушки в /api/pick/*.
 */
export const mockComplex = pgTable('mock_complex', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  microdistrict: text('microdistrict'),
  district: text('district'),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  developer: text('developer'),
  priceFrom: integer('price_from'),
  /** Примерная оплата ЖКУ, ₽ в месяц — придумана, как и цена */
  utilities: integer('utilities'),
  grocery: boolean('grocery').notNull().default(false),
  blurb: text('blurb'),
  tags: jsonb('tags').$type<string[]>().notNull(),
  reviews: jsonb('reviews').$type<{ name: string; flat: string; stars: number; plus: string; minus: string }[]>().notNull(),
  src: jsonb('src').$type<Record<string, string>>().notNull(),
  /** Внутренние написания для поиска («Грин Сайд» у «GreenSide»); наружу не отдаются */
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
});

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/**
 * Фото ЖК заглушки (docs/mock-complexes.md) — рендеры застройщиков
 * с подписью «© застройщик», решение владельца 29.09.2026.
 *
 * Отдельная таблица, а не колонка в mock_complex: Drizzle перечисляет
 * в SELECT все колонки, и карточка с «похожими ЖК» тащила бы мегабайты
 * картинок на каждый запрос. В базе, а не в томе вложений: у тома на бою
 * уже были проблемы с правами, а здесь `mock:clear` чистит всё разом.
 */
export const mockComplexPhoto = pgTable('mock_complex_photo', {
  slug: text('slug').primaryKey().references(() => mockComplex.slug, { onDelete: 'cascade' }),
  bytes: bytea('bytes').notNull(),
  mime: text('mime').notNull(),
  credit: text('credit').notNull(),
  sourceUrl: text('source_url').notNull(),
});

/**
 * Отзыв жителя о доме.
 *
 * Пишет только подтверждённый житель этого дома (уровень `full`),
 * один отзыв на человека и дом — правится, а не множится. Имени наружу
 * не отдаём никогда: «Житель дома, подтверждён».
 *
 * Удаления нет. Оператор может СКРЫТЬ отзыв с причиной (клевета,
 * персональные данные соседа) — запись в admin_action. Обращений
 * в УК это не касается: они не скрываются и не удаляются.
 */
export const houseReview = pgTable('house_review', {
  id: id(),
  houseKey: text('house_key').notNull().references(() => house.houseKey),
  userId: text('user_id').notNull().references(() => appUser.id),
  starsUk: integer('stars_uk').notNull(),
  starsClean: integer('stars_clean').notNull(),
  starsNeighbors: integer('stars_neighbors').notNull(),
  starsQuiet: integer('stars_quiet').notNull(),
  starsYard: integer('stars_yard').notNull(),
  pros: text('pros'),
  cons: text('cons'),
  hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  hiddenBy: text('hidden_by').references(() => admin.id),
  hiddenReason: text('hidden_reason'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('house_review_uq').on(t.houseKey, t.userId),
  index('house_review_house_idx').on(t.houseKey),
]);

/** «Мои дома» в подборе: сердечко на карточке */
export const houseFavorite = pgTable('house_favorite', {
  userId: text('user_id').notNull().references(() => appUser.id),
  houseKey: text('house_key').notNull().references(() => house.houseKey),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.houseKey] })]);

/**
 * Просьба оставить отзыв: когда житель её закрыл и писал ли ему бот.
 *
 * Закрытая карточка возвращается через 30 дней один раз; после второго
 * закрытия — никогда. Бот пишет один раз на человека и дом.
 */
export const reviewPrompt = pgTable('review_prompt', {
  userId: text('user_id').notNull().references(() => appUser.id),
  houseKey: text('house_key').notNull().references(() => house.houseKey),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  dismissCount: integer('dismiss_count').notNull().default(0),
  botSentAt: timestamp('bot_sent_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.userId, t.houseKey] })]);

/**
 * Черновик жалобы, подготовленный ботом MAX.
 *
 * Бот сам заявок не создаёт: он кладёт сюда переписанный текст и шлёт
 * кнопку, которая открывает форму жалобы уже заполненной. Отправляет
 * житель. В параметр запуска мини-приложения текст не помещается
 * (512 символов латиницей), поэтому в ссылке едет только id.
 *
 */
export const botDraft = pgTable('bot_draft', {
  id: id(),
  userId: text('user_id').notNull().references(() => appUser.id),
  propertyId: text('property_id').notNull().references(() => property.id),
  category: text('category').notNull(),
  text: text('text').notNull(),
  createdAt: createdAt(),
  /** Заявку по черновику отправили — второй раз форму им не заполняем */
  usedAt: timestamp('used_at', { withTimezone: true }),
}, (t) => [index('bot_draft_user_idx').on(t.userId)]);

/**
 * Короткая память бота: последние реплики разговора и выбранная квартира.
 *
 * Живёт 30 минут без сообщений: дольше человек уже говорит о другом,
 * а хранить переписку жителей мы не хотим. В историю идут только слова
 * жителя и распознанные намерения — ответы бота с суммами и адресами
 * в GigaChat не уходят.
 */
export const botDialog = pgTable('bot_dialog', {
  maxUserId: bigint('max_user_id', { mode: 'number' }).primaryKey(),
  state: jsonb('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Память разговора с Домовым в мини-приложении — как `bot_dialog`, но по
 * жителю, а не по аккаунту MAX: в браузере `max_user_id` может не быть.
 * Живёт сутки (уборка в lib/bot/handle.ts).
 */
export const assistantDialog = pgTable('assistant_dialog', {
  userId: text('user_id').primaryKey().references(() => appUser.id, { onDelete: 'cascade' }),
  state: jsonb('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Сообщения, которые бот не понял, — БЕЗ привязки к жителю.
 * Из них пополняются примеры в lib/bot/prompt.ts. Живут 30 дней.
 */
export const botMiss = pgTable('bot_miss', {
  id: id(),
  text: text('text').notNull(),
  /** Что вернула модель: unknown, сбой, «Не то» после ответа */
  reason: text('reason').notNull(),
  createdAt: createdAt(),
});

/**
 * Расход бота за день: `key` — `tokens` для всего бота или id жителя
 * для его сообщений. Дневной потолок токенов делит бесплатную квоту
 * на оставшиеся дни, чтобы её не сжёг один вечер.
 */
export const botUsage = pgTable('bot_usage', {
  day: text('day').notNull(),
  key: text('key').notNull(),
  count: integer('count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.day, t.key] })]);

/** Обработанные сообщения: MAX повторяет событие, если не дождался ответа. */
export const botSeen = pgTable('bot_seen', {
  mid: text('mid').primaryKey(),
  createdAt: createdAt(),
});

/* ─────────────── Демо-дом ─────────────── */

/**
 * Роль демо-дома — заранее заведённый персонаж.
 *
 * Эксперт «берёт» роль: `app_user.max_user_id` персонажа становится его
 * аккаунтом MAX, и дальше работает обычный вход. Держатель записан здесь,
 * чтобы экран ролей показал «занята · Иван П. · с 14:20».
 */
export const demoRole = pgTable('demo_role', {
  key: text('key').primaryKey(),
  userId: text('user_id').notNull().references(() => appUser.id),
  title: text('title').notNull(),
  subtitle: text('subtitle').notNull(),
  position: integer('position').notNull(),
  holderMaxUserId: bigint('holder_max_user_id', { mode: 'number' }),
  holderName: text('holder_name'),
  heldSince: timestamp('held_since', { withTimezone: true }),
});

/** Кто какую роль потерял — для плашки «Вашу роль передали» */
export const demoRelease = pgTable('demo_release', {
  id: id(),
  maxUserId: bigint('max_user_id', { mode: 'number' }).notNull(),
  roleKey: text('role_key').notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('demo_release_max_idx').on(t.maxUserId)]);

/**
 * Настройки сервиса, которые оператор меняет из кабинета без выкладки.
 * Сейчас одна: `demo_enabled` — показывать ли демо-дом на экране входа.
 */
export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
