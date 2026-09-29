import { parseAddress } from '../address/normalize.ts';

/**
 * Демо-дом. Выдуманный: в ГАР его нет, настоящий житель туда не попадёт
 * ни одной квитанцией.
 */
export const DEMO_ADDRESS = 'обл Ростовская, г Ростов-на-Дону, ул Демонстрационная, д. 1';
export const DEMO_HOUSE_KEY = parseAddress(DEMO_ADDRESS).houseKey as string;
/** Северный жилой массив Ростова — точка на карте подбора */
export const DEMO_LAT = 47.2932;
export const DEMO_LON = 39.7195;

/** ИНН заведомо несуществующие: реестр таких не выдаёт */
export const DEMO_ORG_INN = '0000610001';
export const DEMO_ELEC_INN = '0000610002';
export const DEMO_GAS_INN = '0000610003';
export const DEMO_UK_LOGIN = 'demo-uk';

export interface DemoPersona {
  key: string;
  title: string;
  subtitle: string;
  flat: string;
  role: 'owner' | 'member';
  status: 'active' | 'pending';
  name: string;
  chairman?: boolean;
}

export const DEMO_ROLES: DemoPersona[] = [
  { key: 'chairman', title: 'Председатель совета дома', subtitle: 'Кв. 1 · подтверждает соседей, объявления, опросы',
    flat: '1', role: 'owner', status: 'active', name: 'Лебедева Ольга Викторовна', chairman: true },
  { key: 'owner12', title: 'Собственник', subtitle: 'Кв. 12 · начисления, счётчики, заявки, приглашения',
    flat: '12', role: 'owner', status: 'active', name: 'Кузнецов Андрей Павлович' },
  { key: 'member12', title: 'Жилец', subtitle: 'Кв. 12 · приглашён собственником',
    flat: '12', role: 'member', status: 'active', name: 'Кузнецова Елена Игоревна' },
  { key: 'owner45', title: 'Собственник', subtitle: 'Кв. 45 · диспетчер ждёт вашего ответа',
    flat: '45', role: 'owner', status: 'active', name: 'Морозов Сергей Николаевич' },
  { key: 'owner78', title: 'Собственник', subtitle: 'Кв. 78 · заявка выполнена — оцените или верните',
    flat: '78', role: 'owner', status: 'active', name: 'Васильева Татьяна Андреевна' },
  { key: 'newcomer30', title: 'Новичок', subtitle: 'Кв. 30 · ждёт подтверждения, жалоба доступна сразу',
    flat: '30', role: 'member', status: 'pending', name: 'Григорьев Илья Олегович' },
];

/** Соседи без ролей: авторы объявлений, голоса, отзывы, заявки */
export const DEMO_NEIGHBOURS: { name: string; flat: string }[] = [
  { name: 'Орлова Нина Петровна', flat: '3' },
  { name: 'Соколов Дмитрий Ильич', flat: '9' },
  { name: 'Павлова Марина Сергеевна', flat: '17' },
  { name: 'Волков Артём Романович', flat: '23' },
  { name: 'Никитина Алла Юрьевна', flat: '36' },
  { name: 'Фёдоров Кирилл Андреевич', flat: '41' },
  { name: 'Захарова Вера Ивановна', flat: '52' },
  { name: 'Белов Роман Олегович', flat: '66' },
  { name: 'Ковалёва Дарья Максимовна', flat: '71' },
  { name: 'Тарасов Олег Викторович', flat: '88' },
  { name: 'Медведева Юлия Алексеевна', flat: '95' },
  { name: 'Ершов Павел Денисович', flat: '102' },
  { name: 'Сергеева Анна Михайловна', flat: '117' },
  { name: 'Жуков Степан Ильич', flat: '126' },
  { name: 'Смирнова Лидия Фёдоровна', flat: '139' },
];

/** Ждут решения председателя. У второго — расхождение квартиры с квитанцией */
export const DEMO_CLAIMANTS: { name: string; flat: string; claimFlat: string; note: string }[] = [
  { name: 'Антонов Виктор Семёнович', flat: '57', claimFlat: '57', note: 'Купили квартиру в августе' },
  { name: 'Лаптева Ирина Олеговна', flat: '46', claimFlat: '64', note: 'Снимаем у Ершовых' },
  { name: 'Рябов Глеб Андреевич', flat: '101', claimFlat: '101', note: 'Сын собственницы' },
];
