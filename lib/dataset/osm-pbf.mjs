import { createReadStream } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PbfReader } from 'pbf';

/**
 * Чтение выжимки OpenStreetMap в формате .osm.pbf.
 *
 * ЗАЧЕМ, ЕСЛИ БЫЛ Overpass. Overpass отвечает на запросы, и за это берёт
 * лимитами: сначала 429, потом перестаёт пускать вовсе — область
 * выкачивалась районами по одному и встала на четвёртом из пятидесяти пяти.
 * Файловая выжимка Geofabrik по Южному федеральному округу весит 298 МБ
 * и качается за полминуты одним куском. Лимитов у неё нет никаких,
 * и на другой машине повторится ровно так же.
 *
 * Разбираем только то, что нужно: ломаные с тегами и координаты узлов.
 * Полноценной библиотеки OSM здесь нет и не нужно.
 */

/* ─────────────── строение файла ─────────────── */

/**
 * Файл — цепочка блоков. Перед каждым: четыре байта длины заголовка,
 * сам заголовок (тип и размер данных), затем данные, сжатые zlib.
 *
 * Читаем потоком, а не целиком: 298 МБ в память класть незачем, а после
 * распаковки было бы ещё больше.
 */
async function* blobs(path) {
  const stream = createReadStream(path);
  let buffer = Buffer.alloc(0);

  /**
   * Ждём, пока в буфере накопится нужное число байт.
   *
   * Слушателей снимаем ОБА, а не только сработавший. Иначе на каждое
   * ожидание к потоку добавляется «end», который так и не наступает,
   * и за проход по файлу их набираются тысячи — Node справедливо ругается
   * на утечку.
   */
  const need = async (bytes) => {
    while (buffer.length < bytes) {
      const chunk = stream.read();

      if (chunk === null) {
        const more = await new Promise((resolve) => {
          const onReadable = () => { stream.off('end', onEnd); resolve(true); };
          const onEnd = () => { stream.off('readable', onReadable); resolve(false); };

          stream.once('readable', onReadable);
          stream.once('end', onEnd);
        });
        if (!more) return false;
        continue;
      }

      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    }
    return true;
  };

  const take = (bytes) => {
    const head = buffer.subarray(0, bytes);
    buffer = buffer.subarray(bytes);
    return head;
  };

  while (await need(4)) {
    const headerLength = take(4).readUInt32BE(0);
    if (!await need(headerLength)) return;

    const header = readBlobHeader(new PbfReader(take(headerLength)));
    if (!await need(header.datasize)) return;

    const blob = readBlob(new PbfReader(take(header.datasize)));
    // Данные бывают и несжатыми, хотя на практике всегда zlib
    yield { type: header.type, data: blob.zlib ? inflateSync(blob.zlib) : blob.raw };
  }
}

function readBlobHeader(pbf) {
  const out = { type: '', datasize: 0 };

  pbf.readFields((tag, o, p) => {
    if (tag === 1) o.type = p.readString();
    else if (tag === 3) o.datasize = p.readVarint();
  }, out);

  return out;
}

function readBlob(pbf) {
  const out = { raw: null, zlib: null };

  pbf.readFields((tag, o, p) => {
    if (tag === 1) o.raw = p.readBytes();
    else if (tag === 3) o.zlib = p.readBytes();
  }, out);

  return out;
}

/* ─────────────── блок с данными ─────────────── */

/**
 * Координаты хранятся целыми числами с общим шагом и смещением на блок:
 * градус = 1e-9 × (смещение + шаг × значение). Шаг по умолчанию 100,
 * то есть сто нанноградусов — около сантиметра.
 */
function readPrimitiveBlock(data) {
  const block = { strings: [], groups: [], granularity: 100, latOffset: 0, lonOffset: 0 };

  new PbfReader(data).readFields((tag, b, p) => {
    if (tag === 1) b.strings = readStringTable(p.readBytes());
    else if (tag === 2) b.groups.push(p.readBytes());
    else if (tag === 17) b.granularity = p.readVarint();
    else if (tag === 19) b.latOffset = p.readVarint(true);
    else if (tag === 20) b.lonOffset = p.readVarint(true);
  }, block);

  return block;
}

function readStringTable(data) {
  const strings = [];
  new PbfReader(data).readFields((tag, s, p) => { if (tag === 1) s.push(p.readString()); }, strings);
  return strings;
}

/**
 * Разбор одной группы.
 *
 * Узлы лежат «плотно»: идентификаторы и координаты записаны разницами
 * с предыдущим, а теги — сплошным списком с нулём-разделителем между
 * узлами. Ломаные проще: свои теги и список номеров узлов, тоже разницами.
 */
function readGroup(data, block, onNode, onWay, onRelation) {
  new PbfReader(data).readFields((tag, _, p) => {
    if (tag === 2 && onNode) readDenseNodes(p.readBytes(), block, onNode);
    else if (tag === 3 && onWay) readWay(p.readBytes(), block, onWay);
    else if (tag === 4 && onRelation) readRelation(p.readBytes(), block, onRelation);
  }, null);
}

function readDenseNodes(data, block, onNode) {
  const dense = { ids: [], lats: [], lons: [], keysVals: [] };

  new PbfReader(data).readFields((tag, d, p) => {
    if (tag === 1) p.readPackedSVarint(d.ids);
    else if (tag === 8) p.readPackedSVarint(d.lats);
    else if (tag === 9) p.readPackedSVarint(d.lons);
    else if (tag === 10) p.readPackedVarint(d.keysVals);
  }, dense);

  let id = 0;
  let lat = 0;
  let lon = 0;
  let at = 0;

  for (let i = 0; i < dense.ids.length; i++) {
    id += dense.ids[i];
    lat += dense.lats[i];
    lon += dense.lons[i];

    // Теги узла идут парами «ключ, значение» до нуля; ноль — конец узла
    let tags = null;
    while (at < dense.keysVals.length && dense.keysVals[at] !== 0) {
      (tags ??= {})[block.strings[dense.keysVals[at]]] = block.strings[dense.keysVals[at + 1]];
      at += 2;
    }
    at++;

    onNode(
      id,
      1e-9 * (block.latOffset + block.granularity * lat),
      1e-9 * (block.lonOffset + block.granularity * lon),
      tags,
    );
  }
}

function readWay(data, block, onWay) {
  const way = { id: 0, keys: [], vals: [], refs: [] };

  new PbfReader(data).readFields((tag, w, p) => {
    if (tag === 1) w.id = p.readVarint();
    else if (tag === 2) p.readPackedVarint(w.keys);
    else if (tag === 3) p.readPackedVarint(w.vals);
    else if (tag === 8) p.readPackedSVarint(w.refs);
  }, way);

  const tags = {};
  for (let i = 0; i < way.keys.length; i++) tags[block.strings[way.keys[i]]] = block.strings[way.vals[i]];

  let ref = 0;
  const refs = way.refs.map((delta) => (ref += delta));

  onWay(way.id, tags, refs);
}

/**
 * Отношение — дом со сложным контуром: несколько ломаных, собранных
 * в одно здание. Таких в области около трёх процентов, и без них
 * настоящие дома выпадают с карты.
 *
 * Нужны только теги и номера ломаных-частей: координаты возьмём
 * у первой части, центр контура для точки на карте не нужен.
 */
function readRelation(data, block, onRelation) {
  const rel = { id: 0, keys: [], vals: [], memids: [], types: [] };

  new PbfReader(data).readFields((tag, r, p) => {
    if (tag === 1) r.id = p.readVarint();
    else if (tag === 2) p.readPackedVarint(r.keys);
    else if (tag === 3) p.readPackedVarint(r.vals);
    else if (tag === 9) p.readPackedSVarint(r.memids);
    else if (tag === 10) p.readPackedVarint(r.types);
  }, rel);

  const tags = {};
  for (let i = 0; i < rel.keys.length; i++) tags[block.strings[rel.keys[i]]] = block.strings[rel.vals[i]];

  // Номера участников тоже записаны разницами, и отдельно — их тип: 1 это ломаная
  let id = 0;
  const ways = [];
  for (let i = 0; i < rel.memids.length; i++) {
    id += rel.memids[i];
    if (rel.types[i] === 1) ways.push(id);
  }

  onRelation(rel.id, tags, ways);
}

/* ─────────────── обход файла ─────────────── */

/**
 * Один проход по файлу.
 *
 * Проходов нужно два, и это не расточительство: чтобы поставить дом
 * на карту, надо знать координаты его узлов, а какие узлы нужны —
 * выясняется только после чтения ломаных. Держать в памяти координаты
 * всех узлов округа нельзя, их десятки миллионов; номера нужных узлов —
 * около полутора сотен тысяч, и они помещаются легко.
 */
export async function scan(path, { onNode, onWay, onRelation }) {
  for await (const blob of blobs(path)) {
    if (blob.type !== 'OSMData') continue;

    const block = readPrimitiveBlock(blob.data);
    for (const group of block.groups) readGroup(group, block, onNode, onWay, onRelation);
  }
}
