import { STEP_SECONDS } from './fixed-step.js?v=drive-final';
import { clamp } from './longitudinal.js?v=drive-final';
const approach=(v,target,amount)=>v<target?Math.min(target,v+amount):Math.max(target,v-amount);

// SI force calculation; the outer engine retains metres per fixed 60 Hz tick.
export function stepVehicle(state,input,dt=STEP_SECONDS) {
  let {speed=0,angle=0,steering=0,reverseWait=0,throttle=0,brake=0}=state;
  const surface=input.surface??{grip:.94,rolling:.17};
  const both=input.forward&&input.backward;
  let demand=input.throttle??Number(Boolean(input.forward));
  let brakeDemand=input.brake??Number(Boolean(input.backward&&speed>0));
  if(input.handbrake||both){demand=0;brakeDemand=1;}
  throttle=approach(throttle,clamp(demand,0,1),dt*(demand>throttle?1.6:5));
  brake=approach(brake,clamp(brakeDemand,0,1),dt*5);
  let v=speed*60;
  const forwardLimit=Math.min(180,input.maxKmh??180)/3.6;
  const resistance=surface.rolling+.00085*v*v;
  const engine=throttle*Math.max(1.1,4.7-Math.abs(v)*.045);
  const braking=brake*surface.grip*9.81*.92;
  if(brakeDemand>0||brake>.01) {
    v=approach(v,0,(braking+resistance)*dt);reverseWait=.3;
  } else if(input.backward&&v<=0) {
    if(reverseWait>0)reverseWait=Math.max(0,reverseWait-dt);
    else v=Math.max(-15/3.6,v-2.5*dt);
  } else if(demand>0) {
    if(v<0)v=approach(v,0,6*dt);
    else v=Math.min(forwardLimit,Math.max(0,v+(engine-resistance)*dt));
    reverseWait=0;
  } else {
    v=approach(v,0,resistance*dt);reverseWait=Math.max(0,reverseWait-dt);
  }
  let steeringTarget=input.steering??(Number(Boolean(input.left))-Number(Boolean(input.right)))*.53;
  const lock=Math.min(.53,Math.atan(surface.grip*9.81*.7*2.78/Math.max(1,v*v)));
  steeringTarget=clamp(steeringTarget,-lock,lock);
  steering=approach(steering,steeringTarget,dt*1.5);
  angle+=v/2.78*Math.tan(steering)*dt;
  return {speed:v/60,angle,steering,reverseWait,throttle,brake,
    acceleration:(v-speed*60)/dt,lateralAcceleration:v*v/2.78*Math.tan(steering)};
}
