// Destination intent survives inspection of a visible dashboard. Keyboard
// commands still require focus. Hidden pages cannot safely maintain the lease.
export function journeyActive(p) {
  return p.fresh && p.connected && p.controller && !p.isReplay && !p.restarting &&
    !['EMERGENCY_STOP','DISCONNECTED','REPLAY'].includes(p.controlMode) &&
    (p.controlMode === 'AUTOMATIC' || p.journey?.status === 'STARTING') &&
    ['STARTING','RUNNING'].includes(p.journey?.status);
}

export function keepJourneyOnInspection(p, hidden) {
  return !hidden && journeyActive(p);
}

export function journeyHeartbeatAllowed(p, hidden, manualOverridePending) {
  return !hidden && !manualOverridePending && journeyActive(p);
}
