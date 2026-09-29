/**
 * Квартиры в доме — ссылками, а не цифрами.
 *
 * Цены с площадок объявлений у себя не показываем: их правила запрещают
 * забирать данные, а договорного доступа у нас нет. Человек сам открывает
 * поиск площадки по адресу дома — так же, как в «Вызове мастера».
 */

export interface Listing { site: 'avito' | 'cian' | 'domclick' | 'yandex'; label: string; url: string }

/**
 * НЕ ПРОВЕРЕНО ВЖИВУЮ (23.09.2026): площадки закрыты для зарубежного IP
 * машины разработки, Авито требует пройти проверку на бота. Открыть каждую
 * ссылку с российского IP; если площадка не понимает адрес в запросе —
 * заменить её шаблон ссылкой на раздел продажи квартир без запроса.
 */
const TEMPLATES: { site: Listing['site']; label: string; url: (q: string) => string }[] = [
  { site: 'avito', label: 'Авито', url: (q) => `https://www.avito.ru/all/kvartiry/prodam?q=${q}` },
  { site: 'cian', label: 'ЦИАН', url: (q) => `https://www.cian.ru/cat.php?deal_type=sale&engine_version=2&offer_type=flat&text=${q}` },
  { site: 'domclick', label: 'Домклик', url: (q) => `https://domclick.ru/search?deal_type=sale&category=living&offer_type=flat&address=${q}` },
  { site: 'yandex', label: 'Яндекс Недвижимость', url: (q) => `https://realty.yandex.ru/rossiya/kupit/kvartira/?text=${q}` },
];

/** Площадки ищут «город, улица, дом»: область, район и сокращения «г», «д.» им мешают */
export function searchAddress(address: string): string {
  return address
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^(обл|край|респ|р-н|АО|аобл)(\s|\.|$)/i.test(part))
    .map((part) => part.replace(/^(г|д\.)\s+/i, ''))
    .join(', ');
}

export function listingLinks(address: string): Listing[] {
  const q = encodeURIComponent(searchAddress(address));
  return TEMPLATES.map((t) => ({ site: t.site, label: t.label, url: t.url(q) }));
}
