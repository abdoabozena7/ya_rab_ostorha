import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/loaders/GLTFLoader.js';
import { roadLayout } from './road-lanes.js';
import { canAdvance } from './safety.js';

export function createTrafficSystem(THREE, scene, obstacles, getExpansionLevel, getPlayer) {
  const vehicles = [];
  const lights = [];
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
    get vs() { const t=this.timer%360; return t<160?'green':t<200?'yellow':'red'; }
    get hs() { const t=(this.timer+180)%360; return t<160?'green':t<200?'yellow':'red'; }
    update(frameScale=1) {
      this.timer+=frameScale;
      const state=this.vs;
      this.bulbs.forEach((bulb,i)=>bulb.material.color.setHex(state===['red','yellow','green'][i]
        ? [0xff3322,0xffbb22,0x33ee55][i] : 0x302f2e));
    }
  }

  function createTrafficLights() {
    lights.forEach(light=>scene.remove(light.root)); lights.length=0;
    const {xs,zs,roads}=roadLayout(100+getExpansionLevel());
    xs.filter((_,i)=>i%2===0).forEach((x,i)=>
      zs.filter((_,j)=>j%2===0).forEach((z,j)=>{
        if (Math.abs(x)<45&&Math.abs(z)<45) return;
        if(!roads.some(road=>road.axis==='z'&&road.fixed===x&&z>=road.min&&z<=road.max) ||
           !roads.some(road=>road.axis==='x'&&road.fixed===z&&x>=road.min&&x<=road.max)) return;
        new TrafficLight(x,z,(i+j)%2?180:0);
      }));
  }

  function getCarTrafficLight(car,angle) {
    const fx=Math.sin(angle), fz=Math.cos(angle);
    let result=null, distance=22;
    for (const light of lights) {
      if (Math.abs(light.x-car.position.x)<5.5) {
        const d=fz*(light.z-car.position.z);
        if (d>0&&d<distance) {distance=d; result={state:light.vs,dist:d};}
      }
      if (Math.abs(light.z-car.position.z)<5.5) {
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
      this.speed=(kind==='tuktuk'?0.19:0.13)+(index%4)*0.018;
      this.avoidOffset=0;
      this.phase=phase;
      this.index=index;
      this.obeySignals=index%5===0; // Most traffic ignores the lights.
      this.wrongWay=index%11===0;
      this.group=new THREE.Group();
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
      scene.add(this.group); obstacles.push(this.group); vehicles.push(this);
      if(kind==='car'&&vehicleModels.length) this.setVisual(vehicleModels[index%vehicleModels.length]);
      if(kind==='tuktuk'&&tuktukModels.length) this.setVisual(tuktukModels[index%tuktukModels.length]);
    }
    setPosition() {
      const drift=Math.sin(this.progress*0.055+this.index*2.1)*(this.kind==='tuktuk'?0.9:0.55);
      const lane=this.direction*(this.wrongWay?-1:1)*(this.kind==='tuktuk'?1.5:2.25)+drift+this.avoidOffset;
      if(this.road.axis==='z') this.group.position.set(this.road.fixed-lane,0,this.progress);
      else this.group.position.set(this.progress,0,this.road.fixed+lane);
    }
    setVisual(template) {
      const visual=template.clone(true);
      const box=new THREE.Box3().setFromObject(visual);
      const size=box.getSize(new THREE.Vector3());
      const scale=this.kind==='tuktuk'
        ? Math.min(1.7/size.x,3.1/size.z)
        : Math.min(2.1/size.x,4.2/size.z);
      visual.scale.setScalar(scale);
      visual.position.y=-box.min.y*scale+0.05;
      visual.traverse(part=>{if(part.isMesh)part.castShadow=true;});
      this.group.clear(); this.group.add(visual);
    }
    update(frameScale=1) {
      const previous={x:this.group.position.x,z:this.group.position.z};
      if(this.obeySignals&&lights.some(light=>{
        const parallel=this.road.axis==='z'
          ? Math.abs(light.x-this.road.fixed)<1 : Math.abs(light.z-this.road.fixed)<1;
        const distance=this.direction*(this.road.axis==='z'
          ? light.z-this.progress : light.x-this.progress);
        const state=this.road.axis==='z'?light.vs:light.hs;
        return parallel&&distance>2&&distance<8&&state!=='green';
      })) {this.velocity={x:0,z:0};return;}
      const player=getPlayer();
      const baseLane=this.direction*(this.wrongWay?-1:1)*(this.kind==='tuktuk'?1.5:2.25)
        +Math.sin(this.progress*0.055+this.index*2.1)*(this.kind==='tuktuk'?0.9:0.55);
      if(player) {
        const along=this.road.axis==='z'?player.position.z-this.progress:player.position.x-this.progress;
        const playerLane=this.road.axis==='z'?this.road.fixed-player.position.x:player.position.z-this.road.fixed;
        const vehicleLane=this.road.axis==='z'?this.road.fixed-previous.x:previous.z-this.road.fixed;
        if(Math.abs(along)<12&&Math.abs(playerLane-vehicleLane)<5) {
          const edge=this.road.width/2-(this.kind==='tuktuk'?0.95:1.25);
          const targetLane=(playerLane>=vehicleLane?-1:1)*edge;
          const desiredOffset=targetLane-baseLane;
          this.avoidOffset+=(desiredOffset-this.avoidOffset)*Math.min(1,0.08*frameScale);
        } else this.avoidOffset*=Math.max(0,1-0.035*frameScale);
      }
      const ownLane=this.road.axis==='z'?this.road.fixed-this.group.position.x:this.group.position.z-this.road.fixed;
      const leader=vehicles.some(other=>{
        if(other===this||other.road!==this.road||other.direction!==this.direction) return false;
        const otherLane=this.road.axis==='z'?this.road.fixed-other.group.position.x:other.group.position.z-this.road.fixed;
        const gap=this.direction*(other.progress-this.progress);
        return Math.abs(otherLane-ownLane)<2.8&&gap>0&&gap<this.radius+other.radius+1.2;
      });
      if(leader) {this.velocity={x:0,z:0};return;}
      const oldProgress=this.progress;
      this.progress+=this.direction*this.speed*frameScale;
      let wrapped=false;
      if(this.progress>this.road.max) {this.progress=this.road.min;wrapped=true;}
      if(this.progress<this.road.min) {this.progress=this.road.max;wrapped=true;}
      this.setPosition();
      const protectedPlayer=player&& !canAdvance(wrapped?this.group.position:previous,
        {x:this.group.position.x,z:this.group.position.z},
        [{position:player.position,radius:2.2}],this.radius+0.65);
      if(protectedPlayer) {this.progress=oldProgress; this.group.position.set(previous.x,0,previous.z);}
      this.velocity=wrapped?{x:0,z:0}:{x:this.group.position.x-previous.x,z:this.group.position.z-previous.z};
    }
  }

  function initTraffic() {
    vehicles.forEach(vehicle=>{
      scene.remove(vehicle.group);
      const index=obstacles.indexOf(vehicle.group);
      if(index>=0) obstacles.splice(index,1);
    });
    vehicles.length=0;
    const {roads}=roadLayout(100+getExpansionLevel());
    let index=0;
    for (const road of roads) {
      const count=road.sideStreet?4:2;
      for(let n=0;n<count;n++) {
        const kind=road.sideStreet||index%4===0?'tuktuk':'car';
        new Vehicle(road,n%2?1:-1,kind,(n+0.4)/count,index++);
      }
    }
  }

  const loader=new GLTFLoader();
  Promise.all(['sedan','taxi','suv','van','ambulance'].map(name=>
    loader.loadAsync(`/assets/models/vehicles/${name}.glb`)
  )).then(models=>{
    vehicleModels.push(...models.map(model=>model.scene));
    vehicles.forEach(vehicle=>vehicle.setVisual(vehicleModels[vehicle.index%vehicleModels.length]));
  }).catch(error=>console.warn('NPC car models unavailable.',error));
  Promise.all(['auto-rickshaw','street-food-tuktuk'].map(name=>
    loader.loadAsync(`/assets/models/tuktuks/${name}.glb`)
  )).then(models=>{
    tuktukModels.push(...models.map(model=>model.scene));
    vehicles.filter(vehicle=>vehicle.kind==='tuktuk').forEach(vehicle=>
      vehicle.setVisual(tuktukModels[vehicle.index%tuktukModels.length]));
  }).catch(error=>console.warn('Tuk-tuk models unavailable; using editable fallback.',error));

  return {lights,vehicles,initTraffic,createTrafficLights,getCarTrafficLight};
}
