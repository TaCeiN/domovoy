import { randomBytes } from 'node:crypto';

/**
 * Идентификаторы с префиксом типа: `usr_k3f9x2...`.
 *
 * Префикс видно в логах и в ошибках, и сразу понятно, что за объект.
 * Алфавит — Crockford base32 без похожих символов (без I, L, O, U):
 * такой id можно продиктовать голосом и не перепутать 0 с O.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix =
  | 'uk' | 'prp' | 'usr' | 'ubd' | 'bil' | 'mtr' | 'rdg'
  | 'req' | 'evt' | 'pht' | 'rat' | 'pol' | 'opt' | 'vot'
  | 'pst' | 'dsp' | 'ses' | 'ntf' | 'chr' | 'acc' | 'org' | 'mhs' | 'inv' | 'hcl'
  | 'adm' | 'aac' | 'pph' | 'prd' | 'poi' | 'rev' | 'hct' | 'bdr' | 'bms' | 'drl';

export function newId(prefix: IdPrefix, length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

/**
 * Короткий код для человека: приглашение домочадца, гостевой доступ.
 * Читается вслух, поэтому тоже без похожих символов.
 */
export function humanCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}
