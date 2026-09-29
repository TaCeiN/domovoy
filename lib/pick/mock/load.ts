import { mockComplex, mockComplexPhoto } from '../../../db/schema.ts';
import type { MockFile } from './format.ts';
import type { Database } from '../../../db/client.ts';

/** Байты фото по slug ЖК: их читает db/mock-load.ts из релиза или с диска */
export type MockPhotos = Map<string, { bytes: Buffer; mime: string }>;

/**
 * Заглушка ЖК заливается ЦЕЛИКОМ в одной транзакции: полупустая таблица
 * включила бы режим заглушки с половиной ЖК. Фото — там же: ЖК без
 * своего файла остаётся без фото, и карточка рисует заглушку.
 */
export async function loadMock(db: Database, file: MockFile, photos: MockPhotos = new Map()): Promise<number> {
  await db.transaction(async (tx) => {
    await tx.delete(mockComplexPhoto);
    await tx.delete(mockComplex);
    await tx.insert(mockComplex).values(file.complexes.map((c) => ({
      slug: c.slug, name: c.name, address: c.address,
      microdistrict: c.microdistrict ?? null, district: c.district ?? null,
      lat: c.lat, lon: c.lon, developer: c.developer ?? null,
      priceFrom: c.priceFrom ?? null, utilities: c.utilities ?? null, grocery: c.grocery, blurb: c.blurb ?? null,
      tags: c.tags, reviews: c.reviews, src: c.src, aliases: c.aliases ?? [],
    })));
    const withPhoto = file.complexes.flatMap((c) => {
      const pic = photos.get(c.slug);
      return c.photo && pic ? [{ slug: c.slug, ...pic, credit: c.photo.credit, sourceUrl: c.photo.sourceUrl }] : [];
    });
    if (withPhoto.length) await tx.insert(mockComplexPhoto).values(withPhoto);
  });
  return file.complexes.length;
}

/** Пустая таблица — подбор снова показывает настоящие дома */
export async function clearMock(db: Database): Promise<void> {
  await db.delete(mockComplexPhoto);
  await db.delete(mockComplex);
}
