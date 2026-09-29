/**
 * Файл набора заглушки ЖК: что в нём лежит и как его проверить.
 *
 * ЗАГЛУШКА MVP (docs/mock-complexes.md). Названия, адреса, застройщики
 * и координаты — настоящие, где удалось проверить; цены, отзывы, метки
 * и описание придуманы. Откуда каждое поле — в `src`.
 */

export type MockSource = 'osm' | 'web' | 'mock';

export interface MockReview { name: string; flat: string; stars: number; plus: string; minus: string }

export interface MockComplex {
  slug: string;
  name: string;
  address: string;
  microdistrict: string | null;
  district: string | null;
  lat: number;
  lon: number;
  developer: string | null;
  priceFrom: number | null;
  /** Примерная оплата ЖКУ за квартиру, ₽ в месяц — придумана, как и цена (`src: mock`) */
  utilities?: number | null;
  grocery: boolean;
  blurb: string | null;
  tags: string[];
  reviews: MockReview[];
  /** Внутренние написания для поиска («Грин Сайд» у «GreenSide»); на экран не выводятся */
  aliases?: string[];
  /** Рендер застройщика: файл лежит рядом с JSON в релизе; на экране — подпись credit */
  photo?: { file: string; credit: string; sourceUrl: string };
  src: Record<string, MockSource>;
}

export interface MockFile { version: 1; region: string; builtAt: string; complexes: MockComplex[] }

export const MOCK_SLUG = /^[a-z0-9-]{1,60}$/;

/** Ростовская область с запасом: точка за её пределами — опечатка в координатах */
const BOX = { south: 45.9, north: 50.3, west: 38.2, east: 44.4 };
const SOURCES: readonly string[] = ['osm', 'web', 'mock'];

const str = (v: unknown, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optStr = (v: unknown, max = 200) => v === null || v === undefined || str(v, max);

export function parseMockFile(raw: unknown): { ok: true; file: MockFile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const f = raw as Partial<MockFile> | null;
  if (!f || f.version !== 1 || !Array.isArray(f.complexes)) {
    return { ok: false, errors: ['Это не файл заглушки ЖК: нужны version: 1 и complexes'] };
  }
  if (f.complexes.length === 0) return { ok: false, errors: ['В файле нет ни одного ЖК'] };

  const seen = new Set<string>();
  f.complexes.forEach((c: MockComplex, i) => {
    const at = `ЖК ${i + 1}${typeof c?.name === 'string' ? ` (${c.name})` : ''}`;
    const bad = (what: string) => errors.push(`${at}: ${what}`);

    if (typeof c?.slug !== 'string' || !MOCK_SLUG.test(c.slug)) bad('slug — латиница, цифры и дефис');
    else if (seen.has(c.slug)) bad(`повтор slug «${c.slug}»`);
    else seen.add(c.slug);

    if (!str(c?.name) || !str(c?.address)) bad('нужны name и address');
    if (!optStr(c?.microdistrict) || !optStr(c?.district) || !optStr(c?.developer) || !optStr(c?.blurb, 300)) {
      bad('microdistrict, district, developer, blurb — строка или null');
    }
    const inBox = typeof c?.lat === 'number' && typeof c?.lon === 'number'
      && c.lat >= BOX.south && c.lat <= BOX.north && c.lon >= BOX.west && c.lon <= BOX.east;
    if (!inBox) bad('координаты вне Ростовской области');

    if (!(c?.priceFrom === null || (Number.isInteger(c?.priceFrom) && c.priceFrom! > 0))) bad('priceFrom — целое больше нуля или null');
    if (!(c?.utilities === undefined || c.utilities === null || (Number.isInteger(c.utilities) && c.utilities > 0))) {
      bad('utilities — целое число рублей больше нуля или null');
    }
    if (typeof c?.grocery !== 'boolean') bad('grocery — true или false');
    if (!Array.isArray(c?.tags) || c.tags.length > 6 || !c.tags.every((t) => str(t, 60))) bad('tags — до 6 строк');
    const aliasesOk = c?.aliases === undefined
      || (Array.isArray(c.aliases) && c.aliases.length <= 5 && c.aliases.every((a) => str(a, 60)));
    if (!aliasesOk) bad('aliases — до 5 строк по 60 знаков');

    const photoOk = c?.photo === undefined || (
      typeof c.photo?.file === 'string' && /^[a-z0-9-]+\.(webp|jpe?g|png)$/.test(c.photo.file)
      && str(c.photo?.credit, 120) && typeof c.photo?.sourceUrl === 'string' && /^https:\/\//.test(c.photo.sourceUrl));
    if (!photoOk) bad('photo — { file: имя.webp|jpg|png, credit, sourceUrl https }');

    const reviewsOk = Array.isArray(c?.reviews) && c.reviews.length > 0 && c.reviews.length <= 8
      && c.reviews.every((r) => str(r?.name, 40) && str(r?.flat, 10) && Number.isInteger(r?.stars)
        && r.stars >= 1 && r.stars <= 5 && str(r?.plus, 300) && str(r?.minus, 300));
    if (!reviewsOk) bad('reviews — от 1 до 8 отзывов, звёзды 1–5, заполнены name, flat, plus, minus');

    const srcOk = c?.src && typeof c.src === 'object' && Object.values(c.src).every((s) => SOURCES.includes(s));
    if (!srcOk) bad('src — у каждого поля osm, web или mock');
  });

  return errors.length ? { ok: false, errors } : { ok: true, file: f as MockFile };
}
