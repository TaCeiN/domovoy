import { join, resolve } from 'node:path';

/**
 * Общие правила хранения файлов: что принимаем и куда кладём.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Это правила безопасности, а не удобства, и двух
 * их копий быть не должно. Вложения к обращениям и фотографии объявлений
 * определяют тип файла одинаково; разъехавшись, эти два места однажды
 * начнут принимать разное, и слабейшее станет дырой на весь проект.
 *
 * ГЛАВНОЕ ПРАВИЛО: тип определяется по СОДЕРЖИМОМУ файла. Ни имени файла,
 * ни заголовку `Content-Type` от клиента верить нельзя — они приходят
 * из того же запроса, что и сам файл.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface Signature {
  mime: string;
  ext: string;
  /** Картинка ли это: PDF принимаем к обращениям, но не как обложку */
  image: boolean;
  test: (b: Buffer) => boolean;
}

const SIGNATURES: Signature[] = [
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    image: true,
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    ext: 'png',
    image: true,
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    image: true,
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF'
      && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    /** Фотографии с айфона приходят в HEIC, и их надо принимать как есть */
    mime: 'image/heic',
    ext: 'heic',
    image: true,
    test: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp'
      && ['heic', 'heix', 'mif1', 'msf1'].includes(b.subarray(8, 12).toString('ascii')),
  },
  {
    mime: 'application/pdf',
    ext: 'pdf',
    image: false,
    test: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-',
  },
];

/** Изображение или PDF — то, что принимают вложения к обращениям. */
export function detectType(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;
  const found = SIGNATURES.find((s) => s.test(bytes));
  return found ? { mime: found.mime, ext: found.ext } : null;
}

/**
 * Только изображение — то, что годится в обложку.
 *
 * PDF на месте карточки товара не показывает ничего: человек приложил бы
 * его и увидел пустое место, решив, что приложение сломалось.
 */
export function detectImage(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;
  const found = SIGNATURES.find((s) => s.image && s.test(bytes));
  return found ? { mime: found.mime, ext: found.ext } : null;
}

/**
 * Куда складываем файлы.
 *
 * Каталог задаётся переменной, потому что в контейнере это том, а на
 * машине разработчика — папка рядом с проектом.
 */
export function uploadsRoot(): string {
  return resolve(process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads'));
}
