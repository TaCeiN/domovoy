/**
 * Чтение выжимки OSM переехало в lib/dataset/osm-pbf.mjs: им пользуется
 * сборщик набора данных региона. Инструмент берёт тот же код, а не копию.
 */
export { scan } from '../../../lib/dataset/osm-pbf.mjs';
