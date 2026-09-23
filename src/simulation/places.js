export const PLACES = Object.freeze([
  { id: 'downtown', name: 'وسط البلد', x: 20, z: 20 },
  { id: 'market', name: 'السوق', x: -70, z: 20 },
  { id: 'station', name: 'المحطة', x: 50, z: -60 },
  { id: 'hospital', name: 'المستشفى', x: -20, z: 70 },
  { id: 'university', name: 'الجامعة', x: 100, z: 100 },
  { id: 'corniche', name: 'الكورنيش', x: -100, z: -60 },
]);

const normalize = (value) => value.normalize('NFKC').toLowerCase()
  .replace(/[\u064b-\u065f\u0670]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');

export function findPlaceInText(text) {
  const query = normalize(text.trim());
  if (!query) return null;
  return PLACES.find(({ name }) => query.includes(normalize(name))) ?? null;
}
