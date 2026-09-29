import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

/**
 * Чтение одной записи из удалённого zip, не скачивая архив.
 *
 * ЗАЧЕМ. ГАР ФНС выкладывается одним архивом на всю страну — 57 ГБ,
 * а региону нужны четыре файла на три сотни мегабайт. Сервер ФНС отдаёт
 * файл кусками (`Accept-Ranges: bytes`), и zip позволяет этим
 * воспользоваться: оглавление лежит в хвосте, по нему видно, где начинается
 * каждая запись. Два запроса на оглавление и по одному на файл —
 * вместо часов закачки и полусотни гигабайт на диске.
 *
 * Архив больше 4 ГБ, значит zip64: размеры и смещения в обычных полях
 * равны 0xFFFFFFFF, а настоящие значения лежат в дополнительном поле.
 */

/** Байты с `start` по `end` включительно — как в заголовке Range */
export type RangeFetch = (start: number, end: number) => Promise<Uint8Array>;

export interface ZipEntry {
  name: string;
  /** 0 — без сжатия, 8 — deflate */
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

function lastIndexOfSignature(buf: Buffer, signature: number): number {
  for (let i = buf.length - 4; i >= 0; i--) {
    if (buf.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

export async function readCentralDirectory(fetchRange: RangeFetch, totalSize: number): Promise<ZipEntry[]> {
  // Хвост: 22 байта записи конца архива плюс комментарий до 65 535 байт
  const tailStart = Math.max(0, totalSize - 65_557);
  const tail = Buffer.from(await fetchRange(tailStart, totalSize - 1));

  const eocd = lastIndexOfSignature(tail, EOCD);
  if (eocd < 0 || tail.length - eocd < 22) throw new Error('это не zip: нет записи конца архива');

  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (cdSize === MAX32 || cdOffset === MAX32) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) {
      throw new Error('это не zip: оглавление zip64 не найдено');
    }
    const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
    const record = Buffer.from(await fetchRange(recordOffset, recordOffset + 55));
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('это не zip: испорчена запись zip64');
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }

  const cd = Buffer.from(await fetchRange(cdOffset, cdOffset + cdSize - 1));
  const entries: ZipEntry[] = [];
  let p = 0;

  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CENTRAL) {
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLength);

    /**
     * Дополнительное поле zip64 перечисляет ТОЛЬКО переполненные значения
     * и строго в порядке: размер, сжатый размер, смещение. Читать все три
     * подряд нельзя — у небольшого файла внутри огромного архива там одно
     * смещение.
     */
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const length = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === MAX32) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === MAX32) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (localHeaderOffset === MAX32) { localHeaderOffset = Number(cd.readBigUInt64LE(q)); }
      }
      e += 4 + length;
    }

    entries.push({ name, method, compressedSize, size, localHeaderOffset });
    p = extraEnd + commentLength;
  }

  return entries;
}

/**
 * Где начинаются данные записи.
 *
 * Длины имени и дополнительного поля в локальном заголовке бывают
 * другими, чем в оглавлении, — поэтому читаем сам заголовок.
 */
export async function entryDataOffset(fetchRange: RangeFetch, entry: ZipEntry): Promise<number> {
  const header = Buffer.from(await fetchRange(entry.localHeaderOffset, entry.localHeaderOffset + 29));
  if (header.readUInt32LE(0) !== LOCAL) throw new Error(`испорчен заголовок записи ${entry.name}`);
  return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

export function httpRange(url: string) {
  async function get(start: number, end: number): Promise<Response> {
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`сервер не отдаёт файл кусками: ответ ${response.status} на ${url}`);
    }
    return response;
  }

  return {
    fetchRange: (async (start, end) => new Uint8Array(await (await get(start, end)).arrayBuffer())) as RangeFetch,

    async size(): Promise<number> {
      const response = await fetch(url, { method: 'HEAD' });
      const length = Number(response.headers.get('content-length'));
      if (!response.ok || !length) throw new Error(`не удалось узнать размер ${url}: ${response.status}`);
      return length;
    },

    async stream(start: number, end: number): Promise<ReadableStream<Uint8Array>> {
      const response = await get(start, end);
      if (!response.body) throw new Error(`пустой ответ на ${url}`);
      return response.body;
    },
  };
}

/** Распакованный поток одной записи удалённого архива. */
export async function openEntryStream(url: string, entry: ZipEntry): Promise<NodeJS.ReadableStream> {
  const remote = httpRange(url);
  const start = await entryDataOffset(remote.fetchRange, entry);
  const body = Readable.fromWeb(
    await remote.stream(start, start + entry.compressedSize - 1) as import('node:stream/web').ReadableStream,
  );

  if (entry.method === 0) return body;
  if (entry.method !== 8) throw new Error(`неизвестный способ сжатия ${entry.method} у ${entry.name}`);
  return body.pipe(createInflateRaw());
}
