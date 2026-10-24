// Device counters describe resource pressure, never native drive readiness.
export const GPU_SAMPLE_MAX_AGE_S=6;
export function gpuStatus(provider,nowUnix=Date.now()/1000) {
  const perf=provider.performance||{},gpu=perf.gpu;
  const unknown={status:'unavailable',name:'GPU monitoring unavailable',memory:'VRAM unmeasured',load:'GPU load unmeasured',
    percent:null,detail:provider.isReplay?'Live GPU usage is unavailable during replay.':
      provider.simulatorStop?.status==='STOPPED'?'CARLA is closed. Other apps can still use GPU memory.':
      provider.simulatorStop?.status==='STOPPING'?'Closing CARLA. GPU release is confirmed by process exit, not by VRAM reaching zero.':
      perf.gpuMonitorError?'The GPU monitor could not read the device.':'Waiting for a GPU measurement.',
    freshness:'No current sample',budget:''};
  if(provider.isReplay||!gpu)return unknown;
  const age=nowUnix-gpu.observedAtUnix;
  const dated=Number.isFinite(gpu.observedAtUnix)&&Number.isFinite(age)&&age>=-1;
  const fresh=dated&&age<=GPU_SAMPLE_MAX_AGE_S;
  const memoryValid=Number.isFinite(gpu.usedMiB)&&Number.isFinite(gpu.totalMiB)&&
    gpu.totalMiB>0&&gpu.usedMiB>=0&&gpu.usedMiB<=gpu.totalMiB;
  const percent=memoryValid?100*gpu.usedMiB/gpu.totalMiB:null;
  const loadValid=Number.isFinite(gpu.utilizationPercent)&&gpu.utilizationPercent>=0&&gpu.utilizationPercent<=100;
  const status=!fresh?'stale':!memoryValid?'unavailable':percent>=95?'critical':percent>=90?'high':'normal';
  let detail=!fresh?'Waiting for a current GPU sample; these are the last reported values.':
    !memoryValid?'VRAM usage could not be measured.':percent>=95?'VRAM is nearly full. Close GPU-heavy apps or use Free GPU.':
    percent>=90?'VRAM usage is high. Limited memory remains for the simulator.':
    loadValid&&gpu.utilizationPercent>=95?'GPU load is high; the simulator may run more slowly.':'GPU usage does not grant scenario access. Native validation and city/sensor readiness are separate checks.';
  if(provider.simulatorStop?.status==='STOPPING')detail='Closing CARLA. GPU release is confirmed by process exit, not by VRAM reaching zero.';
  else if(provider.simulatorStop?.status==='STOPPED')detail='CARLA is closed. Other apps can still use GPU memory.';
  const limit=perf.gpuBudget?.limitMiB;
  return {status,name:gpu.name||'Reported GPU',percent,
    memory:memoryValid?`${Math.round(gpu.usedMiB).toLocaleString('en-US')} / ${Math.round(gpu.totalMiB).toLocaleString('en-US')} MiB · ${Math.round(percent)}% VRAM`:'VRAM unmeasured',
    load:loadValid?`${Math.round(gpu.utilizationPercent)}% GPU load`:'GPU load unmeasured',
    detail:memoryValid?`${fresh?'':'Last reported: '}${Math.round(gpu.totalMiB-gpu.usedMiB).toLocaleString('en-US')} MiB available · ${detail}`:detail,
    freshness:!dated?'Sample time unavailable':`${fresh?'Updated':'Last sample'} ${Math.max(0,Math.floor(age))} s ago${fresh?'':' · stale'}`,
    budget:fresh&&memoryValid&&Number.isFinite(limit)&&limit>0?
      `${limit.toLocaleString('en-US')} MiB VRAM target ${gpu.usedMiB>limit?'exceeded':'met'} · all apps on this GPU · advisory only`:''};
}

export function installGPUStatus(container) {
  container.innerHTML='<div class="mission-gpu-heading"><strong></strong><span class="mission-gpu-freshness"></span></div><div class="mission-gpu-values"><span></span><span></span></div><div class="mission-vram-meter" role="meter" aria-label="Device VRAM used by all applications" aria-valuemin="0" aria-valuemax="100"><i></i></div><p class="mission-gpu-detail"></p><p class="mission-gpu-budget"></p>';
  container.setAttribute('aria-label','GPU and VRAM usage');
  const meter=container.querySelector('[role=meter]');
  return provider=>{
    const data=gpuStatus(provider);container.dataset.status=data.status;
    const set=(selector,value)=>{const el=container.querySelector(selector);if(el.textContent!==value)el.textContent=value;};
    set('strong',data.name);set('.mission-gpu-freshness',data.freshness);
    set('.mission-gpu-values span:first-child',data.memory);set('.mission-gpu-values span:last-child',data.load);
    set('.mission-gpu-detail',data.detail);set('.mission-gpu-budget',data.budget);
    container.querySelector('.mission-gpu-budget').hidden=!data.budget;
    meter.hidden=data.percent===null;
    if(data.percent!==null){
      meter.setAttribute('aria-valuenow',String(data.percent));
      meter.setAttribute('aria-valuetext',`${data.memory}${data.status==='stale'?' · stale sample':''}`);
      meter.querySelector('i').style.width=data.percent+'%';
    }else {meter.removeAttribute('aria-valuenow');meter.removeAttribute('aria-valuetext');}
  };
}
