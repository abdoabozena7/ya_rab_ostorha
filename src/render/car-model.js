import { buildDetailedSedan } from './detailed-sedan.js?v=drive-final';

export async function loadCarModel(THREE,car,fallback) {
  return buildDetailedSedan(THREE,car,fallback);
}
