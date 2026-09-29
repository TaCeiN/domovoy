/**
 * Геометрия подбора дома: рамка карты, расстояние, сетка кружков.
 *
 * Без PostGIS намеренно: домов в регионе сотни тысяч, точек окружения
 * десятки тысяч, и выборка квадратом по обычному индексу укладывается
 * в миллисекунды. Тащить расширение в свой Postgres ради этого незачем.
 */

export interface Point { lat: number; lon: number }
export interface Bbox { west: number; south: number; east: number; north: number }

/** Шире двух градусов карта просит приблизить: иначе в ответ уходит пол-области */
export const MAX_SPAN_DEG = 2;

const EARTH_M = 6_371_000;
const M_PER_DEG = 111_320;

export function parseBbox(raw: unknown): Bbox | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { west, south, east, north };
}

export function tooWide(box: Bbox): boolean {
  return box.east - box.west > MAX_SPAN_DEG || box.north - box.south > MAX_SPAN_DEG;
}

export function distanceM(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

/** Квадрат, в который вписан круг радиуса `meters`, — для выборки по индексу */
export function around(p: Point, meters: number): Bbox {
  const dLat = meters / M_PER_DEG;
  const dLon = meters / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180));
  return { west: p.lon - dLon, south: p.lat - dLat, east: p.lon + dLon, north: p.lat + dLat };
}

/** Клетка сетки кружков: треть плитки карты на этом масштабе, около 85 точек экрана */
export function cellDeg(zoom: number): number {
  return 360 / 2 ** zoom / 3;
}
