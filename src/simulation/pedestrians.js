import { roadLayout, isOnRoad } from './road-lanes.js?v=drive-final';
import { canAdvance } from './safety.js?v=drive-final';
import { motionClear } from './vehicle-geometry.js?v=drive-final';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'https://cdn.jsdelivr.net/npm/three@0.152/examples/jsm/utils/SkeletonUtils.js';

export function createPedestrians(THREE,scene,obstacles,getPlayer,getVehicles=()=>[]) {
  const people=[];
  const characterModels=[];
  let districtExtent=100;
  const colors=[0x287f9f,0xb05745,0xb89b4f,0x478067,0x7e5c91,0xd67b42];
  const mat=color=>new THREE.MeshPhongMaterial({color});

  function makePerson(index) {
    const root=new THREE.Group();
    const skin=mat([0xb97851,0xd29a70,0x8e583b,0xe3b896][index%4]);
    const shirt=mat(colors[index%colors.length]);
    const trousers=mat(index%2?0x343b4b:0x554f43);
    const torso=new THREE.Mesh(new THREE.BoxGeometry(0.62,0.82,0.32),shirt);
    torso.position.y=1.25; root.add(torso);
    const head=new THREE.Mesh(new THREE.SphereGeometry(0.24,10,8),skin);
    head.position.y=1.89; root.add(head);
    const hair=new THREE.Mesh(new THREE.SphereGeometry(0.245,10,8),mat(0x29201b));
    hair.scale.y=0.43; hair.position.y=2.04; root.add(hair);
    const legs=[];
    for(const side of [-1,1]) {
      const leg=new THREE.Group(); leg.position.set(side*0.18,0.88,0);
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.72,0.24),trousers);
      mesh.position.y=-0.38; leg.add(mesh); root.add(leg); legs.push(leg);
      const arm=new THREE.Mesh(new THREE.BoxGeometry(0.17,0.65,0.2),skin);
      arm.position.set(side*0.42,1.27,0); root.add(arm);
    }
    root.traverse(part=>{if(part.isMesh)part.castShadow=true;});
    return {root,legs};
  }

  class Pedestrian {
    constructor(road,index,crossing,at) {
      this.road=road; this.index=index; this.crossing=crossing;
      this.radius=0.55;
      this.direction=index%2?1:-1;
      this.side=this.direction;
      this.walkedSinceIdle=0;
      this.targetHeading=null;
      this.progress=crossing?0:(this.direction>0
        ? road.min+(road.max-road.min)*at
        : road.max-(road.max-road.min)*at);
      this.anchor=road.min+(road.max-road.min)*at;
      this.wait=crossing?(index*17)%130:0;
      // Metres per 60 Hz tick: ordinary walking, with a slightly faster crowd.
      this.speed=crossing?0.029:0.022+(index%3)*0.004;
      this.retreating=false;
      const model=makePerson(index);
      this.group=model.root; this.legs=model.legs;
      this.group.userData.dynamicActor=true;
      this.velocity={x:0,z:0};
      this.setPosition();
      this.group.rotation.y=this.targetHeading;
      scene.add(this.group); obstacles.push(this.group); people.push(this);
      if(characterModels.length) this.setVisual(characterModels[index%characterModels.length]);
    }
    setVisual(template) {
      const visual=cloneSkeleton(template.scene??template);
      const box=new THREE.Box3().setFromObject(visual);
      const size=box.getSize(new THREE.Vector3());
      const scale=(1.62+(this.index%5)*0.065)/size.y;
      visual.scale.setScalar(scale);
      visual.position.y=-box.min.y*scale;
      visual.traverse(part=>{if(part.isMesh)part.castShadow=true;});
      this.group.clear(); this.group.add(visual); this.legs=[];
      this.mixer=new THREE.AnimationMixer(this.group);
      this.actions={};
      for(const name of ['walk','idle']) {
        const clip=template.animations?.find(animation=>animation.name.toLowerCase()===name);
        if(clip) this.actions[name]=this.mixer.clipAction(clip);
      }
      this.playAction('idle');
    }
    playAction(name) {
      const next=this.actions?.[name];
      if(!next||this.currentAction===next) return;
      next.reset().fadeIn(0.18).play();
      this.currentAction?.fadeOut(0.18);
      this.currentAction=next;
    }
    setPosition() {
      const side=this.crossing?this.direction:this.side;
      const edge=this.road.width/2+1.5;
      const lateral=this.crossing ? side*(edge-this.progress) : side*edge;
      const headingSide=this.retreating?-side:side;
      if(this.road.axis==='z') {
        this.group.position.set(this.road.fixed+lateral,Math.abs(lateral)>this.road.width/2?.25:.08,this.anchor+(this.crossing?0:this.progress-this.anchor));
        this.targetHeading=this.crossing?(headingSide>0?Math.PI/2:-Math.PI/2):(this.direction>0?0:Math.PI);
      } else {
        this.group.position.set(this.anchor+(this.crossing?0:this.progress-this.anchor),Math.abs(lateral)>this.road.width/2?.25:.08,this.road.fixed+lateral);
        this.targetHeading=this.crossing?(headingSide>0?Math.PI:0):(this.direction>0?Math.PI/2:-Math.PI/2);
      }
      this.group.position.y=isOnRoad(this.group.position.x,this.group.position.z,districtExtent,5)?.08:.25;
    }
    update(frame,deltaSeconds,frameScale) {
      const smoothTurn=()=>{
        const error=Math.atan2(Math.sin(this.targetHeading-this.group.rotation.y),Math.cos(this.targetHeading-this.group.rotation.y));
        this.group.rotation.y+=error*(1-Math.exp(-deltaSeconds*4));
      };
      const old={x:this.group.position.x,z:this.group.position.z};
      if(this.wait>0) {
        this.wait-=frameScale; this.velocity={x:0,z:0};
        this.playAction('idle'); this.mixer?.update(deltaSeconds);smoothTurn(); return;
      }
      const oldProgress=this.progress;
      const travelDirection=this.crossing?(this.retreating?-1:1):this.direction;
      this.progress+=travelDirection*this.speed*frameScale;
      let wrapped=false;
      if(this.crossing&&this.progress>this.road.width+3) {
        this.progress=0; this.direction*=-1; this.wait=50+(this.index*11)%90;
      }
      if(this.crossing&&this.retreating&&this.progress<=0) {
        this.progress=0; this.retreating=false; this.wait=35+(this.index*7)%65;
      }
      if(!this.crossing&&this.direction>0&&this.progress>this.road.max-5) {this.progress=this.road.max-5;this.direction=-1;this.wait=90;}
      if(!this.crossing&&this.direction<0&&this.progress<this.road.min+5) {this.progress=this.road.min+5;this.direction=1;this.wait=90;}
      this.setPosition();
      const player=getPlayer();
      const travel=Math.hypot(this.group.position.x-old.x,this.group.position.z-old.z);
      const blockedByTraffic=!motionClear(wrapped?this.group.position:old,Math.atan2(this.group.position.x-old.x,this.group.position.z-old.z),wrapped?0:travel,getVehicles(),{width:1.1,length:1.1},.1);
      if(blockedByTraffic||player&&!canAdvance(wrapped?this.group.position:old,{x:this.group.position.x,z:this.group.position.z},
        [{position:player.position,radius:2.2}],this.radius+0.6)) {
        this.progress=oldProgress; this.group.position.set(old.x,this.group.position.y,old.z);
        if(this.crossing) this.retreating=true;
      }
      this.velocity=wrapped?{x:0,z:0}:{x:(this.group.position.x-old.x)/frameScale,z:(this.group.position.z-old.z)/frameScale};
      const moving=Math.hypot(this.velocity.x,this.velocity.z)>0.0001;
      this.walkedSinceIdle+=Math.hypot(this.group.position.x-old.x,this.group.position.z-old.z);
      if(!this.crossing&&this.walkedSinceIdle>18+(this.index%4)*7){
        this.wait=90+(this.index%3)*60;this.walkedSinceIdle=0;
      }
      smoothTurn();
      this.playAction(moving?'walk':'idle');
      if(this.mixer) this.mixer.update(deltaSeconds);
      else {
        const swing=moving?Math.sin(frame*0.07+this.index)*0.24:0;
        if(this.legs.length) {this.legs[0].rotation.x=swing; this.legs[1].rotation.x=-swing;}
        else if(this.group.children[0]) this.group.children[0].rotation.z=Math.sin(frame*0.055+this.index)*0.012;
      }
    }
  }

  function initPedestrians(extent=100) {
    districtExtent=extent;
    people.forEach(person=>{
      scene.remove(person.group);
      const index=obstacles.indexOf(person.group);
      if(index>=0)obstacles.splice(index,1);
    });
    people.length=0;
    const roads=roadLayout(extent).roads;
    let index=0;
    for(const road of roads) {
      // Baseline traffic: ordinary sidewalk trips only. Crossing scenarios are later work.
      const count=road.axis==='z'&&road.fixed===20?8:2;
      for(let n=0;n<count;n++) new Pedestrian(road,index++,false,(n+0.4)/count);
    }
  }

  const loader=new GLTFLoader();
  Promise.all('abcdef'.split('').map(letter=>
    loader.loadAsync(`/assets/models/pedestrians/character-${letter}.glb`)
  )).then(models=>{
    characterModels.push(...models.map(model=>({scene:model.scene,animations:model.animations})));
    people.forEach(person=>person.setVisual(characterModels[person.index%characterModels.length]));
  }).catch(error=>console.warn('Pedestrian models unavailable; using fallback figures.',error));

  return {people,initPedestrians};
}
