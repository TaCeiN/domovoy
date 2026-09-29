import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readCentralDirectory, entryDataOffset, type RangeFetch } from './zip-remote.ts';

/**
 * Zip собирается прямо в тесте: настоящий архив ГАР весит 57 ГБ,
 * а проверить нужно ровно разбор структур — обычных и zip64.
 */
function buildZip(files: { name: string; text: string }[], zip64: boolean): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.text, 'utf8');
    const data = deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name, extra);

    offset += 30 + name.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const tail: Buffer[] = [];

  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    tail.push(record, locator);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  tail.push(eocd);

  return Buffer.concat([...locals, cd, ...tail]);
}

const fetchFrom = (buf: Buffer): RangeFetch => async (start, end) => buf.subarray(start, end + 1);

for (const zip64 of [false, true]) {
  test(`оглавление и данные записи читаются кусками (zip64: ${zip64})`, async () => {
    const buf = buildZip([
      { name: '61/AS_HOUSES_1.XML', text: '<HOUSES><HOUSE ID="1" /></HOUSES>' },
      { name: '61/AS_ADDR_OBJ_1.XML', text: '<ADDRESSOBJECTS>ростов</ADDRESSOBJECTS>' },
    ], zip64);

    const entries = await readCentralDirectory(fetchFrom(buf), buf.length);
    assert.deepEqual(entries.map((e) => e.name), ['61/AS_HOUSES_1.XML', '61/AS_ADDR_OBJ_1.XML']);

    const second = entries[1];
    const start = await entryDataOffset(fetchFrom(buf), second);
    const text = inflateRawSync(buf.subarray(start, start + second.compressedSize)).toString('utf8');
    assert.equal(text, '<ADDRESSOBJECTS>ростов</ADDRESSOBJECTS>');
    assert.equal(second.size, Buffer.byteLength(text));
  });
}

test('не zip — понятная ошибка, а не падение на смещениях', async () => {
  const buf = Buffer.from('это не архив');
  await assert.rejects(readCentralDirectory(fetchFrom(buf), buf.length), /не zip/);
});
