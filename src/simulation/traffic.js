import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/loaders/GLTFLoader.js';
import { roadLayout } from './road-lanes.js?v=drive-final';
import { motionClear, leadVehicle } from './vehicle-geometry.js?v=drive-final';
import { followingAcceleration, safeFollowingSpeed } from './longitudinal.js?v=drive-final';
import { WORLD_EXTENT, surfaceAt } from './road-conditions.js?v=drive-final';
import { createIncidents } from './incidents.js?v=drive-final';
import { endTurn } from './route-driver.js?v=drive-final';
import { loadTrafficVisuals, tukTukVisual } from '../render/traffic-visuals.js?v=drive-final';

export function createTrafficSystem(THREE, scene, obstacles, getExpansionLevel, getPlayer) {
  const vehicles = [];
  const lights = [];
  const incidents=createIncidents(42);
  let conditionsEnabled=true, density=1;
  let districtRoads=[];
  let pedestrians=[];
  let protectedSpawn={x:17.5,z:-40};
  const vehicleModels = [];
  const tuktukModels = [];
  const colors = [0xe05b45,0xf1b64b,0x4e9e9b,0x536baf,0xbfc5bd,0x916db0];
  const material = color => new THREE.MeshPhongMaterial({color});

  class TrafficLight {
    constructor(x,z,phase) {
      this.x=x; this.z=z; this.timer=phase;
      this.root=new THREE.Group();
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.16,5,8),material(0x242629));
      pole.position.y=2.5; this.root.add(pole);
      this.bulbs=['red','yellow','green'].map((_,i)=>{
        const bulb=new THREE.Mesh(new THREE.SphereGeometry(0.25,10,8),material(0x222222));
        bulb.position.set(0,4.35-i*0.55,0.25); this.root.add(bulb); return bulb;
      });
      this.root.position.set(x+5.5,0,z+5.5);
      scene.add(this.root); lights.push(this);
      this.update();
    }
    get vs() { const t=this.timer%1800; return t<780?'green':t<900?'yellow':'red'; }
    get hs() { const t=(this.timer+900)%1800; return t<780?'green':t<900?'yellow':'red'; }
    update(frameScale=1) {
      this.timer+=frameScale;
      const state=this.vs;
      this.bulbs.forEach((bulb,i)=>bulb.material.color.setHex(state===['red','yellow','green'][i]
        ? [0xff3322,0xffbb22,0x33ee55][i] : 0x302f2e));
    }
  }

  function createTrafficLights() {
    lights.forEach(light=>scene.remove(light.root)); lights.length=0;
    const {roads}=roadLayout(WORLD_EXTENT+getExpansionLevel());
    const seen=new Set();
    for(const vertical of roads.filter(r=>r.axis==='z'))for(const horizontal of roads.filter(r=>r.axis==='x')) {
      const x=vertical.fixed,z=horizontal.fixed,key=`${x},${z}`;
      if(seen.has(key)||x<horizontal.min||x>horizontal.max||z<vertical.min||z>vertical.max)continue;
      seen.add(key);new TrafficLight(x,z,0);
    }
  }

  function getCarTrafficLight(car,angle) {
    const fx=Math.sin(angle), fz=Math.cos(angle);
    let result=null, distance=130;
    for (const light of lights) {
      if (Math.abs(fz)>.7 && Math.abs(light.x-car.position.x)<5.5) {
        const d=fz*(light.z-car.position.z);
        if (d>0&&d<distance) {distance=d; result={state:light.vs,dist:d};}
      }
      if (Math.abs(fx)>.7 && Math.abs(light.z-car.position.z)<5.5) {
        const d=fx*(light.x-car.position.x);
        if (d>0&&d<distance) {distance=d; result={state:light.hs,dist:d};}
      }
    }
    return result;
  }

  function buildTukTuk(group,color) {
    const chassis=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.42,2.65),material(0x202326));
    chassis.position.y=0.55; group.add(chassis);
    const front=new THREE.Mesh(new THREE.BoxGeometry(1.45,1.05,0.95),material(color));
    front.position.set(0,1.05,0.68); group.add(front);
    const canopy=new THREE.Mesh(new THREE.BoxGeometry(1.72,0.22,1.85),material(color));
    canopy.position.set(0,1.72,-0.34); group.add(canopy);
    const windscreen=new THREE.Mesh(new THREE.BoxGeometry(1.18,0.63,0.08),material(0x7196aa));
    windscreen.position.set(0,1.28,1.19); group.add(windscreen);
    const seat=new THREE.Mesh(new THREE.BoxGeometry(1.18,0.7,0.22),material(0x4b3532));
    seat.position.set(0,0.98,-0.68); group.add(seat);
    const wheelMaterial=material(0x161616);
    [[0,1.02],[-0.82,-0.86],[0.82,-0.86]].forEach(([x,z])=>{
      const wheel=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,0.22,12),wheelMaterial);
      wheel.rotation.z=Math.PI/2; wheel.position.set(x,0.36,z); group.add(wheel);
    });
  }

  class Vehicle {
    constructor(road,direction,kind,phase,index) {
      this.road=road; this.direction=direction; this.kind=kind;
      this.radius=kind==='tuktuk'?1.65:2.25;
      this.width=kind==='tuktuk'?1.7:2.1;this.length=kind==='tuktuk'?3.1:4.2;
      this.desiredMps=(road.arterial?22:kind==='tuktuk'?9:11)+(index%4);
      this.speed=0;
      this.avoidOffset=0;
      this.phase=phase;
      this.index=index;
      this.obeySignals=true;
      this.wrongWay=false;
      this.group=new THREE.Group();
      this.group.userData.dynamicActor=true;
      this.group.userData.width=this.width;this.group.userData.length=this.length;
      const color=colors[index%colors.length];
      if (kind==='tuktuk') buildTukTuk(this.group,color);
      else {
        const body=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.68,4),material(color));
        body.position.y=0.7; this.group.add(body);
        const cab=new THREE.Mesh(new THREE.BoxGeometry(1.65,0.62,2),material(0x446071));
        cab.position.set(0,1.32,-0.15); this.group.add(cab);
        for (const x of [-1.1,1.1]) for (const z of [-1.3,1.3]) {
          const wheel=new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.34,0.25,12),material(0x171717));
          wheel.rotation.z=Math.PI/2; wheel.position.set(x,0.38,z); this.group.add(wheel);
        }
      }
      this.group.traverse(part=>{if(part.isMesh)part.castShadow=true;});
      this.group.rotation.y=road.axis==='z'?(direction>0?0:Math.PI):(direction>0?Math.PI/2:-Math.PI/2);
      this.progress=road.min+(road.max-road.min)*phase;
      this.setPosition();
      // Keep the initial player spawn empty.
      if (Math.hypot(this.group.position.x-17.5,this.group.position.z+40)<9) {
        this.progress+=direction*16; this.setPosition();
      }
      this.velocity={x:0,z:0};
      for(let attempt=0;attempt<30&&!motionClear(this.group.position,this.group.rotation.y,0,
        [...vehicles,{position:protectedSpawn,width:5,length:5,heading:0}],this,.6);attempt++) {
        this.progress+=this.direction*7;
        if(this.progress>road.max-4)this.progress=road.min+4;
        if(this.progress<road.min+4)this.progress=road.max-4;
        this.setPosition();
      }
      scene.add(this.group); obstacles.push(this.group); vehicles.push(this);
      if(kind==='car'&&vehicleModels.length) this.setVisual(vehicleModels[index%vehicleModels.length]);
      if(kind==='tuktuk'&&tuktukModels.length) this.setVisual(tuktukModels[index%tuktukModels.length]);
    }
    setPosition() {
      // Keep a committed lane: no oscillating avoidance or opposing-lane drift.
      const lane=this.direction*(this.road.sideStreet?1.5:2.5)+this.avoidOffset;
      if(this.road.axis==='z') this.group.position.set(this.road.fixed-lane,0,this.progress);
      else this.group.position.set(this.progress,0,this.road.fixed+lane);
    }
    setVisual(template) {
      const visual=template.clone(true);
      this.visualKind=this.kind==='tuktuk'?'tuk-tuk':template.userData.visualKind||'car';
      const box=new THREE.Box3().setFromObject(visual);
      const size=box.getSize(new THREE.Vector3());
      const scale=this.kind==='tuktuk'
        ? Math.min(1.7/size.x,3.1/size.z)
        : this.visualKind==='motorcycle'?Math.min(1.0/size.x,2.5/size.z):Math.min(2.1/size.x,4.2/size.z);
      const variedScale=scale*(.96+(this.index%5)*.02);
      visual.scale.setScalar(variedScale);
      visual.position.y=-box.min.y*variedScale+0.08;
      visual.traverse(part=>{if(part.isMesh)part.castShadow=true;});
      this.group.clear(); this.group.add(visual);
    }
    update(frameScale=1) {
      const dt=frameScale/60,previous={x:this.group.position.x,z:this.group.position.z};
      const player=getPlayer(),heading=this.group.rotation.y;
      const ownEvent=incidents.forVehicle(this),surface=surfaceAt(previous.x,previous.z);
      const others=vehicles.filter(v=>v!==this&&Math.hypot(v.group.position.x-previous.x,v.group.position.z-previous.z)<85);
      others.push(...pedestrians.filter(p=>Math.hypot(p.group.position.x-previous.x,p.group.position.z-previous.z)<25));
      if(player)others.push({position:player.position,heading:player.rotation.y,width:1.86,length:4.72,radius:2.5,velocity:player.userData.velocity??{x:0,z:0}});
      const endDistance=this.direction*((this.direction>0?this.road.max:this.road.min)-this.progress);
      if(!this.turn&&endDistance<8)this.turn=endTurn(this.road,this.direction,districtRoads,this.index);
      let target=Math.min(this.desiredMps,surface.limit/3.6),stop=Infinity;
      if(endDistance<22)target=Math.min(target,Math.sqrt(3.2**2+2*2.5*Math.max(0,endDistance-8)));
      if(ownEvent&&ownEvent.type!=='cutin')target=0;
      if(ownEvent?.type==='cutin')target=Math.min(target,6.5);
      const wantedOffset=ownEvent?.type==='cutin'?this.direction*-.8:0;
      const oldOffset=this.avoidOffset;
      this.avoidOffset+=Math.max(-.018*frameScale,Math.min(.018*frameScale,wantedOffset-this.avoidOffset));
      for(const light of lights) {
        const parallel=this.road.axis==='z'?Math.abs(light.x-this.road.fixed)<1:Math.abs(light.z-this.road.fixed)<1;
        const d=this.direction*((this.road.axis==='z'?light.z:light.x)-this.progress);
        const state=this.road.axis==='z'?light.vs:light.hs;
        if(parallel&&d>5&&state!=='green')stop=Math.min(stop,d-7);
      }
      const lead=leadVehicle(previous,heading,others,this);
      // Keep the junction box clear when the receiving lane is queued.
      if(lead.velocity<1)for(const light of lights) {
        const parallel=this.road.axis==='z'?Math.abs(light.x-this.road.fixed)<1:Math.abs(light.z-this.road.fixed)<1;
        const d=this.direction*((this.road.axis==='z'?light.z:light.x)-this.progress);
        if(parallel&&d>6&&d<25&&lead.gap<d+6)stop=Math.min(stop,d-7);
      }
      const gap=Math.min(lead.gap,stop),leadSpeed=stop<lead.gap?0:lead.velocity;
      this.debug={gap,stop,lead:lead.leader?.index,target,turn:Boolean(this.turn)};
      const acceleration=followingAcceleration(this.speed*60,target,gap,leadSpeed,{grip:surface.grip,headway:1.15,minimumGap:1});
      this.speed=Math.max(0,Math.min(this.speed*60+acceleration*dt,safeFollowingSpeed(gap,leadSpeed,surface.grip)))/60;
      if(this.speed<.00001&&Math.abs(this.avoidOffset-oldOffset)<.00001){this.velocity={x:0,z:0};return;}
      const oldProgress=this.progress,oldHeading=this.group.rotation.y,oldCursor=this.turn?.cursor??0;
      this.progress+=this.direction*this.speed*frameScale;
      let wrapped=false;
      if(this.turn) {
        this.turn.cursor=Math.min(this.turn.points.at(-1).s,this.turn.cursor+this.speed*frameScale);
        const idx=this.turn.points.findIndex(p=>p.s>=this.turn.cursor),b=this.turn.points[Math.max(1,idx)],a=this.turn.points[Math.max(0,idx-1)];
        const t=(this.turn.cursor-a.s)/Math.max(.001,b.s-a.s);
        this.group.position.set(a.x+(b.x-a.x)*t,0,a.z+(b.z-a.z)*t);
        this.group.rotation.y=Math.atan2(b.x-a.x,b.z-a.z);
      } else if(this.progress>this.road.max||this.progress<this.road.min) {
        const entry=this.progress>this.road.max?this.road.min:this.road.max;
        const far=!player||Math.hypot(previous.x-player.position.x,previous.z-player.position.z)>100;
        if(far){this.progress=entry;wrapped=true;}else{this.progress=oldProgress;this.speed=0;}
      }
      if(!this.turn)this.setPosition();
      const dx=this.group.position.x-previous.x,dz=this.group.position.z-previous.z;
      const movementHeading=Math.atan2(dx,dz),travel=Math.hypot(dx,dz);
      const clear=wrapped?motionClear(this.group.position,heading,0,others,this,.18)
        :motionClear(previous,movementHeading,travel,others,this,.16)
          &&motionClear(this.group.position,this.group.rotation.y,0,others,this,.16);
      if(!clear){this.progress=oldProgress;this.avoidOffset=oldOffset;this.group.position.set(previous.x,0,previous.z);this.group.rotation.y=oldHeading;this.speed=0;if(this.turn)this.turn.cursor=oldCursor;}
      if(this.turn&&this.turn.cursor>=this.turn.points.at(-1).s){
        this.road=this.turn.road;this.direction=this.turn.direction;this.turn=null;this.avoidOffset=0;
        this.progress=this.road.axis==='z'?this.group.position.z:this.group.position.x;
        this.group.rotation.y=this.road.axis==='z'?(this.direction>0?0:Math.PI):(this.direction>0?Math.PI/2:-Math.PI/2);
      }
      this.velocity=wrapped?{x:0,z:0}:{x:(this.group.position.x-previous.x)/frameScale,z:(this.group.position.z-previous.z)/frameScale};
      this.group.visible=!player||Math.hypot(this.group.position.x-player.position.x,this.group.position.z-player.position.z)<190;
    }
  }

  function initTraffic(protectedPosition={x:17.5,z:-40}) {
    protectedSpawn={x:protectedPosition.x,z:protectedPosition.z};
    vehicles.forEach(vehicle=>{
      scene.remove(vehicle.group);
      const index=obstacles.indexOf(vehicle.group);
      if(index>=0) obstacles.splice(index,1);
    });
    vehicles.length=0;incidents.reset();
    const {roads}=roadLayout(WORLD_EXTENT+getExpansionLevel());
    districtRoads=roads;
    let index=0;
    for (const road of roads) {
      const count=Math.max(2,Math.round((road.arterial?Math.max(2,(road.max-road.min)/38):road.axis==='z'&&road.fixed===20?14:road.sideStreet?4:6)*density));
      for(let n=0;n<count;n++) {
        const kind=(road.sideStreet&&index%3===0)||index%8===0?'tuktuk':'car';
        new Vehicle(road,n%2?1:-1,kind,(n+0.4)/count,index++);
      }
    }
  }

  const loader=new GLTFLoader();
  loadTrafficVisuals().then(models=>{
    vehicleModels.push(...models);
    vehicles.filter(vehicle=>vehicle.kind==='car').forEach(vehicle=>vehicle.setVisual(vehicleModels[vehicle.index%vehicleModels.length]));
  }).catch(error=>console.warn('NPC car models unavailable.',error));
  Promise.all(['auto-rickshaw'].map(name=>
    loader.loadAsync(`/assets/models/tuktuks/${name}.glb`)
  )).then(models=>{
    tuktukModels.push(...models.map(model=>tukTukVisual(model.scene)));
    vehicles.filter(vehicle=>vehicle.kind==='tuktuk').forEach(vehicle=>
      vehicle.setVisual(tuktukModels[vehicle.index%tuktukModels.length]));
  }).catch(error=>console.warn('Tuk-tuk models unavailable; using editable fallback.',error));

  return {lights,vehicles,incidents,initTraffic,createTrafficLights,getCarTrafficLight,
    setPedestrians(value){pedestrians=value;},
    prepareNearMiss() {
      const player=getPlayer();
      // Explicit user-selected fixture. Setup is separate from normal driving:
      // the entry path stays physical and collision-checked after the reset.
      incidents.reset();
      for(const v of vehicles)if(Math.hypot(v.group.position.x-player.position.x,v.group.position.z-player.position.z)<70) {
        v.progress=v.road.min+12+(v.index%5)*8;v.turn=null;v.speed=0;v.avoidOffset=0;v.setPosition();v.velocity={x:0,z:0};
      }
      const v=vehicles.find(v=>v.kind==='car');
      v.road=districtRoads.find(r=>r.axis==='z'&&r.fixed===20&&r.min===100);
      v.direction=1;v.progress=player.position.z+18;v.avoidOffset=3.2;v.turn=null;v.speed=6.5/60;
      v.group.rotation.y=0;v.setPosition();v.velocity={x:0,z:v.speed};
      incidents.active.push({id:10000,type:'cutin',name:'تجربة دخول مفاجئ · فرملة وقائية',vehicle:v,starts:0,ends:8});
    },
    tickEvents(dt){incidents.tick(dt,vehicles,getPlayer().position,conditionsEnabled);},
    setConditions(value){conditionsEnabled=value;if(!value)incidents.active.length=0;},
    setDensity(value){density=value;initTraffic(getPlayer().position);},
    trigger(type){const p=getPlayer();return incidents.trigger(vehicles,{x:p.position.x,z:p.position.z,heading:p.rotation.y},type);},
  };
}
