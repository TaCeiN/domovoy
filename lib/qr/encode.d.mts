/** Типы для encode.mjs: кодировщик остаётся JavaScript — его же грузит браузер генератора */
export type QrEcc = 'L' | 'M' | 'Q' | 'H';
export interface QrMatrix { size: number; version: number; ecc: QrEcc; mask: number; modules: boolean[][] }
export function dataCapacityBytes(version: number, ecc: QrEcc): number;
export function fitsInVersion(byteLength: number, version: number, ecc: QrEcc): boolean;
export function encodeQr(bytes: Uint8Array, options?: { ecc?: QrEcc; minVersion?: number; maxVersion?: number }): QrMatrix;
export function qrToSvg(matrix: { size: number; modules: boolean[][] }, options?: { scale?: number; quiet?: number }): string;
export function qrToPixels(matrix: { size: number; modules: boolean[][] }, options?: { scale?: number; quiet?: number }): { data: Uint8ClampedArray; width: number; height: number };
