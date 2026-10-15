// Destination intent survives inspection of a visible dashboard. Keyboard
// commands still require focus. Autonomous intent also has a server-verified
// WebSocket pong lease, so inspecting another tab does not cancel the route.
export function journeyActive(p) {
  return p.fresh && p.connected && p.controller && !p.isReplay && !p.restarting &&
    !['EMERGENCY_STOP','DISCONNECTED','REPLAY'].includes(p.controlMode) &&
    (p.controlMode === 'AUTOMATIC' || p.journey?.status === 'STARTING') &&
    ['STARTING','RUNNING'].includes(p.journey?.status);
}

export function keepJourneyOnInspection(p, hidden) {
  const presenting=p.presentation?.id&&!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(p.presentation.status)&&
    p.connected&&p.controller&&!p.isReplay&&p.controlMode!=='MANUAL'&&p.controlMode!=='EMERGENCY_STOP';
  return journeyActive(p)||!!presenting;
}

export function journeyHeartbeatAllowed(p, hidden, manualOverridePending) {
  return !manualOverridePending && journeyActive(p);
}
