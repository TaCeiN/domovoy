import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHouseParams } from './gar-params.ts';

async function* once(text: string) { yield Buffer.from(text, 'utf8'); }

const XML = `<PARAMS>
  <PARAM ID="1" OBJECTID="10" TYPEID="8" VALUE="61:14:0040140:39" STARTDATE="2014-01-01" ENDDATE="2079-06-06" />
  <PARAM ID="2" OBJECTID="10" TYPEID="19" VALUE="1" STARTDATE="2020-01-01" ENDDATE="2079-06-06" />
  <PARAM ID="3" OBJECTID="11" TYPEID="8" VALUE="61:14:0000000:1" STARTDATE="2010-01-01" ENDDATE="2015-01-01" />
  <PARAM ID="4" OBJECTID="11" TYPEID="8" VALUE="61:14:0040120:143" STARTDATE="2015-01-01" ENDDATE="2079-06-06" />
  <PARAM ID="5" OBJECTID="12" TYPEID="5" VALUE="346720" STARTDATE="2010-01-01" ENDDATE="2079-06-06" />
  <PARAM ID="6" OBJECTID="13" TYPEID="19" VALUE="0" STARTDATE="2010-01-01" ENDDATE="2079-06-06" />
</PARAMS>`;

test('кадастровый номер и признак МКД — только действующие значения', async () => {
  const params = await readHouseParams(once(XML), '2026-09-17');
  assert.equal(params.cadastral.get(10), '61:14:0040140:39');
  assert.equal(params.cadastral.get(11), '61:14:0040120:143', 'закрытое значение не перетирает действующее');
  assert.deepEqual([...params.mkd], [10], 'значение 0 — не многоквартирный');
  assert.equal(params.cadastral.has(12), false, 'почтовый индекс не нужен');
});

test('параметры сериализуются и читаются обратно для кэша', async () => {
  const params = await readHouseParams(once(XML), '2026-09-17');
  const { fromJson, toJson } = await import('./gar-params.ts');
  const back = fromJson(toJson(params));
  assert.deepEqual([...back.cadastral], [...params.cadastral]);
  assert.deepEqual([...back.mkd], [...params.mkd]);
});
