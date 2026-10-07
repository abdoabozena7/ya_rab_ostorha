import { SPEED_TO_KMH } from './fixed-step.js?v=drive-final';
export { stepVehicle as stepManualDriving } from './vehicle-dynamics.js?v=drive-final';
export const MAX_FORWARD_SPEED=180/SPEED_TO_KMH;
export const MAX_REVERSE_SPEED=15/SPEED_TO_KMH;
