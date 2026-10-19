// A scripted illustration, never a prediction or result from CARLA.
export const previewLabels={NORMAL:'Normal · reactive sensor driving',ROBOSPHERE:'Robosphere · predictive RULE'};
const between=(t,a,b)=>Math.max(0,Math.min(1,(t-a)/(b-a)));
export function previewFrame(mode,seconds){
  const t=Math.max(0,seconds)%12,protectedMode=mode==='ROBOSPHERE';
  let carX=-350,pedestrianY=0,phase='approaching',message='Person detected on the pavement ahead. Same sensor view in both examples.';
  if(protectedMode){
    carX=t<1.2?-350+108*between(t,0,1.2):t<3.2?-242+168*(1-(1-between(t,1.2,3.2))**2):-74;
    pedestrianY=t<4?36*between(t,2,4):36+64*between(t,4,7.5);
    if(t>=1.2){phase='predicting';message='Person already detected on the pavement. Predicting they will cross; slowing early.';}
    if(t>=3.2){phase='stopped';message='Stopped for a predicted pedestrian crossing.';}
    if(t>=7.5){phase='safe';message='The person has crossed safely in this illustrated example.';}
    if(t>=8.2){carX=-74+350*between(t,8.2,10.5);phase='continuing';message='The crossing is clear. The car continues.';}
  }else{
    carX=t<2?-350+180*between(t,0,2):t<3.4?-170+128*(1-(1-between(t,2,3.4))**2):-42;
    pedestrianY=t<4?36*between(t,2,4):36+64*between(t,4,7.5);
    if(t>=2){phase='reactive-braking';message='The person enters the road. Sensor-based reactive braking begins.';}
    if(t>=3.4){phase='stopped';message='Normal has stopped before the person. Both drivers can avoid contact in this illustration.';}
    if(t>=7.5){phase='safe';message='The person has crossed. The reactive driver waits for a clear path.';}
    if(t>=8.2){carX=-42+350*between(t,8.2,10.5);phase='continuing';message='The crossing is clear. Normal continues.';}
  }
  if(t>=10.8){phase='replaying';message='Replaying the illustrated example…';}
  return {time:t,carX,pedestrianY,phase,message,prediction:protectedMode&&t>=1.2&&t<7.5,
    detected:t<10.8,reactive:!protectedMode&&t>=2&&t<8.2,braking:protectedMode?t>=1.2&&t<3.2:t>=2&&t<3.4,
    contact:false,walking:t>2&&t<7.5,
    opacity:t>=11.6?1-between(t,11.6,12):1};
}
