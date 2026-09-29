import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGarRegion, type GarFileKind } from './gar.ts';

const ACTIVE = 'ISACTUAL="1" ISACTIVE="1"';

const FILES: Record<GarFileKind, string> = {
  ADDR_OBJ: `<ADDRESSOBJECTS>
    <OBJECT OBJECTID="1" OBJECTGUID="g-region" NAME="Ростовская" TYPENAME="обл." LEVEL="1" ${ACTIVE} />
    <OBJECT OBJECTID="2" OBJECTGUID="g-city" NAME="Аксай" TYPENAME="г." LEVEL="5" ${ACTIVE} />
    <OBJECT OBJECTID="2" OBJECTGUID="g-city" NAME="Аксай старый" TYPENAME="г" LEVEL="5" ISACTUAL="0" ISACTIVE="0" />
    <OBJECT OBJECTID="3" OBJECTGUID="g-street" NAME="Объездная" TYPENAME="ул." LEVEL="8" ${ACTIVE} />
  </ADDRESSOBJECTS>`,
  HOUSES: `<HOUSES>
    <HOUSE OBJECTID="10" OBJECTGUID="h-10" HOUSENUM="7" HOUSETYPE="2" ADDNUM1="1" ADDTYPE1="1" ${ACTIVE} />
    <HOUSE OBJECTID="11" OBJECTGUID="h-11" HOUSENUM="9" HOUSETYPE="4" ${ACTIVE} />
    <HOUSE OBJECTID="12" OBJECTGUID="h-12" HOUSENUM="11" HOUSETYPE="2" ISACTUAL="0" ISACTIVE="0" />
  </HOUSES>`,
  APARTMENTS: `<APARTMENTS>
    <APARTMENT OBJECTID="100" NUMBER="1" APARTTYPE="2" ${ACTIVE} />
    <APARTMENT OBJECTID="101" NUMBER="2" APARTTYPE="2" ${ACTIVE} />
    <APARTMENT OBJECTID="102" NUMBER="3" APARTTYPE="1" ${ACTIVE} />
    <APARTMENT OBJECTID="103" NUMBER="4" APARTTYPE="2" ISACTUAL="0" ISACTIVE="0" />
  </APARTMENTS>`,
  ADM_HIERARCHY: `<ITEMS>
    <ITEM OBJECTID="2" PARENTOBJID="1" ISACTIVE="1" PATH="1.2" />
    <ITEM OBJECTID="3" PARENTOBJID="2" ISACTIVE="1" PATH="1.2.3" />
    <ITEM OBJECTID="10" PARENTOBJID="3" ISACTIVE="1" PATH="1.2.3.10" />
    <ITEM OBJECTID="10" PARENTOBJID="2" ISACTIVE="0" PATH="1.2.10" />
    <ITEM OBJECTID="100" PARENTOBJID="10" ISACTIVE="1" PATH="1.2.3.10.100" />
    <ITEM OBJECTID="101" PARENTOBJID="10" ISACTIVE="1" PATH="1.2.3.10.101" />
    <ITEM OBJECTID="102" PARENTOBJID="10" ISACTIVE="1" PATH="1.2.3.10.102" />
    <ITEM OBJECTID="103" PARENTOBJID="10" ISACTIVE="1" PATH="1.2.3.10.103" />
  </ITEMS>`,
};

async function* once(text: string) { yield Buffer.from(text, 'utf8'); }

test('в модель попадают только действующие записи и жилые типы домов', async () => {
  const region = await readGarRegion((kind) => once(FILES[kind]));

  assert.equal(region.objects.get(2)?.name, 'Аксай', 'устаревшая версия объекта не перетирает действующую');
  assert.equal(region.regionObjectId, 1);
  assert.deepEqual(region.houses.map((h) => h.guid), ['h-10'], 'гараж и снятый с учёта дом не попадают');
  assert.deepEqual(region.houses[0], {
    objectId: 10, guid: 'h-10', num: '7', houseType: 2,
    add1: '1', addType1: 1, add2: null, addType2: null,
  });
});

test('путь дома — из действующей иерархии, без самого дома', async () => {
  const region = await readGarRegion((kind) => once(FILES[kind]));
  assert.deepEqual(region.housePath.get(10), [1, 2, 3]);
  assert.deepEqual(region.objectPath.get(3), [1, 2]);
});

test('квартиры считаются только действующие и только квартиры', async () => {
  const region = await readGarRegion((kind) => once(FILES[kind]));
  assert.equal(region.flats.get(10), 2);
});
