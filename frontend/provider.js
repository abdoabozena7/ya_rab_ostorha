// Application contract only. The simulator owns all physical state.
export const WHEEL_NAMES = ['rearLeft', 'frontLeft', 'rearRight', 'frontRight'];

export class SimulationProvider {
  getVehicleState() { throw new Error('getVehicleState must be implemented'); }
  getEngineState() { return this.getVehicleState(); }
  getDamageState() { return this.getVehicleState().damage; }
  getSensorFrame() { throw new Error('Sensor unavailable'); }
  updateControls() { throw new Error('updateControls must be implemented'); }
}
