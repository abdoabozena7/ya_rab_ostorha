import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152/build/three.module.js';
import { findRoute, hasArrived } from './simulation/pathfinding.js';
import { limitForwardSpeed, guardDynamicMotion, canAdvance } from './simulation/safety.js';
import { loadCarModel } from './render/car-model.js';
import { createBridge } from './simulation/bridge.js';
import { createSensors } from './simulation/sensors.js';
import { updateAstarPanel } from './ui/astar-panel.js';
import { createTrafficSystem } from './simulation/traffic.js';
import { createCity } from './render/city.js';
import { PLACES } from './simulation/places.js';
import { addPlaceSigns } from './render/place-signs.js';
import { mountPhone } from './ui/phone.js';
import { constrainToRoad, isOnRoad } from './simulation/road-lanes.js';
import { createPedestrians } from './simulation/pedestrians.js';

/* ═══════════════════════════════════════════════════════════════
   SCENE
═══════════════════════════════════════════════════════════════ */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0xb8d8f0, 200, 550);

let obstacles      = [];
let safetyWarning  = false;
let money          = 0;
let points         = 0;
let expansionLevel = 0;
let frameCount     = 0;

let fuel           = 100;
let petrolBunks    = [];
let isRefilling    = false;
let spawnPoint, destination;
let activePlace = PLACES[0];
let namedTripComplete = false;

/* ── AI state ── */
let aiMode            = false;
let fitness           = 0;
let distanceTravelled = 0;
let lastCarPos        = new THREE.Vector3();

/* ── Path ── */
let path         = [];
let pathLines    = [];
let routeVisible = false;
let waypointIdx  = 0;

/* ── Destination collect loop ── */
let destCollecting   = false;

/* ── Stuck recovery ── */
let stuckTimer  = 0;
const STUCK_MAX = 100;

/* ── Collision cooldown ── */
let colCooldown = 0;
const COL_FRAMES = 120;

/* ── Smooth obstacle avoidance state ── */
let smoothAvoidSteer = 0;
let avoidLockDir     = 0;
let avoidLockTimer   = 0;
let stuckEscapeSteer = 0;
let stuckEscapeFrames= 0;
const AVOID_LOCK_FRAMES = 40;

/* ── AI Tuning ── */
const LANE_OFFSET  = 2.5;
const CRUISE_SPD   = 50/120;
const TURN_SPD     = 0.06;
const ACCEL        = 0.005;
const BRAKE        = 0.018;
const MAX_STEER    = 0.045;
const WP_NORMAL    = 5;
const WP_CORNER    = 3;

/* ── Traffic light constants ── */
const TL_STOP_LINE = 8;

const astarPanel=document.getElementById('astarPanel');

/* ═══════════════════════════════════════════════════════════════
   RENDERER
═══════════════════════════════════════════════════════════════ */
let driverView = false;
const camera     = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 5000);
const frontCamera = new THREE.PerspectiveCamera(75, 16/9, 0.1, 600);
const miniCamera = new THREE.OrthographicCamera(-100,100,100,-100,1,2000);
const renderer   = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.shadowMap.enabled = false;
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ═══════════════════════════════════════════════════════════════
   LIGHTING
═══════════════════════════════════════════════════════════════ */
scene.add(new THREE.AmbientLight(0xcce8ff, 0.6));
const sun = new THREE.DirectionalLight(0xfff5d0, 1.2);
sun.position.set(150,300,200); sun.castShadow = false;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.near=1; sun.shadow.camera.far=800;
sun.shadow.camera.left=sun.shadow.camera.bottom=-300;
sun.shadow.camera.right=sun.shadow.camera.top=300;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x87ceeb,0x3a7d44,0.45));

const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000,3000),
    new THREE.MeshPhongMaterial({ color:0x4a7c59 }));
ground.rotation.x=-Math.PI/2; ground.position.y=-0.06;
ground.receiveShadow=true; scene.add(ground);

const trafficSystem=createTrafficSystem(THREE,scene,obstacles,()=>expansionLevel,()=>car);
const trafficLights=trafficSystem.lights;
const npcVehicles=trafficSystem.vehicles;
const {initTraffic,createTrafficLights}=trafficSystem;
const getCarTrafficLight=()=>trafficSystem.getCarTrafficLight(car,angle);

/* ═══════════════════════════════════════════════════════════════
   PETROL BUNKS
═══════════════════════════════════════════════════════════════ */
function createPetrolBunks(){
    petrolBunks.forEach(b=>{ scene.remove(b); scene.remove(b.userData.station); }); petrolBunks=[];
    const rng=100+expansionLevel;
    [{x:-rng,z:-rng},{x:rng,z:-rng},{x:-rng,z:rng},{x:rng,z:rng}].forEach(pos=>{
        const g=new THREE.Group();
        g.add(new THREE.Mesh(new THREE.BoxGeometry(12,0.2,9),new THREE.MeshPhongMaterial({color:0xcccccc})));
        const can=new THREE.Mesh(new THREE.BoxGeometry(12,0.35,9),new THREE.MeshPhongMaterial({color:0xff6600}));
        can.position.y=5.5; g.add(can);
        [[-5,-3.5],[5,-3.5],[-5,3.5],[5,3.5]].forEach(([dx,dz])=>{
            const p=new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,5.5,8),new THREE.MeshPhongMaterial({color:0x999999}));
            p.position.set(dx,2.75,dz); g.add(p);
        });
        const pump=new THREE.Mesh(new THREE.BoxGeometry(1.2,2,0.7),new THREE.MeshPhongMaterial({color:0xff6600}));
        pump.position.set(0,1,0); g.add(pump);
        const scr=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.5,0.1),
            new THREE.MeshPhongMaterial({color:0x00ffcc,emissive:0x00ffcc,emissiveIntensity:0.6}));
        scr.position.set(0,1.5,0.4); g.add(scr);
        g.position.set(pos.x,0.1,pos.z); scene.add(g);
        const mkr=new THREE.Mesh(new THREE.CylinderGeometry(5,5,0.1,16),
            new THREE.MeshPhongMaterial({transparent:true,opacity:0}));
        mkr.position.set(pos.x,0.5,pos.z); mkr.userData.station=g; scene.add(mkr); petrolBunks.push(mkr);
    });
}
function checkPetrolBunk(){
    if(isRefilling||aiMode) return;
    petrolBunks.forEach(bunk=>{
        if(car.position.distanceTo(bunk.position)<9){
            isRefilling=true; speed=0;
            const fill=prompt('⛽ Petrol Bunk!\nHow much % to fill? (10 ج per 1%)','50');
            const amt=Number(fill);
            if(Number.isInteger(amt)&&amt>0){
                const added=Math.min(amt,Math.ceil(100-fuel));
                const cost=added*10;
                if(money>=cost){fuel=Math.min(100,fuel+added);money-=cost;}
                else alert('Not enough money!');
            }
            setTimeout(()=>{ isRefilling=false; },3000);
        }
    });
}

const {roadNodes,buildCitySegment}=createCity(THREE,scene,obstacles,{initTraffic,createPetrolBunks,createTrafficLights});
buildCitySegment(0);
addPlaceSigns(THREE,scene);

function createSpawn(){
    spawnPoint=new THREE.Mesh(new THREE.CylinderGeometry(2.2,2.2,0.12,32),
        new THREE.MeshPhongMaterial({color:0x0055ff,emissive:0x0033cc,emissiveIntensity:0.5}));
    spawnPoint.position.set(17.5,0.07,-40); scene.add(spawnPoint);
}
function createDestination(place=activePlace){
    if(destination) scene.remove(destination);
    destination=new THREE.Mesh(new THREE.CylinderGeometry(2.2,2.2,0.5,32),
        new THREE.MeshPhongMaterial({color:0xffdd00,emissive:0xffaa00,emissiveIntensity:0.8}));
    destination.position.set(place.x,0.3,place.z); scene.add(destination);
}
createSpawn();

/* ═══════════════════════════════════════════════════════════════
   PLAYER CAR
═══════════════════════════════════════════════════════════════ */
const car=new THREE.Group(); car.position.set(17.5,0.5,-40);
const pedestrianSystem=createPedestrians(THREE,scene,obstacles,()=>car);
const pedestrians=pedestrianSystem.people;
pedestrianSystem.initPedestrians();
const fallbackCar=new THREE.Group(); fallbackCar.name='fallback-car'; car.add(fallbackCar);
const carBody=new THREE.Mesh(new THREE.BoxGeometry(2,0.68,4),new THREE.MeshPhongMaterial({color:0xff2244,shininess:120}));
carBody.castShadow=true; fallbackCar.add(carBody);
const cabin=new THREE.Mesh(new THREE.BoxGeometry(1.62,0.58,2.1),new THREE.MeshPhongMaterial({color:0x1a1a3e,shininess:90}));
cabin.position.set(0,0.63,-0.15); cabin.castShadow=true; fallbackCar.add(cabin);
const wsMat=new THREE.MeshPhongMaterial({color:0x88ccff,transparent:true,opacity:0.55,shininess:200});
const wsF=new THREE.Mesh(new THREE.BoxGeometry(1.55,0.52,0.08),wsMat); wsF.position.set(0,0.63,0.9); fallbackCar.add(wsF);
const wsR=wsF.clone(); wsR.position.set(0,0.63,-1.2); fallbackCar.add(wsR);
const wgeo=new THREE.CylinderGeometry(0.38,0.38,0.28,16);
const wmat=new THREE.MeshPhongMaterial({color:0x111111});
const rmat=new THREE.MeshPhongMaterial({color:0xbbbbbb,shininess:100});
[[-1.12,-0.32,1.45],[1.12,-0.32,1.45],[-1.12,-0.32,-1.45],[1.12,-0.32,-1.45]].forEach(([x,y,z])=>{
    const w=new THREE.Mesh(wgeo,wmat); w.rotation.z=Math.PI/2; w.position.set(x,y,z); w.castShadow=true; fallbackCar.add(w);
    const r=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.22,0.29,8),rmat); r.rotation.z=Math.PI/2; r.position.set(x,y,z); fallbackCar.add(r);
});
const hmat=new THREE.MeshPhongMaterial({color:0xffffcc,emissive:0xffffaa,emissiveIntensity:1.2});
[-0.65,0.65].forEach(x=>{ const hl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.22,0.1),hmat); hl.position.set(x,0.05,2.06); fallbackCar.add(hl); });
const tmat=new THREE.MeshPhongMaterial({color:0xff2200,emissive:0xff0000,emissiveIntensity:0.9});
[-0.65,0.65].forEach(x=>{ const tl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.22,0.1),tmat); tl.position.set(x,0.05,-2.06); fallbackCar.add(tl); });
const bmp=new THREE.Mesh(new THREE.BoxGeometry(2.1,0.22,0.12),new THREE.MeshPhongMaterial({color:0x111111}));
bmp.position.set(0,-0.24,2.06); fallbackCar.add(bmp);
scene.add(car);
loadCarModel(THREE, car, fallbackCar);
car.getObjectByName('front-camera-mount').add(frontCamera);
frontCamera.rotation.y=Math.PI;
createDestination();

/* Sensor output is shared with route following and the emergency brake. */
const sensorSystem=createSensors(THREE,scene);
const SR=sensorSystem.readings;
const RAY_LENGTH=sensorSystem.range;

function protectPlayerMotion() {
    const actors=[...npcVehicles,...pedestrians];
    const guard=guardDynamicMotion(car.position,angle,speed,actors,2.1);
    speed=guard.speed;
    safetyWarning ||=guard.emergency;
    const end={x:car.position.x+Math.sin(angle)*speed,z:car.position.z+Math.cos(angle)*speed};
    if(!canAdvance(car.position,end,actors,2.65)) {speed=0; safetyWarning=true;}
}

function moveWithoutContact(x,z) {
    const oldX=car.position.x, oldZ=car.position.z;
    car.position.x=x; car.position.z=z;
    car.updateMatrixWorld(true);
    const carBox=new THREE.Box3().setFromObject(car);
    for(const obj of obstacles) {
        if(Math.hypot(obj.position.x-x,obj.position.z-z)>15) continue;
        if(carBox.intersectsBox(new THREE.Box3().setFromObject(obj))) {
            car.position.x=oldX; car.position.z=oldZ;
            speed=0; safetyWarning=true;
            return false;
        }
    }
    return true;
}

/* ═══════════════════════════════════════════════════════════════
   ★  A* PATHFINDING  — axis-aligned only
═══════════════════════════════════════════════════════════════ */
function planRoute(){
    path=findRoute(roadNodes, car.position, destination.position);
    waypointIdx=1; stuckTimer=0;
}
function drawPath(){
    hidePath(); if(!routeVisible||!path.length) return;
    const pts=[new THREE.Vector3(car.position.x,0.5,car.position.z)];
    path.forEach(p=>pts.push(new THREE.Vector3(p.x,0.5,p.z)));
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({color:0x00ffff}));
    scene.add(line); pathLines.push(line);
}
function hidePath(){ pathLines.forEach(l=>{ scene.remove(l); l.geometry?.dispose(); }); pathLines=[]; }

/* ── Right-lane offset ── */
function laneTarget(idx){
    if(idx<1||idx>=path.length) return { x:path[idx]?.x||0, z:path[idx]?.z||0 };
    const wp=path[idx], prev=path[idx-1];
    const dx=wp.x-prev.x, dz=wp.z-prev.z;
    const len=Math.hypot(dx,dz)||1;
    return { x:wp.x+(-dz/len)*LANE_OFFSET, z:wp.z+(dx/len)*LANE_OFFSET };
}

/* ── Corner detection ── */
function isCornerAt(idx){
    if(idx<1||idx>=path.length-1) return false;
    const p0=path[idx-1],p1=path[idx],p2=path[idx+1];
    const a1=Math.atan2(p1.x-p0.x,p1.z-p0.z);
    const a2=Math.atan2(p2.x-p1.x,p2.z-p1.z);
    let diff=a2-a1;
    while(diff>Math.PI)diff-=2*Math.PI; while(diff<-Math.PI)diff+=2*Math.PI;
    return Math.abs(diff)>0.35;
}
function normAngle(a){ while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; }

/* ═══════════════════════════════════════════════════════════════
   PHYSICS
═══════════════════════════════════════════════════════════════ */
let speed=0, angle=0;
const acceleration=0.01, maxSpeed=50/120;
let keys={};
const isPressed=key=>Boolean(keys[key]);
document.addEventListener('keydown',e=>{
    if(e.target instanceof HTMLInputElement) return;
    if(e.key.startsWith('Arrow')) e.preventDefault();
    keys[e.key]=true;
});
document.addEventListener('keyup',  e=>{ keys[e.key]=false; });
window.addEventListener('blur',()=>{ keys={}; });

function moveCar(){
    if(fuel<=0){ speed=0; return; }
    if(isPressed('ArrowUp'))   speed+=acceleration;
    if(isPressed('ArrowDown')) speed-=acceleration;
    speed=Math.max(-maxSpeed/2,Math.min(speed,maxSpeed));
    if(!isPressed('ArrowUp')&&!isPressed('ArrowDown')) speed*=0.95;
    if(Math.abs(speed)>0.001){
        if(isPressed('ArrowLeft'))  angle+=0.03;
        if(isPressed('ArrowRight')) angle-=0.03;
        fuel=Math.max(0,fuel-0.005);
    }
    const guard=limitForwardSpeed(speed,SR[3]*RAY_LENGTH);
    speed=guard.speed;
    safetyWarning=guard.emergency;
    protectPlayerMotion();
    if(guard.emergency) showBanner('⚠️  EMERGENCY BRAKING','red');
    car.rotation.y=angle;
    moveWithoutContact(car.position.x+Math.sin(angle)*speed,
        car.position.z+Math.cos(angle)*speed);
}

/* ═══════════════════════════════════════════════════════════════
   AI DRIVE
═══════════════════════════════════════════════════════════════ */
function aiDrive(){
    if(fuel<=0){ speed=0; return; }

    if(destCollecting){
        speed=0;
        showBanner(`📍 وصلت ${activePlace.name}`,'collect');
        return;
    }

    if(!path||path.length<2){ planRoute(); return; }

    while(waypointIdx<path.length){
        const corner=isCornerAt(waypointIdx);
        const arriveR=corner?WP_CORNER:WP_NORMAL;
        const lt=laneTarget(waypointIdx);
        if(Math.hypot(car.position.x-lt.x,car.position.z-lt.z)>arriveR) break;
        waypointIdx++;
    }
    if(waypointIdx>=path.length){ planRoute(); return; }

    const lt=laneTarget(waypointIdx);
    const desired=Math.atan2(lt.x-car.position.x,lt.z-car.position.z);
    const angleDiff=normAngle(desired-angle);
    const steer=Math.max(-MAX_STEER,Math.min(MAX_STEER,angleDiff*0.15));

    const tlResult=getCarTrafficLight();
    const tlState=tlResult?tlResult.state:null;
    const tlDist =tlResult?tlResult.dist:Infinity;

    const corner=isCornerAt(waypointIdx);
    const nextCorn=isCornerAt(waypointIdx+1);
    const distToWp=Math.hypot(car.position.x-lt.x,car.position.z-lt.z);
    const frontM=SR[3]*RAY_LENGTH;
    const fL30=SR[2]*RAY_LENGTH;
    const fR30=SR[4]*RAY_LENGTH;
    const sideL=SR[0]*RAY_LENGTH;
    const sideR=SR[6]*RAY_LENGTH;

    let targetSpeed=CRUISE_SPD;
    let state='cruise';

    if(tlState==='red'){
        const blend=Math.max(0,Math.min(1,(tlDist-TL_STOP_LINE)/10));
        targetSpeed=CRUISE_SPD*blend;
        state='stop';
    } else if(tlState==='yellow'){
        if(tlDist>TL_STOP_LINE){ targetSpeed=CRUISE_SPD*0.15; state='yellow'; }
    }

    if(state!=='stop'&&state!=='yellow'){
        if(corner||nextCorn){
            const blend=Math.min(1,distToWp/20);
            targetSpeed=TURN_SPD+blend*(targetSpeed-TURN_SPD);
            state='turn';
        }
        if(Math.abs(angleDiff)>0.5){ targetSpeed=Math.min(targetSpeed,TURN_SPD); state='turn'; }
    }

    let rawAvoid=0;
    if(state!=='stop'){
        if(frontM<8){
            const leftSpace=fL30-frontM;
            const rightSpace=fR30-frontM;
            const canPass=Math.max(leftSpace,rightSpace)>2.5;
            targetSpeed=canPass?TURN_SPD:0;
            state='obstacle';
            if(canPass) rawAvoid=(leftSpace>=rightSpace?1:-1)*MAX_STEER*1.35;
        } else if(frontM<20){
            const factor=1-(frontM/20);
            targetSpeed=Math.max(TURN_SPD,targetSpeed*(1-factor*0.6));
            state='obstacle';
            if(avoidLockTimer<=0){ avoidLockDir=(fL30>=fR30)?1:-1; avoidLockTimer=AVOID_LOCK_FRAMES; }
            rawAvoid=avoidLockDir*MAX_STEER*0.6*factor;
        }
        if(sideL<6&&sideR>=sideL) rawAvoid-=MAX_STEER*0.25*(1-(sideL/6));
        if(sideR<6&&sideL>=sideR) rawAvoid+=MAX_STEER*0.25*(1-(sideR/6));
    }
    if(avoidLockTimer>0) avoidLockTimer--;
    else avoidLockDir=0;
    smoothAvoidSteer+=(rawAvoid-smoothAvoidSteer)*0.12;

    const escapeSteer=stuckEscapeFrames>0?stuckEscapeSteer:0;
    if(stuckEscapeFrames>0) stuckEscapeFrames--;
    const finalSteer=Math.max(-MAX_STEER*2.2,Math.min(MAX_STEER*2.2,steer+smoothAvoidSteer+escapeSteer));
    angle+=finalSteer;

    if(escapeSteer) targetSpeed=Math.min(targetSpeed,TURN_SPD);
    targetSpeed=Math.max(0,Math.min(CRUISE_SPD,targetSpeed));
    const brakeRate=(state==='obstacle')?BRAKE*0.35:BRAKE;
    if(speed<targetSpeed) speed=Math.min(targetSpeed,speed+ACCEL);
    else                  speed=Math.max(targetSpeed,speed-brakeRate);
    speed=Math.max(0,speed);

    if(speed>0.001) fuel=Math.max(0,fuel-0.004);
    const guard=limitForwardSpeed(speed,SR[3]*RAY_LENGTH);
    speed=guard.speed;
    safetyWarning=guard.emergency;
    protectPlayerMotion();
    car.rotation.y=angle;
    const next=constrainToRoad(
        car.position.x+Math.sin(angle)*speed,
        car.position.z+Math.cos(angle)*speed,
        100+expansionLevel
    );
    moveWithoutContact(next.x,next.z);

    const moved=car.position.distanceTo(lastCarPos);
    if((state==='obstacle'||safetyWarning)&&speed<0.01&&moved<0.006){
        stuckTimer++;
        if(stuckTimer===60){
            stuckEscapeSteer=(fL30>=fR30?1:-1)*MAX_STEER*1.8;
            stuckEscapeFrames=75;
        }
        if(stuckTimer>STUCK_MAX*3){planRoute();stuckTimer=0;stuckEscapeFrames=0;}
    } else { stuckTimer=0; }

    distanceTravelled+=moved;
    fitness=Math.floor(distanceTravelled*0.5)+points*200;
    document.getElementById('fitnessVal').innerText=fitness;

    if(safetyWarning)        showBanner('⚠️  EMERGENCY BRAKING','red');
    else if(state==='obstacle')   showBanner('⚠️  OBSTACLE — SLOWING','yellow');
    else if(state==='stop')  showBanner('🔴  RED LIGHT — STOPPED','red');
    else if(state==='yellow')showBanner('🟡  YELLOW — READY TO GO','yellow');
    else if(state==='turn')  showBanner('🔄  TURNING','yellow');
    else                     showBanner('🟢  FOLLOWING ROUTE','green');
}

function showBanner(text,cls){
    const b=document.getElementById('aiBanner');
    b.textContent=text; b.className=cls; b.style.display='block';
}

/* ═══════════════════════════════════════════════════════════════
   COLLISION
═══════════════════════════════════════════════════════════════ */
function checkCollision(){
    if(colCooldown>0){ colCooldown--; return; }
    const carBox=new THREE.Box3().setFromObject(car);
    for(const obj of obstacles){
        if(Math.hypot(obj.position.x-car.position.x,obj.position.z-car.position.z)>15) continue;
        const ob=new THREE.Box3().setFromObject(obj);
        if(!carBox.intersectsBox(ob)) continue;
        money-=100; fitness-=50;
        speed*=0.2;
        const ox=(carBox.max.x-ob.min.x<ob.max.x-carBox.min.x)?(carBox.max.x-ob.min.x):-(ob.max.x-carBox.min.x);
        const oz=(carBox.max.z-ob.min.z<ob.max.z-carBox.min.z)?(carBox.max.z-ob.min.z):-(ob.max.z-carBox.min.z);
        if(Math.abs(ox)<Math.abs(oz)) car.position.x-=ox*1.05;
        else                          car.position.z-=oz*1.05;
        if(aiMode){
            const corrected=constrainToRoad(car.position.x,car.position.z,100+expansionLevel);
            car.position.x=corrected.x;
            car.position.z=corrected.z;
            waypointIdx=Math.min(waypointIdx+3,path.length-1);
            stuckTimer=0;
        }
        colCooldown=COL_FRAMES; break;
    }
}

function checkDestination(){
    if(destCollecting||namedTripComplete||!destination) return;
    if(hasArrived(car.position,destination.position)){
        money+=500; points+=1; fitness+=300;
        if(points%5===0){ expansionLevel+=80; buildCitySegment(expansionLevel); pedestrianSystem.initPedestrians(100+expansionLevel); }
        namedTripComplete=true;
        destCollecting=true;
        speed=0;
        showBanner(`📍 وصلت ${activePlace.name}`,'collect');
    }
}

function updateUI(){
    const kmh=Math.abs(speed)*120;
    document.getElementById('speedVal').innerText =kmh.toFixed(1)+' km/h';
    document.getElementById('moneyVal').innerText =money+' ج';
    document.getElementById('pointVal').innerText =points;
    document.getElementById('fuelVal').innerText  =Math.floor(fuel)+'%';
    document.getElementById('fuelFill').style.width  =Math.floor(fuel)+'%';
    document.getElementById('speedFill').style.width =Math.min(100,(kmh/50)*100)+'%';
}

/* Traffic HUD */
const tlDotRed   =document.getElementById('tlDotRed');
const tlDotYellow=document.getElementById('tlDotYellow');
const tlDotGreen =document.getElementById('tlDotGreen');
const tlPanel    =document.getElementById('tlPanel');
function updateTrafficHUD(){
    const tlResult=getCarTrafficLight();
    const st=tlResult?tlResult.state:null;
    if(!st){
        tlPanel.style.opacity='0.35';
        tlDotRed.className='tl-dot'; tlDotYellow.className='tl-dot'; tlDotGreen.className='tl-dot';
        if(!aiMode && !safetyWarning) document.getElementById('aiBanner').style.display='none';
        return;
    }
    tlPanel.style.opacity='1';
    tlDotRed.className   ='tl-dot'+(st==='red'   ?' active-red'   :'');
    tlDotYellow.className='tl-dot'+(st==='yellow'?' active-yellow':'');
    tlDotGreen.className ='tl-dot'+(st==='green' ?' active-green' :'');
    if(!aiMode && !safetyWarning){
        const b=document.getElementById('aiBanner');
        b.style.display='block';
        if(st==='red')        { b.textContent='🔴  RED LIGHT — STOP';   b.className='red'; }
        else if(st==='yellow'){ b.textContent='🟡  YELLOW — SLOW DOWN'; b.className='yellow'; }
        else                  { b.textContent='🟢  GREEN — GO';          b.className='green'; }
    }
}

/* ═══════════════════════════════════════════════════════════════
   MODE TOGGLE
═══════════════════════════════════════════════════════════════ */
const modeOverlay =document.getElementById('modeOverlay');
const modeBadge   =document.getElementById('modeBadge');
const aiStatusEl  =document.getElementById('aiStatus');
const fitnessPanel=document.getElementById('fitnessPanel');
const aiToggleBtn =document.getElementById('aiToggleBtn');

function flashOverlay(isAI){
    modeOverlay.textContent=isAI?'🤖  AI DRIVE ACTIVATED':'🕹️  MANUAL MODE';
    modeOverlay.className  =isAI?'show-ai':'show-manual';
    modeOverlay.style.opacity='1';
    setTimeout(()=>{ modeOverlay.style.opacity='0'; },1600);
}
function setAIMode(on){
    aiMode=on;
    aiToggleBtn.textContent=on?'🕹️  MANUAL MODE':'🤖 ENABLE AI';
    aiToggleBtn.className  =on?'ctrl-btn ai-on':'ctrl-btn';
    modeBadge.textContent  =on?'AI AUTO':'MANUAL';
    modeBadge.className    =on?'ai':'manual';
    aiStatusEl.className   =on?'ai-mode':'';
    fitnessPanel.style.display=on?'block':'none';
    if(on){
        distanceTravelled=0; fitness=0; stuckTimer=0;
        stuckEscapeFrames=0; smoothAvoidSteer=0; avoidLockTimer=0;
        colCooldown=0; destCollecting=namedTripComplete;
        document.getElementById('fitnessVal').innerText='0';
        routeVisible=true;
        if(speed<0) speed=0;
        planRoute();
    } else {
        routeVisible=false; hidePath();
        document.getElementById('aiBanner').style.display='none';
    }
    flashOverlay(on);
}

mountPhone(place=>{
    activePlace=place;
    namedTripComplete=false;
    destCollecting=false;
    speed=0;
    createDestination(place);
    routeVisible=true;
    if(aiMode){ planRoute(); drawPath(); }
    else setAIMode(true);
});

const bridge=createBridge({
    renderer,
    readState: ()=>({
        speedKmh: Number((Math.abs(speed)*120).toFixed(1)),
        fuel: Math.floor(fuel),
        mode: aiMode?'auto':'manual',
        safety: safetyWarning?'emergency-brake':'clear',
        position: {x:Number(car.position.x.toFixed(1)), z:Number(car.position.z.toFixed(1))},
        onRoad: isOnRoad(car.position.x,car.position.z,100+expansionLevel),
        sensorsM: SR.map(value=>Number((value*RAY_LENGTH).toFixed(1))),
        light: getCarTrafficLight()?.state ?? null,
        destination: {id:activePlace.id,x:activePlace.x,z:activePlace.z},
        actors: [...npcVehicles,...pedestrians]
            .filter(actor=>Math.hypot(actor.group.position.x-car.position.x,actor.group.position.z-car.position.z)<45)
            .map(actor=>({
                type:actor.kind??'pedestrian',
                x:Number(actor.group.position.x.toFixed(1)),
                z:Number(actor.group.position.z.toFixed(1)),
                vx:Number(actor.velocity.x.toFixed(2)),
                vz:Number(actor.velocity.z.toFixed(2)),
                radius:actor.radius
            }))
    })
});

/* ═══════════════════════════════════════════════════════════════
   ANIMATION LOOP
═══════════════════════════════════════════════════════════════ */
let previousFrameAt=performance.now();
function animate(timestamp=performance.now()){
    const deltaSeconds=Math.min(0.05,Math.max(0,(timestamp-previousFrameAt)/1000));
    const frameScale=deltaSeconds*60;
    previousFrameAt=timestamp;
    requestAnimationFrame(animate);
    lastCarPos.copy(car.position);
    safetyWarning=false;

    trafficLights.forEach(tl=>tl.update(frameScale));
    npcVehicles.forEach(v=>v.update(frameScale));
    pedestrians.forEach(person=>person.update(frameCount,deltaSeconds,frameScale));
    sensorSystem.update(car,angle,obstacles);
        aiMode ? aiDrive() : moveCar();
        updateUI();
        checkCollision();
        checkDestination();
        checkPetrolBunk();
        updateTrafficHUD();
        updateAstarPanel({routeVisible,path,waypointIdx,destination});

        if(routeVisible&&frameCount%15===0){ if(!aiMode) path=findRoute(roadNodes,car.position,destination.position); drawPath(); }
        if(!routeVisible) hidePath();
    frameCount++;

    if(destination){ destination.rotation.y+=0.03; destination.position.y=0.3+Math.sin(frameCount*0.06)*0.22; }
    if(spawnPoint)  spawnPoint.rotation.y-=0.02;

    if(!driverView){
        camera.position.set(car.position.x-Math.sin(angle)*15,8,car.position.z-Math.cos(angle)*15);
        camera.lookAt(car.position);
    } else {
        camera.position.set(car.position.x+Math.sin(angle)*2,car.position.y+1.5,car.position.z+Math.cos(angle)*2);
        camera.lookAt(car.position.x+Math.sin(angle)*20,car.position.y,car.position.z+Math.cos(angle)*20);
    }
    miniCamera.position.set(car.position.x,300,car.position.z);
    miniCamera.lookAt(car.position);

    const cW=window.innerWidth, cH=window.innerHeight;
    renderer.setScissorTest(false);
    renderer.setViewport(0,0,cW,cH);
    renderer.render(scene,camera);
    const frontViewport={x:20,y:Math.max(20,cH-272),width:200,height:112};
    renderer.setScissorTest(true);
    renderer.setScissor(frontViewport.x,frontViewport.y,frontViewport.width,frontViewport.height);
    renderer.setViewport(frontViewport.x,frontViewport.y,frontViewport.width,frontViewport.height);
    sensorSystem.withoutDebug(()=>renderer.render(scene,frontCamera));
    renderer.setScissor(20,cH-140,120,120);
    renderer.setViewport(20,cH-140,120,120);
    renderer.render(scene,miniCamera);
    renderer.setScissorTest(false);
    if(frameCount%30===0) bridge.sendFrame(frontViewport);
}

/* ═══════════════════════════════════════════════════════════════
   BUTTONS
═══════════════════════════════════════════════════════════════ */
document.getElementById('viewBtn').onclick  = ()=>{ driverView=!driverView; };
document.getElementById('routeBtn').onclick = ()=>{
    if(aiMode) return;
    routeVisible=!routeVisible;
    if(!routeVisible){
        hidePath();
        astarPanel.style.display='none';   // hide A* panel when route hidden
    } else {
        path=findRoute(roadNodes, car.position, destination.position);
        drawPath();
    }
};
document.getElementById('sensorBtn').onclick = ()=>sensorSystem.toggle();
aiToggleBtn.onclick = ()=>{ setAIMode(!aiMode); };

animate();
