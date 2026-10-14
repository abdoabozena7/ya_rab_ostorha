export const DRIVING_KEYS = new Set(['KeyW','KeyA','KeyS','KeyD','Space','ShiftLeft','ShiftRight']);
export function isEditableTarget(target) {
  return !!target && (/INPUT|SELECT|TEXTAREA/.test(target.tagName) || target.isContentEditable);
}
export function drivingInputAllowed({fresh, replay, owner, focused, modal, mode, armed}) {
  return fresh && !replay && owner && focused && !modal &&
    mode === 'MANUAL' && armed;
}
