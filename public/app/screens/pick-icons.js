/**
 * Иконка ЖК — от владельца (29.09): фиолетовый круг в цветах MAX
 * и белая высотка. Одна на метку карты, миниатюру без фото и шапку
 * карточки без фото — чтобы три места не разошлись.
 *
 * Из исходника выброшены центральная башня (совпадает с силуэтом)
 * и окна под входом (их закрывает дверь) — на экране их не видно.
 */
export const PIN_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true">'
  + '<circle cx="24" cy="24" r="22" fill="#5B22E8"/><circle cx="24" cy="24" r="18" fill="#6B32F0"/>'
  + '<path d="M14 33V15H19V11H29V15H34V33H14Z" fill="#fff"/>'
  + '<g fill="#6B32F0">'
  + '<rect x="21" y="14" width="2.5" height="3" rx=".5"/><rect x="25" y="14" width="2.5" height="3" rx=".5"/>'
  + '<rect x="16.5" y="18" width="2" height="3" rx=".4"/><rect x="21" y="18" width="2.5" height="3" rx=".5"/>'
  + '<rect x="25" y="18" width="2.5" height="3" rx=".5"/><rect x="30" y="18" width="2" height="3" rx=".4"/>'
  + '<rect x="16.5" y="23" width="2" height="3" rx=".4"/><rect x="21" y="23" width="2.5" height="3" rx=".5"/>'
  + '<rect x="25" y="23" width="2.5" height="3" rx=".5"/><rect x="30" y="23" width="2" height="3" rx=".4"/>'
  + '<rect x="16.5" y="28" width="2" height="3" rx=".4"/><rect x="30" y="28" width="2" height="3" rx=".4"/>'
  + '<rect x="22" y="29" width="4" height="4" rx=".5"/>'
  + '</g></svg>';
