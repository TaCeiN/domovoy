import { randomUUID } from 'node:crypto';

/**
 * Клиент открытой части ГИС ЖКХ.
 *
 * ЗАЧЕМ. Связку «дом → управляющая компания» нельзя взять из квитанции:
 * получатель платежа и управляющая организация — разные лица. Свет,
 * газ и вывоз мусора идут ресурсникам напрямую, а жилищную квитанцию
 * часто печатает расчётный центр. Проверено на живых данных: ИНН
 * ГУП РО «ИВЦ ЖКХ» в реестре управляющих организаций отсутствует вовсе.
 *
 * Поэтому связку берём там, где она есть по закону, — в сводном
 * федеральном реестре лицензий и реестре объектов жилищного фонда.
 *
 * ЧТО ЭТО ЗА API. Не документированный контракт, а внутренние вызовы
 * открытой части портала: те же, которыми ходит сам сайт. Авторизация
 * не нужна, но заголовки Session-GUID / Request-GUID / State-GUID
 * обязательны — без них портал отвечает 404, а не 401, и это выглядит
 * как «нет такого метода».
 *
 * Из этого следует режим использования: разовый импорт справочника,
 * а не запрос в момент входа жителя. Портал уйдёт на регламентные
 * работы — приложение обязано продолжать работать на своей копии.
 */

const BASE = 'https://dom.gosuslugi.ru';

/** Коды субъектов в ГИС ЖКХ — свои, не совпадают ни с КЛАДР, ни с ИНН. */
export const GIS_REGION_GUID: Record<string, string> = {
  '61': 'f10763dc-63e3-48db-83e1-9c566fe3092b', // Ростовская область
};

function headers(state = '/houses'): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': 'Mozilla/5.0',
    'Session-GUID': randomUUID(),
    'Request-GUID': randomUUID(),
    'State-GUID': state,
  };
}

export class GisError extends Error {
  // Поле объявлено явно: Node выполняет TypeScript срезанием типов
  // и не поддерживает свойства-параметры конструктора
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Запрос с повторами.
 *
 * Портал регулярно уходит на регламентные работы и отвечает то пустотой,
 * то таймаутом. Импорт длиной в сотни запросов обязан это переживать,
 * иначе он падает на середине и оставляет половину реестра.
 */
/**
 * Стоит ли повторять запрос.
 *
 * Повторяли ЛЮБУЮ ошибку, включая 404 и битый JSON, — то есть четыре
 * бесполезных захода на чужой портал вместо одного. Повторяем только то,
 * что действительно бывает временным: обрыв связи и ответы 5xx или 429.
 */
function worthRetrying(error: unknown): boolean {
  if (error instanceof GisError) return error.status >= 500 || error.status === 429;
  return !(error instanceof SyntaxError);
}

export async function post<T>(path: string, body: unknown, attempt = 1): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(BASE + path, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (response.status !== 200) {
      throw new GisError(`${response.status}: ${text.slice(0, 200)}`, response.status);
    }
    /**
     * Пустое тело при 200 — не «ничего не найдено», а отказ портала:
     * так он отвечает на частые запросы и на страницы глубже своего
     * предела выдачи. Пустой результат приходит как `{"items":[]}`.
     * Считаем это временной ошибкой, чтобы сработал повтор с паузой.
     */
    if (text.trim() === '') throw new GisError('200: пустой ответ портала', 503);
    return JSON.parse(text) as T;
  } catch (error) {
    if (attempt >= 4 || !worthRetrying(error)) throw error;
    // Пауза растёт: портал не любит частых повторов
    await new Promise((r) => setTimeout(r, attempt * 3000));
    return post<T>(path, body, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Короткое имя организации.
 *
 * Реестр лицензий отдаёт только полное, капсом и с расшифрованной формой:
 * «ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "УПРАВЛЯЮЩАЯ КОМПАНИЯ ТРИАНОН"».
 * Показывать такое жителю нельзя — в строке «ваш дом обслуживает» это
 * занимает три строки и кричит капсом.
 */
const LEGAL_FORMS: [RegExp, string][] = [
  [/ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ/gi, 'ООО'],
  [/АКЦИОНЕРНОЕ ОБЩЕСТВО/gi, 'АО'],
  [/ПУБЛИЧНОЕ АО/gi, 'ПАО'],
  [/ТОВАРИЩЕСТВО СОБСТВЕННИКОВ ЖИЛЬЯ/gi, 'ТСЖ'],
  [/ТОВАРИЩЕСТВО СОБСТВЕННИКОВ НЕДВИЖИМОСТИ/gi, 'ТСН'],
  [/ЖИЛИЩНО-СТРОИТЕЛЬНЫЙ КООПЕРАТИВ/gi, 'ЖСК'],
  [/ЖИЛИЩНЫЙ КООПЕРАТИВ/gi, 'ЖК'],
  [/МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ/gi, 'МУП'],
  [/УНИТАРНОЕ МУНИЦИПАЛЬНОЕ ПРЕДПРИЯТИЕ/gi, 'МУП'],
  [/ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ/gi, 'ГУП'],
  [/УПРАВЛЯЮЩАЯ КОМПАНИЯ/gi, 'УК'],
  [/УПРАВЛЯЮЩАЯ ОРГАНИЗАЦИЯ/gi, 'УО'],
];

export function shortenOrgName(full: string): string {
  let name = full.trim();
  for (const [pattern, short] of LEGAL_FORMS) name = name.replace(pattern, short);

  /**
   * Капс приводим к обычному письму, но аббревиатуры не трогаем: «ООО»,
   * «УК», «ЖСК» пишутся заглавными, а «ТРИАНОН» — нет.
   */
  return name
    .split(/(\s+|"|«|»)/)
    .map((part) => {
      if (!/\p{Lu}/u.test(part)) return part;
      if (part.length <= 4 && part === part.toUpperCase()) return part;
      if (part !== part.toUpperCase()) return part;
      return part.charAt(0) + part.slice(1).toLocaleLowerCase('ru');
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface GisLicense {
  guid: string;
  licenseNumber: string | null;
  status: string | null;
  houseCount: number;
  licensee: {
    name: string;
    shortName?: string | null;
    inn: string;
    kpp?: string | null;
    ogrn?: string | null;
    phone?: string | null;
  };
}

/** Лицензии региона: это и есть список управляющих организаций. */
export async function fetchLicenses(
  regionGuid: string,
  pageIndex: number,
  perPage = 100,
): Promise<{ total: number; items: GisLicense[] }> {
  const data = await post<{ total: number; items: GisLicense[] }>(
    '/rls/api/rest/services/license/public/search',
    {
      pageIndex,
      elementsPerPage: perPage,
      licenseStatuses: [],
      houseStatuses: [],
      address: { regionCode: regionGuid },
    },
  );
  return { total: data.total ?? 0, items: data.items ?? [] };
}

/**
 * Идентификатор организации в ГИС ЖКХ по ИНН.
 *
 * Отдельный шаг, потому что guid из карточки лицензии для реестра домов
 * не подходит: проверено, оба идентификатора лицензиата дают ноль домов,
 * а guid из справочника организаций — 67 домов у той же компании.
 *
 * БЕЗ ФИЛЬТРА ПО СТАТУСУ И РОЛЯМ. Сайт ищет только среди действующих
 * организаций с подтверждённой ролью, и на этом терялась треть реестра:
 * 245 компаний из 733. Проверено поимённо — у заблокированных дома есть
 * и жители в них живут: ООО УО «Ростовгарант» (BLOCKED) — 9 домов,
 * ООО УК «Результат» (BLOCKED) — 31 дом. Отбрасывать их значит оставить
 * этих жителей без управляющей компании в приложении.
 */
/**
 * Организация из справочника ГИС ЖКХ — тем же поиском находятся и УК,
 * и ТСЖ, и ЖСК: справочник организаций не фильтрует по типу управления,
 * лицензия нужна только УК.
 */
export interface GisOrgInfo {
  guid: string;
  /** ИНН из справочника. Поиск домов его не отдаёт вовсе — только ОГРН */
  inn: string | null;
  status: string | null;
  /** Полное имя. Справочник отдаёт его почти всегда — на пустой случай есть запасной путь у вызывающего */
  name: string | null;
  shortName: string | null;
  kpp: string | null;
  ogrn: string | null;
}

export async function findOrg(query: string): Promise<GisOrgInfo | null> {
  type OrgHit = {
    organizationGuid?: string; guid?: string; inn?: string;
    status?: string; organizationStatus?: string;
    fullName?: string; name?: string; shortName?: string;
    kpp?: string; ogrn?: string;
  };

  // Справочник организаций отвечает то объектом с items, то голым массивом —
  // на этом импорт молча привозил ноль домов при живом ответе портала
  const data = await post<{ items?: OrgHit[] } | OrgHit[]>(
    '/ppa/api/rest/services/ppa/organizations/chooser/search;page=1;itemsPerPage=10',
    {
      sortCriteriaList: [{ sortedBy: 'organizationType', ascending: false }],
      // Фильтра по статусу нет намеренно: на нём терялась треть реестра
      organizationTypes: { coll: ['B', 'L', 'A'], operand: 'OR' },
      subordinationOrgTypeList: { coll: ['HEAD', 'BRANCH'], operand: 'OR' },
      commonSearchString: query,
      pageIndex: 1,
      elementsPerPage: 10,
    },
  );

  const items: OrgHit[] = Array.isArray(data) ? data : (data.items ?? []);
  // Ищут и по ИНН, и по ОГРН: у дома в ГИС ЖКХ ИНН управляющей организации нет
  const exact = items.find((x) => x.inn === query || x.ogrn === query) ?? items[0];
  if (!exact) return null;

  const guid = exact.organizationGuid ?? exact.guid;
  if (!guid) return null;

  return {
    guid,
    inn: exact.inn ?? null,
    status: exact.status ?? exact.organizationStatus ?? null,
    name: exact.fullName ?? exact.name ?? null,
    shortName: exact.shortName ?? null,
    kpp: exact.kpp ?? null,
    ogrn: exact.ogrn ?? null,
  };
}

export interface GisHouse {
  houseGuid: string | null;
  address: string;
  flatCount: number | null;
}

/** Дома организации из реестра объектов жилищного фонда. */
export async function fetchHouses(
  orgGuid: string,
  pageIndex: number,
  perPage = 100,
): Promise<{ total: number; items: GisHouse[] }> {
  const data = await post<{
    total: number;
    items: {
      houseGuid?: string;
      address?: { formattedAddress?: string };
      residentialPremiseCount?: string | number | null;
    }[];
  }>(
    `/homemanagement/api/rest/services/houses/public/searchByOrg?pageIndex=${pageIndex}&elementsPerPage=${perPage}`,
    { organizationGuid: orgGuid, calcCount: true, useReadOnlyDataSource: true },
  );

  return {
    total: data.total ?? 0,
    items: (data.items ?? [])
      .map((x) => ({
        houseGuid: x.houseGuid ?? null,
        address: x.address?.formattedAddress ?? '',
        flatCount: x.residentialPremiseCount != null ? Number(x.residentialPremiseCount) : null,
      }))
      .filter((x) => x.address),
  };
}
