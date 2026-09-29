import { decodeImageData, decodeBlob } from './decoder.js';

/**
 * Получение строки платёжного QR с квитанции.
 *
 * Путь один — ФОТОГРАФИЯ квитанции (плюс ручная вставка строки для тестов).
 *
 * Живой сканер камерой убран: он требует отдельного разрешения нашей
 * странице, а пожилой человек, увидев внезапный системный запрос, жмёт
 * «Запретить» — и второй раз браузер уже не спросит. Сканер мессенджера
 * убран тоже: настроек у него нет ни одной, на живых устройствах он
 * не читает даже случайный QR, и вдобавок отдаёт готовую строку.
 *
 * Снимок делает системная камера: разрешений не нужно, кадр приходит
 * в полном разрешении, и байты остаются нашими.
 *
 * КЛЮЧЕВОЕ ПРО КОДИРОВКУ. Квитанции печатаются в Windows-1251 (заголовок
 * ST00011). Декодер отдаёт СЫРЫЕ БАЙТЫ — их и надо декодировать по признаку
 * из заголовка. Если взять готовую строку декодера (она собрана как UTF-8),
 * вся кириллица превратится в мусор: ФИО и адрес станут нечитаемыми.
 */

const ENCODINGS = { 1: 'windows-1251', 2: 'utf-8', 3: 'koi8-r' };

/** Декодирует байты QR по признаку кодировки из служебного блока. */
export function decodeQrBytes(bytes) {
  if (!bytes || bytes.length < 8) return null;

  const header = String.fromCharCode(...bytes.slice(0, 8));
  // Не платёжный QR — отдаём как есть, ошибку покажет сервер
  if (!header.startsWith('ST')) return new TextDecoder('utf-8').decode(new Uint8Array(bytes));

  const label = ENCODINGS[header[6]];
  if (!label) return new TextDecoder('utf-8').decode(new Uint8Array(bytes));

  try {
    return new TextDecoder(label).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
}



/** Распознавание из файла: фото квитанции из галереи или с камеры. */
export async function scanFromFile(file) {
  const bytes = await decodeBlob(file);
  if (!bytes) {
    throw new Error(
      'QR-код на фото не найден. Снимите ближе и ровнее, чтобы код попал в кадр целиком.',
    );
  }
  return decodeQrBytes(bytes);
}

