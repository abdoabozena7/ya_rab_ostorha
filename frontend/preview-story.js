// A scripted illustration, never a prediction or result from CARLA.
export const previewLabels={NORMAL:'See the world before our solution',ROBOSPHERE:'See our solution'};
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
    carX=t<2?-350+180*between(t,0,2):t<2.8?-170+128*between(t,2,2.8):-42+98*(1-(1-between(t,2.8,4))**2);
    pedestrianY=36*between(t,2,4);
    if(t>=2){phase='crossing';message='The person steps onto the road as the car approaches.';}
    if(t>=2.8){phase='late-detection';message='The already-detected person enters the road. Reactive braking starts too late at this speed.';}
    if(t>=4){phase='contact';message='Detected, but too late to stop at this speed. Contact in this illustrated example.';}
  }
  if(t>=10.8){phase='replaying';message='Replaying the illustrated example…';}
  return {time:t,carX,pedestrianY,phase,message,prediction:protectedMode&&t>=1.2&&t<7.5,
    detected:t<10.8,reactive:!protectedMode&&t>=2.8&&t<10.8,braking:protectedMode?t>=1.2&&t<3.2:t>=2.8&&t<4,
    contact:!protectedMode&&t>=4&&t<10.8,walking:protectedMode?t>2&&t<7.5:t>2&&t<4,
    opacity:t>=11.6?1-between(t,11.6,12):1};
}
