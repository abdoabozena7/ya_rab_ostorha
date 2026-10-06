export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// Intelligent Driver Model: bumper gap in m, velocities in m/s.
export function followingAcceleration(speed,target,gap=Infinity,leaderSpeed=0,{headway=1.3,minimumGap=1.25,grip=.94}={}) {
  const acceleration=2.1,comfortable=3.2,closing=speed-leaderSpeed;
  const desired=minimumGap+Math.max(0,speed*headway+speed*closing/(2*Math.sqrt(acceleration*comfortable)));
  return clamp(acceleration*(1-(speed/Math.max(.1,target))**4-(Number.isFinite(gap)?(desired/Math.max(.1,gap))**2:0)),-grip*9.81,acceleration);
}
export function stoppingDistance(speed,grip=.94,reaction=.35) {
  return speed*reaction+speed*speed/(2*Math.max(.1,grip*9.81*.82));
}
export function safeFollowingSpeed(gap,leaderSpeed=0,grip=.94) {
  const brake=grip*9.81*.82,reaction=.35;
  // Solve d >= v*reaction + (v² - lead²)/(2b), with a standstill buffer.
  return Math.max(0,-brake*reaction+Math.sqrt((brake*reaction)**2+leaderSpeed**2+2*brake*Math.max(0,gap-1.1)));
}
