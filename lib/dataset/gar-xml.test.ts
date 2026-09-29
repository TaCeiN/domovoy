import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGarTags } from './gar-xml.ts';

async function* chunks(parts: (string | Buffer)[]) {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
}

async function collect(parts: (string | Buffer)[], tag: string) {
  const out: Record<string, string>[] = [];
  for await (const row of readGarTags(chunks(parts), tag)) out.push(row);
  return out;
}

test('теги, разрезанные между кусками, собираются целиком', async () => {
  const xml = '﻿<?xml version="1.0" encoding="utf-8"?><HOUSES>'
    + '<HOUSE ID="1" HOUSENUM="7а" ISACTUAL="1" />'
    + '<HOUSE ID="2" HOUSENUM="&quot;Б&quot; &amp; В" ISACTUAL="0" /></HOUSES>';

  // Режем по каждым семи байтам: попадём и в середину тега, и в середину буквы
  const bytes = Buffer.from(xml, 'utf8');
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 7) parts.push(bytes.subarray(i, i + 7));

  const rows = await collect(parts, 'HOUSE');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ID: '1', HOUSENUM: '7а', ISACTUAL: '1' });
  assert.equal(rows[1].HOUSENUM, '"Б" & В');
});

test('теги с похожим именем не попадают в выборку', async () => {
  const rows = await collect(['<HOUSETYPES><HOUSETYPE ID="2" /><HOUSE ID="9" /></HOUSETYPES>'], 'HOUSE');
  assert.deepEqual(rows, [{ ID: '9' }]);
});
