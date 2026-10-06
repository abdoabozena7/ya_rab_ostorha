import { SimulationProvider, WHEEL_NAMES } from './provider.js';

export function unavailableBeamNGState() {
  return {source:'beamng',timestamp:null,physicsTick:null,speedMps:null,
    accelerationMps2:null,steeringAngleRad:null,steeringWheelAngleRad:null,
    throttle:null,brake:null,gear:null,engineRPM:null,engineRunning:null,
    fuelLevelL:null,fuelCapacityL:null,instantConsumptionLph:null,
    wheels:WHEEL_NAMES.map(name=>({name,rpm:null,angleRad:null,steeringAngleRad:null,
      suspensionCompressionM:null})),damage:{},lastCollision:null};
}

// This adapter never substitutes development physics on connection failure.
export class BeamNGProvider extends SimulationProvider {
  constructor() {
    super(); this.telemetry=unavailableBeamNGState(); this.connected=false;
    this.status='Connecting to BeamNG'; this.sequence=0; this.pending=new Map();
    this.sensorMetadata={}; this.sensorRates={}; this.sensorErrors={}; this.latencyMs=null;
    this.receivedAt=0; this.controller=false; this.gearCommand=1;
  }
  async connect() {
    try {
      const response=await fetch('/api/simulation/status');
      if(!response.ok)throw new Error('Simulation server unavailable');
      const status=await response.json();
      if(status.provider!=='beamng'||!status.websocketPort)throw new Error('BeamNG backend is not running');
      this.socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.hostname}:${status.websocketPort}`);
      this.socket.onmessage=event=>{
        const message=JSON.parse(event.data);
        if(message.type==='error'){this.status=message.error;return;}
        if(message.type!=='snapshot')return;
        this.connected=Boolean(message.connected);this.controller=message.controller;
        this.status=message.error??(this.controller?'BeamNG · city preview':'BeamNG · read only');
        if(message.vehicle)this.telemetry=message.vehicle;
        this.sensorMetadata=message.sensors??{};this.sensorRates=message.sensorPollHz??{};
        this.sensorErrors=message.sensorErrors??{};this.receivedAt=performance.now();
        const sent=this.pending.get(message.acknowledged);
        if(sent!=null){this.latencyMs=performance.now()-sent;this.pending.delete(message.acknowledged);}
      };
      this.socket.onclose=()=>{this.connected=false;this.status='BeamNG disconnected · controls released';};
      this.socket.onerror=()=>{this.connected=false;this.status='BeamNG connection error';};
    } catch(error) {this.status=error.message;this.connected=false;}
  }
  get fresh() {return this.connected&&performance.now()-this.receivedAt<750;}
  getVehicleState() {return this.fresh?this.telemetry:unavailableBeamNGState();}
  getSensorFrame(name) {return fetch(`/api/simulation/sensor?name=${encodeURIComponent(name)}`).then(async r=>{
    if(!r.ok)throw new Error((await r.json()).error);return r.json();
  });}
  send(type, payload={}) {
    if(this.socket?.readyState!==1||!this.controller)return false;
    const sequence=++this.sequence;
    this.pending.set(sequence,performance.now());
    if(this.pending.size>40)this.pending.delete(this.pending.keys().next().value);
    this.socket.send(JSON.stringify({type,sequence,...payload}));
    return true;
  }
  updateControls({throttle=0,brake=0,steering=0,parkingbrake=0}={}) {
    const controls={throttle,brake,steering,parkingbrake};
    if(this.gearCommand!=null)controls.gear=this.gearCommand;
    if(this.send('controls',{controls}))this.gearCommand=null;
  }
  setGear(gear) {this.gearCommand=gear;}
  resetVehicle() {this.send('reset');this.gearCommand=1;}
  setPaused(paused) {this.send('pause',{paused});}
  releaseControls() {this.updateControls({brake:1});}
  close() {this.releaseControls();this.socket?.close();}
}
