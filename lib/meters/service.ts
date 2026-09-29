import { and, desc, eq } from 'drizzle-orm';
import { meter, meterReading } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { accessLevel, type AccessLevel } from '../auth/access.ts';
import type { Database } from '../../db/client.ts';

/**
 * Показания счётчиков.
 *
 * В исходном прототипе проверка была одна: «не меньше предыдущего». Этого
 * категорически мало: опечатка на порядок (2214 вместо 221.4) — самая
 * частая ошибка ввода, и в дневнике она портит всю картину расхода.
 *
 * Опечатку мы НЕ блокируем, а предупреждаем: бывает и законный скачок
 * (прорыв, приезд родни, замена счётчика). Решает человек, но осознанно.
 * Порог скачка — втрое выше обычного; ноль у воды и света — подсказка,
 * не запрет.
 *
 * ЗАВОДСКОЙ НОМЕР И ПОВЕРКА ОТСЮДА УБРАНЫ. Это дневник: показания никуда
 * не уходят, сверять их по номеру прибора некому, а дату поверки
 * приложение всё равно знает только со слов жителя. Спрашивать три поля
 * там, где по делу нужно одно, — верный способ бросить форму на середине.
 * Колонки в базе остались: в них лежат данные, заведённые раньше.
 */

export const METER_KINDS = ['cold', 'hot', 'elec', 'gas', 'heat'] as const;
export type MeterKind = (typeof METER_KINDS)[number];

/**
 * Электричество одно, без дня и ночи.
 *
 * Двухтарифный счётчик показывает две цифры, но приложение — дневник:
 * оно не считает деньги и не передаёт показания, а значит различать
 * тарифы ему незачем. Житель, у которого один тариф (а таких
 * большинство), видел два непонятных пункта и выбирал наугад.
 *
 * Старые записи `elec_t1` и `elec_t2` в базе остаются и продолжают
 * читаться: подписи для них лежат ниже. Завести такой счётчик заново
 * уже нельзя — в списке видов их нет.
 */
export const METER_LABEL: Record<string, string> = {
  cold: 'Холодная вода',
  hot: 'Горячая вода',
  elec: 'Электричество',
  gas: 'Газ',
  heat: 'Отопление',
  elec_t1: 'Электричество, день',
  elec_t2: 'Электричество, ночь',
};

export const METER_UNIT: Record<string, string> = {
  cold: 'м³', hot: 'м³', gas: 'м³',
  // Отопление — в м³ газа: в домах владельца отопление газовое, счёт идёт
  // по газу, а не в гигакалориях (поправка владельца 27.09.2026)
  elec: 'кВт·ч', heat: 'м³',
  elec_t1: 'кВт·ч', elec_t2: 'кВт·ч',
};

/**
 * Срок, до которого показания обычно принимает УК.
 *
 * НЕ НАШ СРОК: своего приёма показаний у приложения нет, оно их только
 * хранит. Числа нужны, чтобы напомнить человеку о ЧУЖОМ сроке, и потому
 * лежат в одном месте — у конкретной УК они могут быть другими.
 */
export const WINDOW_FROM_DAY = 20;
export const WINDOW_TO_DAY = 25;

export function currentPeriod(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export interface WindowState {
  open: boolean;
  from: number;
  to: number;
  daysLeft: number | null;
  message: string;
}

export function windowState(now = new Date()): WindowState {
  const day = now.getDate();
  const open = day >= WINDOW_FROM_DAY && day <= WINDOW_TO_DAY;

  if (open) {
    return {
      open: true, from: WINDOW_FROM_DAY, to: WINDOW_TO_DAY,
      daysLeft: WINDOW_TO_DAY - day,
      message: `Обычно УК принимают показания с ${WINDOW_FROM_DAY} по ${WINDOW_TO_DAY} число`,
    };
  }
  if (day < WINDOW_FROM_DAY) {
    return {
      open: false, from: WINDOW_FROM_DAY, to: WINDOW_TO_DAY,
      daysLeft: WINDOW_FROM_DAY - day,
      message: `Обычно УК принимают показания с ${WINDOW_FROM_DAY} по ${WINDOW_TO_DAY} число`,
    };
  }
  return {
    open: false, from: WINDOW_FROM_DAY, to: WINDOW_TO_DAY, daysLeft: null,
    message: 'Срок в большинстве УК уже прошёл — уточните в квитанции, '
      + 'примут ли показания в этом месяце',
  };
}

export interface Warning {
  code: 'suspicious_jump' | 'window_closed' | 'decimal_typo' | 'zero_consumption';
  message: string;
  /** Для опечатки: что, скорее всего, имелось в виду */
  suggested?: number;
  /** Во сколько раз расход выше обычного, округлённо */
  ratio?: number;
}

export type SubmitResult =
  | { ok: true; readingId: string; consumption: number; warnings: Warning[]; first: boolean }
  | { ok: false;
      reason: 'no_access' | 'not_a_number' | 'below_previous' | 'already_submitted'
        | 'needs_confirmation';
      message: string; previous?: number; suggested?: number; ratio?: number };

export interface SubmitInput {
  userId: string;
  meterId: string;
  value: string;
  period?: string;
  photoUrl?: string;
  /** Житель подтвердил, что скачок не опечатка */
  confirmed?: boolean;
  now?: Date;
}

export async function submitReading(db: Database, input: SubmitInput): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const period = input.period ?? currentPeriod(now);

  const [m] = await db.select().from(meter).where(eq(meter.id, input.meterId)).limit(1);
  if (!m || !await canWriteMeter(db, input.userId, m)) {
    return { ok: false, reason: 'no_access', message: 'Счётчик не найден' };
  }

  const value = Number(String(input.value).replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: 'not_a_number', message: 'Введите число' };
  }

  const already = await db
    .select()
    .from(meterReading)
    .where(and(eq(meterReading.meterId, m.id), eq(meterReading.period, period)))
    .limit(1);
  if (already[0]) {
    return {
      ok: false, reason: 'already_submitted',
      message: `Показания за этот период уже переданы: ${already[0].value}`,
    };
  }

  const history = await db
    .select()
    .from(meterReading)
    .where(eq(meterReading.meterId, m.id))
    .orderBy(desc(meterReading.period))
    .limit(6);

  const previous = history[0] ? Number(history[0].value) : null;

  if (previous !== null && value < previous) {
    return {
      ok: false, reason: 'below_previous',
      message: `Не может быть меньше предыдущего (${previous})`,
      previous,
    };
  }

  const consumption = previous === null ? 0 : value - previous;
  const warnings = collectWarnings({ kind: m.kind, value, previous, consumption, history, now });

  /**
   * Подозрительный скачок требует подтверждения, но не блокируется навсегда:
   * бывает и законный расход — прорыв, приезд родни, замена счётчика.
   *
   * Отдельный код, а не 'not_a_number': отличить «введите число» от
   * «подтвердите, что это не опечатка» по тексту сообщения нельзя, а
   * реакция интерфейса на них противоположная — в первом случае поле
   * надо чистить, во втором показать кнопку «всё верно».
   */
  const blocking = warnings.find((w) => w.code === 'decimal_typo' || w.code === 'suspicious_jump');
  if (blocking && !input.confirmed) {
    return {
      ok: false,
      reason: 'needs_confirmation',
      message: blocking.message,
      previous: previous ?? undefined,
      suggested: blocking.suggested,
      ratio: blocking.ratio,
    };
  }

  const readingId = newId('rdg');
  await db.insert(meterReading).values({
    id: readingId,
    meterId: m.id,
    period,
    value: String(value),
    photoUrl: input.photoUrl ?? null,
    createdBy: input.userId,
  });

  return { ok: true, readingId, consumption, warnings, first: previous === null };
}

/**
 * Где нулевой расход за месяц подозрителен.
 *
 * Воду и свет в жилой квартире тратят каждый месяц: ноль чаще значит
 * вставший счётчик или показание, переписанное с прошлой квитанции.
 * Отопление летом стоит законно, газовую плиту могут не включать —
 * там ноль не повод переспрашивать.
 */
const ZERO_WATCH = new Set(['cold', 'hot', 'elec', 'elec_t1', 'elec_t2']);

/** «в 4 раза», «в 12 раз», «в сотни раз» — для текста вопроса. */
function timesText(ratio: number): string {
  if (ratio >= 100) return 'в сотни раз';
  const last = ratio % 10;
  const teen = ratio >= 11 && ratio <= 14;
  const word = !teen && last >= 2 && last <= 4 ? 'раза' : 'раз';
  return `в ${ratio} ${word}`;
}

/** 221.4 → «221,4»: житель пишет и читает запятую. */
function ruNumber(value: number): string {
  return String(value).replace('.', ',');
}

function collectWarnings(ctx: {
  kind: string;
  value: number;
  previous: number | null;
  consumption: number;
  history: (typeof meterReading.$inferSelect)[];
  now: Date;
}): Warning[] {
  const warnings: Warning[] = [];

  /**
   * Ноль стоит ПЕРВЫМ: тост после записи показывает одно, первое
   * предупреждение, а «срок приёма прошёл» человек и так знает.
   */
  if (ctx.previous !== null && ctx.consumption === 0 && ZERO_WATCH.has(ctx.kind)) {
    warnings.push({
      code: 'zero_consumption',
      message: 'Расход за месяц нулевой. Если в квартире жили — проверьте, крутится ли счётчик.',
    });
  }

  const win = windowState(ctx.now);
  if (!win.open) {
    warnings.push({ code: 'window_closed', message: win.message });
  }

  if (ctx.previous === null || ctx.consumption <= 0) return warnings;

  const average = averageConsumption(ctx.history);
  if (average <= 0) return warnings;

  const ratio = Math.round(ctx.consumption / average);

  /**
   * Пропущенная запятая: 2214 вместо 221.4. Ловим прицельно — если
   * деление на 10 или 100 даёт правдоподобный расход, это почти наверняка
   * опечатка, а не рекордный месяц. Исправленное значение уходит в ответ:
   * интерфейс предлагает его кнопкой, а не заставляет перепечатывать.
   */
  for (const divisor of [10, 100]) {
    const asTypo = Number((ctx.value / divisor).toFixed(4));
    if (asTypo > ctx.previous && asTypo - ctx.previous <= average * 3) {
      warnings.push({
        code: 'decimal_typo',
        message:
          `Похоже на ошибку: расход ${timesText(ratio)} больше обычного. ` +
          `Вы имели в виду ${ruNumber(asTypo)}, а не ${ruNumber(ctx.value)}?`,
        suggested: asTypo,
        ratio,
      });
      return warnings;
    }
  }

  /**
   * Общий скачок: втрое выше среднего — повод переспросить.
   *
   * Было «вдесятеро», и между тремя и десятью разами проходило всё:
   * подтекающий бачок, переписанная не та строка табло. Это вопрос,
   * а не запрет — законный скачок подтверждается одной кнопкой.
   */
  if (ctx.consumption > average * 3) {
    warnings.push({
      code: 'suspicious_jump',
      message:
        `Расход ${ruNumber(Number(ctx.consumption.toFixed(1)))} — это ${timesText(ratio)} ` +
        `больше обычного (${ruNumber(Number(average.toFixed(1)))}). Проверьте показания.`,
      ratio,
    });
  }

  return warnings;
}

function averageConsumption(history: (typeof meterReading.$inferSelect)[]): number {
  if (history.length < 2) return 0;
  const values = history.map((h) => Number(h.value)).filter(Number.isFinite);
  const deltas: number[] = [];
  // История отсортирована по убыванию периода
  for (let i = 0; i < values.length - 1; i++) {
    const delta = values[i] - values[i + 1];
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return 0;
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

export type AddMeterResult =
  | { ok: true; meterId: string }
  | { ok: false; reason: 'no_access' | 'bad_kind' | 'duplicate' | 'needs_place' };

/**
 * Завести счётчик.
 *
 * ЗАЧЕМ ЭТО ПОЯВИЛОСЬ. Вставка в таблицу `meter` существовала ТОЛЬКО
 * в тестах: ни маршрута, ни импорта, ни seed-скрипта. Значит у каждого
 * реального жителя список счётчиков был пуст всегда, форма передачи
 * показаний недостижима, а вся ловля опечаток и аналитика по расходу —
 * код, который в бою не выполняется ни разу. При этом счётчики
 * числились готовой функцией.
 *
 * Заводит счётчик САМ ЖИТЕЛЬ, и вопрос ему задаётся ровно один:
 * что этот прибор считает. Всё остальное дневнику не нужно.
 */
export async function addMeter(
  db: Database,
  input: {
    userId: string;
    propertyId: string;
    kind: string;
    /** Где стоит: «кухня», «ванная» — различает два счётчика одного вида */
    place?: string | null;
  },
): Promise<AddMeterResult> {
  if (!METER_KINDS.includes(input.kind as MeterKind)) {
    return { ok: false, reason: 'bad_kind' };
  }

  // Свой счётчик заводится и до подтверждения: это его квартира
  const level = await accessLevel(db, input.userId, input.propertyId);
  if (level === 'none') return { ok: false, reason: 'no_access' };

  /**
   * Дубль — тот же вид в том же месте.
   *
   * Раньше вид был один на квартиру, и вторую холодную воду (кухня
   * и ванная — обычное дело) было не завести. Теперь различает подпись
   * места; без подписи второй такой же счётчик не пустим — иначе человек
   * не поймёт, в какой из двух одинаковых записывать.
   */
  const place = input.place?.trim().slice(0, 40) || null;
  const sameKind = (await visibleMeters(db, input.userId, input.propertyId, level))
    .filter((x) => x.kind === input.kind);
  const norm = (v: string | null) => (v ?? '').trim().toLowerCase();
  if (sameKind.some((x) => norm(x.place) === norm(place))) {
    return { ok: false, reason: sameKind.length && !place ? 'needs_place' : 'duplicate' };
  }

  const meterId = newId('mtr');
  await db.insert(meter).values({
    id: meterId,
    propertyId: input.propertyId,
    kind: input.kind,
    place,
    createdBy: input.userId,
  });

  return { ok: true, meterId };
}

/** Виды счётчиков для формы: житель не обязан знать наши коды. */
export function meterKinds() {
  return METER_KINDS.map((kind) => ({
    kind,
    label: METER_LABEL[kind],
    unit: METER_UNIT[kind],
  }));
}

/** Счётчики объекта с последними показаниями — для формы передачи. */
export async function listMeters(db: Database, userId: string, propertyId: string) {
  const level = await accessLevel(db, userId, propertyId);
  if (level === 'none') return null;

  const meters = await visibleMeters(db, userId, propertyId, level);
  const period = currentPeriod();

  return Promise.all(meters.map(async (m) => {
    const readings = await db
      .select()
      .from(meterReading)
      .where(eq(meterReading.meterId, m.id))
      .orderBy(desc(meterReading.period))
      .limit(6);

    const kind = m.kind as MeterKind;

    return {
      id: m.id,
      kind,
      label: METER_LABEL[kind] ?? m.kind,
      place: m.place,
      unit: METER_UNIT[kind] ?? '',
      previous: readings[0] ? Number(readings[0].value) : null,
      previousPeriod: readings[0]?.period ?? null,
      submittedThisPeriod: readings.some((r) => r.period === period),
      averageConsumption: Number(averageConsumption(readings).toFixed(2)),
    };
  }));
}

/**
 * Счётчики, которые человеку можно видеть.
 *
 * Подтверждённый жилец ведёт дневник квартиры целиком. До подтверждения —
 * только заведённые им самим: строку QR можно набрать руками, и она не
 * даёт права читать чужие показания (аудит 26 сентября). Счётчики без
 * автора — старые, до поля `created_by`, — тоже только подтверждённым.
 */
export async function visibleMeters(
  db: Database,
  userId: string,
  propertyId: string,
  level?: AccessLevel,
) {
  const lvl = level ?? await accessLevel(db, userId, propertyId);
  if (lvl === 'none') return [];
  return db.select().from(meter).where(lvl === 'full'
    ? eq(meter.propertyId, propertyId)
    : and(eq(meter.propertyId, propertyId), eq(meter.createdBy, userId)));
}

/** Писать показания можно туда же, куда можно смотреть. */
async function canWriteMeter(
  db: Database,
  userId: string,
  m: { propertyId: string; createdBy: string | null },
): Promise<boolean> {
  const level = await accessLevel(db, userId, m.propertyId);
  if (level === 'full') return true;
  return level !== 'none' && m.createdBy === userId;
}
