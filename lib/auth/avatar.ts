import { PLACEHOLDER_NAME } from './names.ts';

/**
 * Какой аватар показать, если фото из MAX нет: мужской или женский Домовой.
 *
 * Пол по ФИО из квитанции — сначала по отчеству («…вич», «оглы» /
 * «…вна», «кызы»), без отчества — по имени. Не понять — null, и тогда
 * остаются инициалы: лучше буквы, чем промах. ФИО из MAX приходит
 * «Фамилия Имя», из квитанции — «Фамилия Имя Отчество» или с инициалом.
 *
 * Картинки — public/icons/avatars/{male,female}.webp (просьба владельца 27.09).
 */
export type AvatarKind = 'male' | 'female';

/** Мужские имена на -а/-я и женские на -ь — иначе окончание обманет */
const MALE_A = new Set(['никита', 'илья', 'кузьма', 'фома', 'лука', 'савва', 'данила', 'гаврила', 'муса', 'иса', 'добрыня', 'миша', 'саша', 'женя', 'ваня', 'петя', 'коля', 'толя', 'дима', 'вова', 'серёжа', 'сережа', 'лёша', 'леша', 'гоша', 'паша', 'гриша', 'юра', 'слава']);
const FEMALE_SOFT = new Set(['любовь', 'нинель', 'адель', 'рахиль', 'эсфирь', 'юдифь', 'аделаида']);

function byPatronymic(word: string): AvatarKind | null {
  if (/(вич|ич|оглы|улы|уулу)$/i.test(word)) return 'male';
  if (/(вна|чна|кызы|гызы)$/i.test(word)) return 'female';
  return null;
}

function byFirstName(raw: string): AvatarKind | null {
  const name = raw.toLowerCase();
  if (name.length < 2 || !/^[а-яё-]+$/.test(name)) return null;
  if (MALE_A.has(name)) return 'male';
  if (FEMALE_SOFT.has(name)) return 'female';
  if (/[ая]$/.test(name)) return 'female';
  if (/[бвгджзйклмнпрстфхцчшщь]$/.test(name)) return 'male';
  return null;
}

export function avatarKind(fullName: string | null | undefined): AvatarKind | null {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || fullName === PLACEHOLDER_NAME) return null;

  // «Рашид оглы», «Андрей Павлович» — отчество в третьем слове и дальше
  const patronymic = words.slice(2).reverse().map(byPatronymic).find(Boolean);
  if (patronymic) return patronymic;

  return byFirstName(words.length >= 2 ? words[1] : words[0]);
}
