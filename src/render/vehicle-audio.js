export function createVehicleAudio() {
  let context,engine,hornA,hornB,engineGain,hornGain,roadGain,filter;
  function unlock() {
    if(context){context.resume();return;}
    const Audio=window.AudioContext??window.webkitAudioContext;if(!Audio)return;
    context=new Audio();
    engine=context.createOscillator();engine.type='sawtooth';
    engineGain=context.createGain();engineGain.gain.value=0;
    filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=320;
    engine.connect(filter).connect(engineGain).connect(context.destination);engine.start();
    hornGain=context.createGain();hornGain.gain.value=0;hornGain.connect(context.destination);
    hornA=context.createOscillator();hornB=context.createOscillator();
    hornA.type=hornB.type='triangle';hornA.frequency.value=440;hornB.frequency.value=554;
    hornA.connect(hornGain);hornB.connect(hornGain);hornA.start();hornB.start();
    const buffer=context.createBuffer(1,context.sampleRate*2,context.sampleRate),data=buffer.getChannelData(0);
    let last=0;for(let i=0;i<data.length;i++){last=(last+Math.random()*.2-.1)/1.03;data[i]=last;}
    const noise=context.createBufferSource();noise.buffer=buffer;noise.loop=true;
    roadGain=context.createGain();roadGain.gain.value=0;noise.connect(roadGain).connect(context.destination);noise.start();
  }
  return {unlock,update(speed,throttle,roughness,horn,muted=false,scale=1) {
    if(!context)return;
    const t=context.currentTime;
    engine.frequency.setTargetAtTime((32+Math.abs(speed)*2.5+throttle*25)*Math.max(.4,scale),t,.08);
    engineGain.gain.setTargetAtTime(muted?0:.015+throttle*.02,t,.08);
    roadGain.gain.setTargetAtTime(muted?0:Math.min(.12,Math.abs(speed)*roughness*.22),t,.1);
    hornGain.gain.setTargetAtTime(horn&&!muted?.1:0,t,.02);
  }};
}
