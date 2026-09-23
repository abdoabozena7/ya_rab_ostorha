import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152/build/three.module.js';

/* ═══════════════════════════════════════════════════════════════
   SCENE
═══════════════════════════════════════════════════════════════ */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0xb8d8f0, 200, 550);

let obstacles      = [];
let npcVehicles    = [];
let gameOver       = false;
let money          = 0;
let points         = 0;
let expansionLevel = 0;
let frameCount     = 0;

let fuel           = 100;
let petrolBunks    = [];
let isRefilling    = false;
let spawnPoint, destination;

/* ── AI state ── */
let aiMode            = false;
let fitness           = 0;
let distanceTravelled = 0;
let lastCarPos        = new THREE.Vector3();

/* ── Path ── */
let roadNodes    = [];
let path         = [];
let pathLines    = [];
let routeVisible = false;
let waypointIdx  = 0;

/* ── Destination collect loop ── */
let destCollecting   = false;
let destCollectTimer = 0;
const DEST_STOP_FRAMES = 90;

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
const TL_CHECK     = 22;
const TL_STOP_LINE = 8;

/* ═══════════════════════════════════════════════════════════════
   ★  A* DISPLAY STATE
   Stores the last computed f/g/h values so the panel can
   display them live while the route is visible.
═══════════════════════════════════════════════════════════════ */
let astarDisplayData = {
    fVal: 0,       // f(n) of current waypoint
    gVal: 0,       // g(n) of current waypoint
    hVal: 0,       // h(n) of current waypoint
    maxF: 1,       // max f in the path (for bar scaling)
    nodeIdx: 0,    // current waypoint index
    pathLen: 0,    // total path length
    tableRows: []  // [{idx, g, h, f}] for next 5 nodes
};

/* ── DOM refs for A* panel ── */
const astarPanel   = document.getElementById('astarPanel');
const aBarF        = document.getElementById('aBarF');
const aBarG        = document.getElementById('aBarG');
const aBarH        = document.getElementById('aBarH');
const aValF        = document.getElementById('aValF');
const aValG        = document.getElementById('aValG');
const aValH        = document.getElementById('aValH');
const aNodeIdx     = document.getElementById('aNodeIdx');
const aPathLen     = document.getElementById('aPathLen');
const aRemain      = document.getElementById('aRemain');
const astarTBody   = document.getElementById('astarTableBody');

/* ═══════════════════════════════════════════════════════════════
   updateAstarPanel()
   Called every frame when routeVisible=true.
   Reads path[] and waypointIdx to show live f/g/h.
═══════════════════════════════════════════════════════════════ */
function updateAstarPanel(){
    if(!routeVisible || !path || path.length < 2){
        astarPanel.style.display = 'none';
        return;
    }
    astarPanel.style.display = 'block';

    const idx  = Math.min(waypointIdx, path.length - 1);
    const node = path[idx];

    // g(n) = actual cost stored on node from A* run
    const gVal = isFinite(node.g) ? node.g : 0;

    // h(n) = heuristic: Manhattan distance to destination
    const hVal = destination
        ? Math.abs(node.x - destination.position.x) + Math.abs(node.z - destination.position.z)
        : 0;

    // f(n) = g(n) + h(n)
    const fVal = gVal + hVal;

    // Build table rows for next 5 nodes (including current)
    const TABLE_COUNT = 5;
    const rows = [];
    for(let i = idx; i < Math.min(idx + TABLE_COUNT, path.length); i++){
        const n   = path[i];
        const g   = isFinite(n.g) ? n.g : 0;
        const h   = destination
            ? Math.abs(n.x - destination.position.x) + Math.abs(n.z - destination.position.z)
            : 0;
        rows.push({ idx: i, g: g, h: h, f: g + h });
    }

    // Max f across those rows (for bar scaling)
    const maxF = Math.max(1, ...rows.map(r => r.f));

    // ── Update main three rows ──
    const pct = v => Math.min(100, Math.round((v / maxF) * 100));
    aBarF.style.width = pct(fVal) + '%';
    aBarG.style.width = pct(gVal) + '%';
    aBarH.style.width = pct(hVal) + '%';
    aValF.textContent = fVal.toFixed(1);
    aValG.textContent = gVal.toFixed(1);
    aValH.textContent = hVal.toFixed(1);

    // ── Update footer ──
    aNodeIdx.textContent = idx;
    aPathLen.textContent = path.length;
    aRemain.textContent  = Math.max(0, path.length - 1 - idx);

    // ── Update table ──
    astarTBody.innerHTML = '';
    rows.forEach(r => {
        const tr = document.createElement('tr');
        if(r.idx === idx) tr.className = 'current-wp';
        tr.innerHTML = `
            <td>${r.idx === idx ? '▶ ' + r.idx : r.idx}</td>
            <td>${r.g.toFixed(0)}</td>
            <td>${r.h.toFixed(0)}</td>
            <td>${r.f.toFixed(0)}</td>`;
        astarTBody.appendChild(tr);
    });
}

/* ═══════════════════════════════════════════════════════════════
   RENDERER
═══════════════════════════════════════════════════════════════ */
let driverView = false;
const camera     = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 5000);
const miniCamera = new THREE.OrthographicCamera(-100,100,100,-100,1,2000);
const renderer   = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
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
sun.position.set(150,300,200); sun.castShadow = true;
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

/* ═══════════════════════════════════════════════════════════════
   TRAFFIC LIGHTS
═══════════════════════════════════════════════════════════════ */
let trafficLights = [];
const TL_G=220, TL_Y=55, TL_R=220, TL_C=TL_G+TL_Y+TL_R;
const TLC = {
    red:    { on:0xff2200, em:0xff0000, dim:0x2a0000 },
    yellow: { on:0xffaa00, em:0xff8800, dim:0x2a1800 },
    green:  { on:0x00dd44, em:0x00ff44, dim:0x002210 }
};
class TrafficLight {
    constructor(x,z,phase) {
        this.x=x; this.z=z;
        this.timer = phase===0 ? 0 : Math.floor(TL_C/2);
        this._mg=[]; this._vL=null; this._hL=null;
        this._build(); this._apply(); trafficLights.push(this);
    }
    _st(t){ const n=t%TL_C; return n<TL_G?'green':n<TL_G+TL_Y?'yellow':'red'; }
    get vs(){ return this._st(this.timer); }
    get hs(){ return this._st(this.timer+Math.floor(TL_C/2)); }
    update(){ this.timer++; this._apply(); }
    _build(){
        this._vL=this._pole(this.x+6,this.z+6,0);
        this._hL=this._pole(this.x-6,this.z-6,Math.PI/2);
    }
    _pole(px,pz,ry){
        const g=new THREE.Group();
        const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.22,7,8),
            new THREE.MeshPhongMaterial({color:0x1a1a1a}));
        pole.position.set(0,3.5,0); pole.castShadow=true; g.add(pole);
        const arm=new THREE.Mesh(new THREE.BoxGeometry(0.18,0.18,2.2),
            new THREE.MeshPhongMaterial({color:0x1a1a1a}));
        arm.position.set(0,7,1.1); g.add(arm);
        const hs=new THREE.Mesh(new THREE.BoxGeometry(0.9,2.9,0.7),
            new THREE.MeshPhongMaterial({color:0x111111}));
        hs.position.set(0,7,2.3); g.add(hs);
        const bg=new THREE.SphereGeometry(0.26,12,12); const refs={};
        [{name:'red',y:7.85},{name:'yellow',y:7.0},{name:'green',y:6.15}].forEach(({name,y})=>{
            const mat=new THREE.MeshPhongMaterial({color:TLC[name].dim,emissive:new THREE.Color(0),emissiveIntensity:0});
            const b=new THREE.Mesh(bg,mat); b.position.set(0,y,2.66); g.add(b); refs[name]=b;
            const v=new THREE.Mesh(new THREE.BoxGeometry(0.95,0.12,0.5),new THREE.MeshPhongMaterial({color:0x0a0a0a}));
            v.position.set(0,y+0.32,2.42); g.add(v);
        });
        g.rotation.y=ry; g.position.set(px,0,pz); scene.add(g); this._mg.push(g); return refs;
    }
    _apply(){ this._sig(this._vL,this.vs); this._sig(this._hL,this.hs); }
    _sig(l,s){
        if(!l) return;
        ['red','yellow','green'].forEach(n=>{
            const b=l[n],on=n===s;
            b.material.color.setHex(on?TLC[n].on:TLC[n].dim);
            b.material.emissive.setHex(on?TLC[n].em:0);
            b.material.emissiveIntensity=on?0.9:0;
        });
    }
    remove(){ this._mg.forEach(g=>scene.remove(g)); }
}

function createTrafficLights(){
    trafficLights.forEach(t=>t.remove()); trafficLights=[];
    const bd=100+expansionLevel;
    const rp=[]; for(let i=-bd;i<=bd;i+=40) rp.push(i);
    const lp=rp.filter((_,i)=>i%2===1);
    lp.forEach((xi,gi)=>lp.forEach((zi,gj)=>{
        if(Math.abs(xi)<45&&Math.abs(zi)<45) return;
        new TrafficLight(xi,zi,(gi+gj)%2);
    }));
}

function getCarTrafficLight(){
    const fx=Math.sin(angle), fz=Math.cos(angle);
    let bestState=null, bestDist=Infinity;
    for(const tl of trafficLights){
        if(Math.abs(tl.x-car.position.x)<6){
            const d=fz*(tl.z-car.position.z);
            if(d>0&&d<TL_CHECK&&d<bestDist){ bestDist=d; bestState=tl.vs; }
        }
        if(Math.abs(tl.z-car.position.z)<6){
            const d=fx*(tl.x-car.position.x);
            if(d>0&&d<TL_CHECK&&d<bestDist){ bestDist=d; bestState=tl.hs; }
        }
    }
    if(bestDist===Infinity) return null;
    return { state: bestState, dist: bestDist };
}

function npcShouldStop(npc){
    const S=9,B=3;
    for(const tl of trafficLights){
        if(npc.isVertical){
            if(Math.abs(tl.x-npc.roadCoord)>6) continue;
            const d=npc.direction*(tl.z-npc.group.position.z);
            if(d<-B||d>S) continue;
            if(tl.vs==='red'||tl.vs==='yellow') return true;
        } else {
            if(Math.abs(tl.z-npc.roadCoord)>6) continue;
            const d=npc.direction*(tl.x-npc.group.position.x);
            if(d<-B||d>S) continue;
            if(tl.hs==='red'||tl.hs==='yellow') return true;
        }
    }
    return false;
}

/* ═══════════════════════════════════════════════════════════════
   NPC VEHICLES
═══════════════════════════════════════════════════════════════ */
const npcColors=[0xff6b6b,0x4ecdc4,0x45b7d1,0xffeaa7,0xdda0dd,0xf39c12,
    0x2ecc71,0xe74c3c,0x3498db,0x9b59b6,0x1abc9c,0xe67e22];
class NPCVehicle{
    constructor(roadCoord,isVertical,direction){
        const col=npcColors[Math.floor(Math.random()*npcColors.length)];
        this.group=new THREE.Group();
        this.roadCoord=roadCoord; this.isVertical=isVertical; this.direction=direction;
        const body=new THREE.Mesh(new THREE.BoxGeometry(2,0.65,4),new THREE.MeshPhongMaterial({color:col,shininess:80}));
        body.castShadow=true; this.group.add(body);
        const cab=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.55,2),new THREE.MeshPhongMaterial({color:0x1a1a2e}));
        cab.position.set(0,0.6,-0.15); this.group.add(cab);
        const wg=new THREE.CylinderGeometry(0.32,0.32,0.28,12);
        const wm=new THREE.MeshPhongMaterial({color:0x111111});
        const rm=new THREE.MeshPhongMaterial({color:0x888888});
        [[-1.1,-0.32,1.3],[1.1,-0.32,1.3],[-1.1,-0.32,-1.3],[1.1,-0.32,-1.3]].forEach(([x,y,z])=>{
            const w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2; w.position.set(x,y,z); this.group.add(w);
            const r=new THREE.Mesh(new THREE.CylinderGeometry(0.19,0.19,0.29,8),rm); r.rotation.z=Math.PI/2; r.position.set(x,y,z); this.group.add(r);
        });
        this._bm=new THREE.MeshPhongMaterial({color:0x330000,emissive:0x000000,emissiveIntensity:0});
        [-0.6,0.6].forEach(ox=>{
            const bl=new THREE.Mesh(new THREE.BoxGeometry(0.45,0.2,0.08),this._bm); bl.position.set(ox,0.05,-2.06); this.group.add(bl);
        });
        const lo=2.5;
        if(isVertical){
            this.group.position.set(roadCoord+direction*-lo,0.32,(Math.random()*(200+expansionLevel*2))-(100+expansionLevel));
            this.group.rotation.y=direction===1?0:Math.PI;
        } else {
            this.group.position.set((Math.random()*(200+expansionLevel*2))-(100+expansionLevel),0.32,roadCoord+direction*lo);
            this.group.rotation.y=direction===1?Math.PI/2:-Math.PI/2;
        }
        scene.add(this.group); npcVehicles.push(this); obstacles.push(this.group);
    }
    update(){
        if(npcShouldStop(this)){
            this._bm.color.setHex(0xff1100); this._bm.emissive.setHex(0xff0000); this._bm.emissiveIntensity=0.8; return;
        }
        this._bm.color.setHex(0x330000); this._bm.emissive.setHex(0x000000); this._bm.emissiveIntensity=0;
        const spd=0.15, lim=100+expansionLevel;
        if(this.isVertical){
            this.group.position.z+=spd*this.direction;
            if(Math.abs(this.group.position.z)>lim) this.group.position.z=-lim*this.direction;
        } else {
            this.group.position.x+=spd*this.direction;
            if(Math.abs(this.group.position.x)>lim) this.group.position.x=-lim*this.direction;
        }
    }
}
function initTraffic(){
    npcVehicles.forEach(v=>{ scene.remove(v.group); const i=obstacles.indexOf(v.group); if(i>-1)obstacles.splice(i,1); });
    npcVehicles=[];
    for(let i=-100-expansionLevel;i<=100+expansionLevel;i+=40){
        new NPCVehicle(i,true,1);  new NPCVehicle(i,true,-1);
        new NPCVehicle(i,false,1); new NPCVehicle(i,false,-1);
    }
}

/* ═══════════════════════════════════════════════════════════════
   PETROL BUNKS
═══════════════════════════════════════════════════════════════ */
function createPetrolBunks(){
    petrolBunks.forEach(b=>scene.remove(b)); petrolBunks=[];
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
        mkr.position.set(pos.x,0.5,pos.z); scene.add(mkr); petrolBunks.push(mkr);
    });
}
function checkPetrolBunk(){
    if(isRefilling||aiMode) return;
    petrolBunks.forEach(bunk=>{
        if(car.position.distanceTo(bunk.position)<9){
            isRefilling=true; speed=0;
            const fill=prompt('⛽ Petrol Bunk!\nHow much % to fill? (₹10 per 1%)','50');
            const amt=parseInt(fill);
            if(!isNaN(amt)&&amt>0){ const cost=amt*10; if(money>=cost){fuel=Math.min(100,fuel+amt);money-=cost;}else alert('Not enough money!'); }
            setTimeout(()=>{ isRefilling=false; },3000);
        }
    });
}

/* ═══════════════════════════════════════════════════════════════
   ROADS, BUILDINGS, TREES
═══════════════════════════════════════════════════════════════ */
function createRoad(x,z,w,l){
    const road=new THREE.Mesh(new THREE.BoxGeometry(w,0.15,l),new THREE.MeshPhongMaterial({color:0x2a2a2a}));
    road.position.set(x,0,z); road.receiveShadow=true; scene.add(road);
    if(w<l){ for(let i=-l/2;i<=l/2;i+=10) roadNodes.push({x,z:z+i,g:Infinity,f:Infinity,parent:null,isVert:true}); }
    else    { for(let i=-w/2;i<=w/2;i+=10) roadNodes.push({x:x+i,z,g:Infinity,f:Infinity,parent:null,isVert:false}); }
    const dm=new THREE.MeshPhongMaterial({color:0xffffff});
    if(w<l){
        for(let i=-l/2;i<l/2;i+=8){ const d=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.16,4),dm); d.position.set(x,0.11,z+i); scene.add(d); }
        [-w/2+0.5,w/2-0.5].forEach(ex=>{ const e=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.14,l),new THREE.MeshPhongMaterial({color:0xffdd00})); e.position.set(x+ex,0.1,z); scene.add(e); });
    } else {
        for(let i=-w/2;i<w/2;i+=8){ const d=new THREE.Mesh(new THREE.BoxGeometry(4,0.16,0.5),dm); d.position.set(x+i,0.11,z); scene.add(d); }
        [-l/2+0.5,l/2-0.5].forEach(ez=>{ const e=new THREE.Mesh(new THREE.BoxGeometry(w,0.14,0.3),new THREE.MeshPhongMaterial({color:0xffdd00})); e.position.set(x,0.1,z+ez); scene.add(e); });
    }
}
function createGreenLand(x,z){
    const g=new THREE.Mesh(new THREE.BoxGeometry(22,0.12,22),new THREE.MeshPhongMaterial({color:0x2ecc71}));
    g.position.set(x,0.05,z); g.receiveShadow=true; scene.add(g);
}
const bldPalette=[0x2980b9,0x3498db,0xc0392b,0xe74c3c,0x27ae60,0x8e44ad,0x16a085,0xd35400,0x2c3e50,0xe67e22,0x1abc9c,0x9b59b6,0x0097a7,0xf06292,0x558b2f,0x6d4c41];
function createBuilding(x,z){
    const h=Math.random()*22+8, col=bldPalette[Math.floor(Math.random()*bldPalette.length)];
    const b=new THREE.Mesh(new THREE.BoxGeometry(12,h,12),new THREE.MeshPhongMaterial({color:col,shininess:60}));
    b.position.set(x,h/2,z); b.castShadow=true; b.receiveShadow=true; scene.add(b); obstacles.push(b);
    const roof=new THREE.Mesh(new THREE.BoxGeometry(12.4,0.4,12.4),new THREE.MeshPhongMaterial({color:0xffffff,emissive:0x333333}));
    roof.position.set(x,h+0.2,z); scene.add(roof);
    const wm=new THREE.MeshPhongMaterial({color:0xffffcc,emissive:0xffff44,emissiveIntensity:0.5});
    for(let wy=2.5;wy<h-1.5;wy+=2.8){
        for(const wx of[-3.5,0,3.5]){
            if(Math.random()>0.2){
                const wf=new THREE.Mesh(new THREE.BoxGeometry(1.5,1.2,0.12),wm); wf.position.set(x+wx,wy,z+6.07); scene.add(wf);
                const wb=wf.clone(); wb.position.set(x+wx,wy,z-6.07); scene.add(wb);
            }
        }
    }
}
function createTree(x,z){
    const t=new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.38,2.2,8),new THREE.MeshPhongMaterial({color:0x8B4513}));
    t.position.set(x,1.1,z); t.castShadow=true; scene.add(t);
    const fm=new THREE.MeshPhongMaterial({color:0x228B22});
    [{r:2.3,y:3.8},{r:1.7,y:5.2},{r:1.1,y:6.3}].forEach(({r,y})=>{
        const f=new THREE.Mesh(new THREE.SphereGeometry(r,8,6),fm); f.position.set(x,y,z); f.castShadow=true; scene.add(f);
    });
}
function buildCitySegment(offset){
    const b=100+offset;
    for(let i=-b;i<=b;i+=40){ createRoad(i,0,10,b*2); createRoad(0,i,b*2,10); }
    for(let x=-b+20;x<=b-20;x+=40){
        for(let z=-b+20;z<=b-20;z+=40){
            if(Math.abs(x)<30&&Math.abs(z)<30) continue;
            if(Math.abs(x)>=offset||Math.abs(z)>=offset){
                createGreenLand(x,z); createBuilding(x,z);
                if(Math.random()>0.4) createTree(x+7,z+7);
                if(Math.random()>0.4) createTree(x-7,z-7);
                if(Math.random()>0.6) createTree(x+7,z-7);
            }
        }
    }
    initTraffic(); createPetrolBunks(); createTrafficLights();
}
buildCitySegment(0);

function createSpawn(){
    spawnPoint=new THREE.Mesh(new THREE.CylinderGeometry(2.2,2.2,0.12,32),
        new THREE.MeshPhongMaterial({color:0x0055ff,emissive:0x0033cc,emissiveIntensity:0.5}));
    spawnPoint.position.set(0,0.07,0); scene.add(spawnPoint);
}
function createDestination(){
    if(destination) scene.remove(destination);
    let node, tries=0;
    do {
        node=roadNodes[Math.floor(Math.random()*roadNodes.length)];
        tries++;
    } while(tries<50 && node && Math.hypot(node.x-car.position.x,node.z-car.position.z)<50);
    destination=new THREE.Mesh(new THREE.CylinderGeometry(2.2,2.2,0.5,32),
        new THREE.MeshPhongMaterial({color:0xffdd00,emissive:0xffaa00,emissiveIntensity:0.8}));
    destination.position.set(node.x,0.3,node.z); scene.add(destination);
    if(aiMode){ planRoute(); }
}
createSpawn();

/* ═══════════════════════════════════════════════════════════════
   PLAYER CAR
═══════════════════════════════════════════════════════════════ */
const car=new THREE.Group(); car.position.set(0,0.5,0);
const carBody=new THREE.Mesh(new THREE.BoxGeometry(2,0.68,4),new THREE.MeshPhongMaterial({color:0xff2244,shininess:120}));
carBody.castShadow=true; car.add(carBody);
const cabin=new THREE.Mesh(new THREE.BoxGeometry(1.62,0.58,2.1),new THREE.MeshPhongMaterial({color:0x1a1a3e,shininess:90}));
cabin.position.set(0,0.63,-0.15); cabin.castShadow=true; car.add(cabin);
const wsMat=new THREE.MeshPhongMaterial({color:0x88ccff,transparent:true,opacity:0.55,shininess:200});
const wsF=new THREE.Mesh(new THREE.BoxGeometry(1.55,0.52,0.08),wsMat); wsF.position.set(0,0.63,0.9); car.add(wsF);
const wsR=wsF.clone(); wsR.position.set(0,0.63,-1.2); car.add(wsR);
const wgeo=new THREE.CylinderGeometry(0.38,0.38,0.28,16);
const wmat=new THREE.MeshPhongMaterial({color:0x111111});
const rmat=new THREE.MeshPhongMaterial({color:0xbbbbbb,shininess:100});
[[-1.12,-0.32,1.45],[1.12,-0.32,1.45],[-1.12,-0.32,-1.45],[1.12,-0.32,-1.45]].forEach(([x,y,z])=>{
    const w=new THREE.Mesh(wgeo,wmat); w.rotation.z=Math.PI/2; w.position.set(x,y,z); w.castShadow=true; car.add(w);
    const r=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.22,0.29,8),rmat); r.rotation.z=Math.PI/2; r.position.set(x,y,z); car.add(r);
});
const hmat=new THREE.MeshPhongMaterial({color:0xffffcc,emissive:0xffffaa,emissiveIntensity:1.2});
[-0.65,0.65].forEach(x=>{ const hl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.22,0.1),hmat); hl.position.set(x,0.05,2.06); car.add(hl); });
const tmat=new THREE.MeshPhongMaterial({color:0xff2200,emissive:0xff0000,emissiveIntensity:0.9});
[-0.65,0.65].forEach(x=>{ const tl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.22,0.1),tmat); tl.position.set(x,0.05,-2.06); car.add(tl); });
const bmp=new THREE.Mesh(new THREE.BoxGeometry(2.1,0.22,0.12),new THREE.MeshPhongMaterial({color:0x111111}));
bmp.position.set(0,-0.24,2.06); car.add(bmp);
scene.add(car);
createDestination();

/* ═══════════════════════════════════════════════════════════════
   SENSOR RAYS
═══════════════════════════════════════════════════════════════ */
const RAY_COUNT=7, RAY_LENGTH=40;
const RAY_ANGLES=[-90,-60,-30,0,30,60,90];
const RAY_LABELS=['L 90°','L 60°','L 30°','FRONT','R 30°','R 60°','R 90°'];
const raycaster=new THREE.Raycaster();
const sensorLines=[], sensorHitDots=[];
let sensorsVisible=true;
let SR=new Array(RAY_COUNT).fill(1);
for(let i=0;i<RAY_COUNT;i++){
    const geo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,-RAY_LENGTH)]);
    const line=new THREE.Line(geo,new THREE.LineBasicMaterial({color:0x00ff88,linewidth:2}));
    line.position.y=0.6; scene.add(line); sensorLines.push(line);
    const dot=new THREE.Mesh(new THREE.SphereGeometry(0.35,8,8),
        new THREE.MeshPhongMaterial({color:0xff2244,emissive:0xff0000,emissiveIntensity:0.8}));
    dot.visible=false; scene.add(dot); sensorHitDots.push(dot);
}
const sensorRowsEl=document.getElementById('sensorRows');
const sBarEls=[], sDistEls=[];
RAY_LABELS.forEach((lbl,i)=>{
    const row=document.createElement('div'); row.className='sensor-row';
    row.innerHTML=`<span class="sensor-name">${lbl}</span>
      <div class="sensor-bar-wrap"><div class="sensor-bar-fill" id="sbar${i}" style="width:100%;background:#00e676"></div></div>
      <span class="sensor-dist" id="sdist${i}">--</span>`;
    sensorRowsEl.appendChild(row);
    sBarEls.push(document.getElementById(`sbar${i}`));
    sDistEls.push(document.getElementById(`sdist${i}`));
});
function updateSensors(){
    const targets=[...obstacles,...npcVehicles.map(v=>v.group)];
    for(let i=0;i<RAY_COUNT;i++){
        const tot=angle+THREE.MathUtils.degToRad(RAY_ANGLES[i]);
        const dir=new THREE.Vector3(Math.sin(tot),0,Math.cos(tot)).normalize();
        const origin=new THREE.Vector3(car.position.x,car.position.y+0.1,car.position.z);
        raycaster.set(origin,dir); raycaster.far=RAY_LENGTH;
        const hits=raycaster.intersectObjects(targets,true);
        const hit=hits.length>0?hits[0]:null;
        const raw=hit?hit.distance:RAY_LENGTH; SR[i]=raw/RAY_LENGTH;
        const end=origin.clone().addScaledVector(dir,raw);
        const pos=sensorLines[i].geometry.attributes.position;
        pos.setXYZ(0,origin.x,origin.y+0.5,origin.z);
        pos.setXYZ(1,end.x,end.y+0.5,end.z);
        pos.needsUpdate=true; sensorLines[i].geometry.computeBoundingSphere();
        const col=hit?(SR[i]<0.25?0xff2244:SR[i]<0.55?0xffaa00:0xffff00):0x00ff88;
        sensorLines[i].material.color.setHex(col);
        sensorLines[i].visible=sensorsVisible;
        if(hit&&sensorsVisible){ sensorHitDots[i].position.copy(hit.point).setY(hit.point.y+0.5); sensorHitDots[i].visible=true; }
        else sensorHitDots[i].visible=false;
        const bc=SR[i]<0.25?'#ff2244':SR[i]<0.55?'#ffaa00':'#00e676';
        sBarEls[i].style.width=(SR[i]*100)+'%'; sBarEls[i].style.background=bc;
        sDistEls[i].innerText=raw.toFixed(1)+'m'; sDistEls[i].style.color=bc;
    }
}

/* ═══════════════════════════════════════════════════════════════
   ★  A* PATHFINDING  — axis-aligned only
═══════════════════════════════════════════════════════════════ */
function runAStar(startPos, endPos){
    roadNodes.forEach(n=>{ n.g=Infinity; n.f=Infinity; n.parent=null; });
    const start=closestNode(startPos), goal=closestNode(endPos);
    if(!start||!goal) return;
    let open=[start]; start.g=0;
    start.f=Math.abs(start.x-goal.x)+Math.abs(start.z-goal.z);
    while(open.length){
        open.sort((a,b)=>a.f-b.f);
        const cur=open.shift();
        if(cur===goal){
            path=[]; let t=cur; while(t){ path.push(t); t=t.parent; } path.reverse(); return;
        }
        for(const n of roadNodes){
            const dx=Math.abs(n.x-cur.x);
            const dz=Math.abs(n.z-cur.z);
            const dist=Math.hypot(dx,dz);
            if(dist>12 || dist<0.5) continue;
            if(dx>2 && dz>2) continue;  // axis-aligned only
            const ng=cur.g+dist;
            if(ng<n.g){
                n.parent=cur; n.g=ng;
                n.f=ng+Math.abs(n.x-goal.x)+Math.abs(n.z-goal.z);
                if(!open.includes(n)) open.push(n);
            }
        }
    }
}

function closestNode(pos){
    let best, min=Infinity;
    roadNodes.forEach(n=>{ const d=Math.hypot(pos.x-n.x,pos.z-n.z); if(d<min){ min=d; best=n; } });
    return best;
}
function planRoute(){
    runAStar(car.position, destination.position);
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
document.addEventListener('keydown',e=>{ keys[e.key]=true; });
document.addEventListener('keyup',  e=>{ keys[e.key]=false; });

function moveCar(){
    if(fuel<=0){ speed=0; return; }
    if(keys['ArrowUp'])   speed+=acceleration;
    if(keys['ArrowDown']) speed-=acceleration;
    speed=Math.max(-maxSpeed/2,Math.min(speed,maxSpeed));
    if(!keys['ArrowUp']&&!keys['ArrowDown']) speed*=0.95;
    if(Math.abs(speed)>0.001){
        if(keys['ArrowLeft'])  angle+=0.03;
        if(keys['ArrowRight']) angle-=0.03;
        fuel-=0.005;
    }
    car.rotation.y=angle;
    car.position.x+=Math.sin(angle)*speed;
    car.position.z+=Math.cos(angle)*speed;
}

/* ═══════════════════════════════════════════════════════════════
   AI DRIVE
═══════════════════════════════════════════════════════════════ */
function aiDrive(){
    if(fuel<=0){ speed=0; return; }

    if(destCollecting){
        speed=Math.max(0,speed-BRAKE*4);
        car.rotation.y=angle;
        destCollectTimer++;
        if(destCollectTimer>=DEST_STOP_FRAMES){ destCollecting=false; destCollectTimer=0; createDestination(); }
        showBanner('⭐  COLLECTING  —  PLANNING NEXT ROUTE','collect');
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
        if(tlDist>TL_STOP_LINE){
            const blend=Math.max(0,Math.min(1,(tlDist-TL_STOP_LINE)/10));
            targetSpeed=CRUISE_SPD*blend;
            if(tlDist<=TL_STOP_LINE+0.5) targetSpeed=0;
            state='stop';
        }
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
            const factor=1-(frontM/8);
            targetSpeed=Math.max(0,targetSpeed*(1-factor*0.95));
            state='obstacle';
            if(avoidLockTimer<=0){ avoidLockDir=(fL30>=fR30)?1:-1; avoidLockTimer=AVOID_LOCK_FRAMES; }
            rawAvoid=avoidLockDir*MAX_STEER*1.2;
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

    const finalSteer=Math.max(-MAX_STEER*1.8,Math.min(MAX_STEER*1.8,steer+smoothAvoidSteer));
    angle+=finalSteer;

    targetSpeed=Math.max(0,Math.min(CRUISE_SPD,targetSpeed));
    const brakeRate=(state==='obstacle')?BRAKE*0.35:BRAKE;
    if(speed<targetSpeed) speed=Math.min(targetSpeed,speed+ACCEL);
    else                  speed=Math.max(targetSpeed,speed-brakeRate);
    speed=Math.max(0,speed);

    if(speed>0.001) fuel-=0.004;
    car.rotation.y=angle;
    car.position.x+=Math.sin(angle)*speed;
    car.position.z+=Math.cos(angle)*speed;

    const moved=car.position.distanceTo(lastCarPos);
    if(speed<0.004&&moved<0.006){
        stuckTimer++;
        if(stuckTimer>STUCK_MAX){ waypointIdx=Math.min(waypointIdx+4,path.length-1); speed=ACCEL*8; stuckTimer=0; }
    } else { stuckTimer=0; }

    distanceTravelled+=moved;
    fitness=Math.floor(distanceTravelled*0.5)+points*200;
    document.getElementById('fitnessVal').innerText=fitness;

    if(state==='obstacle')   showBanner('⚠️  OBSTACLE — SLOWING','yellow');
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
        const ob=new THREE.Box3().setFromObject(obj);
        if(!carBox.intersectsBox(ob)) continue;
        money-=100; fitness-=50;
        speed*=0.2;
        const ox=(carBox.max.x-ob.min.x<ob.max.x-carBox.min.x)?(carBox.max.x-ob.min.x):-(ob.max.x-carBox.min.x);
        const oz=(carBox.max.z-ob.min.z<ob.max.z-carBox.min.z)?(carBox.max.z-ob.min.z):-(ob.max.z-carBox.min.z);
        if(Math.abs(ox)<Math.abs(oz)) car.position.x-=ox*1.05;
        else                          car.position.z-=oz*1.05;
        if(aiMode){ waypointIdx=Math.min(waypointIdx+3,path.length-1); stuckTimer=0; }
        colCooldown=COL_FRAMES; break;
    }
}

function checkDestination(){
    if(destCollecting||!destination) return;
    if(car.position.distanceTo(destination.position)<5){
        money+=500; points+=1; fitness+=300;
        if(points%5===0){ expansionLevel+=80; buildCitySegment(expansionLevel); }
        if(aiMode){ destCollecting=true; destCollectTimer=0; speed=0; }
        else       createDestination();
    }
}

function updateUI(){
    const kmh=Math.abs(speed)*120;
    document.getElementById('speedVal').innerText =kmh.toFixed(1)+' km/h';
    document.getElementById('moneyVal').innerText ='₹'+money;
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
        if(!aiMode) document.getElementById('aiBanner').style.display='none';
        return;
    }
    tlPanel.style.opacity='1';
    tlDotRed.className   ='tl-dot'+(st==='red'   ?' active-red'   :'');
    tlDotYellow.className='tl-dot'+(st==='yellow'?' active-yellow':'');
    tlDotGreen.className ='tl-dot'+(st==='green' ?' active-green' :'');
    if(!aiMode){
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
        colCooldown=0; destCollecting=false; destCollectTimer=0;
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

/* ═══════════════════════════════════════════════════════════════
   ANIMATION LOOP
═══════════════════════════════════════════════════════════════ */
function animate(){
    requestAnimationFrame(animate);
    lastCarPos.copy(car.position);

    if(!gameOver){
        aiMode ? aiDrive() : moveCar();
        updateUI();
        checkCollision();
        checkDestination();
        checkPetrolBunk();
        updateSensors();
        updateTrafficHUD();
        updateAstarPanel();          // ← ★ A* display updated every frame
        trafficLights.forEach(tl=>tl.update());
        npcVehicles.forEach(v=>v.update());

        if(routeVisible&&frameCount%15===0){ if(!aiMode) runAStar(car.position,destination.position); drawPath(); }
        if(!routeVisible) hidePath();
    }
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
    renderer.setScissorTest(true);
    renderer.setScissor(20,cH-140,120,120);
    renderer.setViewport(20,cH-140,120,120);
    renderer.render(scene,miniCamera);
    renderer.setScissorTest(false);
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
        runAStar(car.position, destination.position);
        drawPath();
    }
};
document.getElementById('sensorBtn').onclick = ()=>{
    sensorsVisible=!sensorsVisible;
    document.getElementById('sensorBtn').innerText=sensorsVisible?'◈ SENSORS':'◈ SENSORS OFF';
    document.getElementById('sensorPanel').style.opacity=sensorsVisible?'1':'0.35';
    sensorLines.forEach(l=>{ l.visible=sensorsVisible; });
    sensorHitDots.forEach(d=>{ d.visible=false; });
};
aiToggleBtn.onclick = ()=>{ setAIMode(!aiMode); };

animate();
