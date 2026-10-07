import { collisionRisk, nearbyClearance } from '../simulation/vehicle-geometry.js?v=drive-final';

export function createCinematic(THREE,camera) {
  let active=null,cooldown=0,enabled=true;
  const events=[];
  const panel=document.getElementById('cinematicNotice'),look=new THREE.Vector3(),desired=new THREE.Vector3();
  return {setEnabled(value){enabled=value;if(!enabled){active=null;document.body.classList.remove('cinematic');panel.hidden=true;}},
    get scale(){return active?active.age<2.5?.22:active.age<3.8?.5:1:1;},
    get active(){return Boolean(active);},
    get actor(){return active?.actor;},
    events,
    reset(){active=null;cooldown=0;events.length=0;panel.hidden=true;document.body.classList.remove('cinematic');},
    detect(position,heading,speed,actors) {
      if(!enabled||active||cooldown>0||speed<3)return;
      const risk=collisionRisk(position,heading,speed,actors);
      if(risk&&risk.ttc<1.7){
        active={actor:risk.actor,age:0,ttc:risk.ttc};cooldown=14;panel.hidden=false;document.body.classList.add('cinematic');
        events.push({x:Number(position.x.toFixed(2)),z:Number(position.z.toFixed(2)),ttc:Number(risk.ttc.toFixed(2)),speedKmh:Number((speed*3.6).toFixed(1))});
        if(events.length>20)events.shift();
      }
    },
    update(dt,car,angle) {
      cooldown=Math.max(0,cooldown-dt);if(!active)return;
      active.age+=dt;
      if(active.age>5.2){active=null;panel.hidden=true;document.body.classList.remove('cinematic');return;}
      const s=Math.sin(angle),c=Math.cos(angle),gap=nearbyClearance(car.position,angle,[active.actor]);
      desired.set(car.position.x-s*7.5+c*1.2,3.0,car.position.z-c*7.5-s*1.2);
      look.set(car.position.x+s*3,1,car.position.z+c*3);
      camera.position.lerp(desired,1-Math.exp(-dt*5));camera.lookAt(look);
      camera.fov=49;camera.updateProjectionMatrix();
      panel.textContent=active.age<3.8?`SLOW MOTION · ×${this.scale.toFixed(2)} · خلوص ${gap.centimetres??'—'} سم`:'استعادة السرعة الزمنية · المتابعة مستمرة';
    },
  };
}
