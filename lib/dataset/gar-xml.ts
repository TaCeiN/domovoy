/**
 * Потоковое чтение файлов ГАР.
 *
 * ПОЧЕМУ НЕ XML-ПАРСЕР. Файлы региона весят до гигабайта в распакованном
 * виде и устроены предельно просто: один корневой элемент и в нём
 * миллионы самозакрывающихся тегов, все данные — в атрибутах. Полноценный
 * парсер означал бы зависимость ради того, что умещается в регулярку,
 * а держать гигабайтный файл в памяти нельзя вовсе.
 */

const ENTITIES: Record<string, string> = {
  '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'",
};

function decodeEntities(value: string): string {
  return value.includes('&') ? value.replace(/&(quot|amp|lt|gt|apos);/g, (m) => ENTITIES[m]) : value;
}

export async function* readGarTags(
  stream: AsyncIterable<Buffer | string>,
  tag: string,
): AsyncGenerator<Record<string, string>> {
  // Потоковый декодер: кусок может закончиться посреди двухбайтовой буквы
  const decoder = new TextDecoder('utf-8');
  const open = `<${tag} `;
  let buffer = '';

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    let cursor = 0;
    for (;;) {
      const start = buffer.indexOf(open, cursor);
      if (start < 0) {
        // Хвост может оказаться началом тега — оставляем его следующему куску
        cursor = Math.max(cursor, buffer.length - open.length);
        break;
      }
      const end = buffer.indexOf('/>', start);
      if (end < 0) {
        cursor = start;
        break;
      }

      const row: Record<string, string> = {};
      const body = buffer.slice(start + open.length, end);
      for (const match of body.matchAll(/(\w+)="([^"]*)"/g)) row[match[1]] = decodeEntities(match[2]);
      yield row;

      cursor = end + 2;
    }

    buffer = buffer.slice(cursor);
  }
}
