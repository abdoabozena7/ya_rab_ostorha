// Distinct decoded presentations at RAF, never requested camera or engine FPS.
export class CameraPerformance {
  constructor({profile='LEGACY'}={}){this.profile=profile;this.reset();}
  reset(){
    this.arm=null;this.started=null;this.previous=null;this.frames=[];this.windows=[];
    this.maxGapMs=0;this.presented=0;this.failedWindows=0;this.completedWindows=0;
  }
  setProfile(profile){if(this.profile!==profile){this.profile=profile;this.reset();}}
  present(frame,simTime,wallMs,arm){
    if(!Number.isSafeInteger(frame)||frame<0||!Number.isFinite(simTime)||!Number.isFinite(wallMs))return false;
    if(this.arm!==arm){this.reset();this.arm=arm;}
    if(this.previous&&(frame<=this.previous.frame||wallMs<=this.previous.wallMs||simTime<=this.previous.simTime))return false;
    if(this.started===null)this.started=wallMs;
    this.advance(wallMs);
    const gap=this.previous?wallMs-this.previous.wallMs:null;
    this.maxGapMs=Math.max(this.maxGapMs,gap||0);
    this.previous={frame,simTime,wallMs,gap};
    this.frames.push(this.previous);this.presented++;
    return true;
  }
  advance(wallMs){
    if(this.started===null)return;
    while(wallMs-this.started>=10000){
      const end=this.started+10000,rows=this.frames.filter(f=>f.wallMs>=this.started&&f.wallMs<end);
      const gaps=rows.map(f=>f.gap).filter(Number.isFinite);
      const last=rows.at(-1);
      if(last)gaps.push(end-last.wallMs);
      gaps.sort((a,b)=>a-b);
      const rate=rows.length/10;
      const ratio=rows.length>1?(last.simTime-rows[0].simTime)/((last.wallMs-rows[0].wallMs)/1000):0;
      const p95=gaps.length?gaps[Math.ceil(gaps.length*.95)-1]:null;
      const maxGap=Math.max(0,...gaps);
      const strict=this.profile==='PERFORMANCE_60';
      const passed=strict?rate>=58&&rate<=60&&ratio>=.95&&ratio<=1.05&&p95!==null&&p95<=25:
        rate>=15&&maxGap<=250&&ratio>=.9;
      this.windows.push({start_wall_ms:this.started,frames:rows.length,fps:rate,
        simulation_wall_ratio:ratio,p95_frame_interval_ms:p95,max_frame_gap_ms:maxGap,passed});
      if(this.windows.length>180)this.windows.shift();
      this.completedWindows++;if(!passed)this.failedWindows++;
      this.started=end;this.frames=this.frames.filter(f=>f.wallMs>=end);
    }
  }
  snapshot(){
    return {arm:this.arm,profile:this.profile,displayed_frames:this.presented,windows:this.windows,
      completed_windows:this.completedWindows,failed_windows:this.failedWindows,maximum_gap_ms:this.maxGapMs,
      acceptance_scope:'DISTINCT_RAF_PRESENTATIONS_ONLY_GPU_BUDGET_MEASURED_SEPARATELY',
      passed:this.completedWindows>0&&this.failedWindows===0&&
        (this.profile==='PERFORMANCE_60'||this.maxGapMs<=250)};
  }
}
