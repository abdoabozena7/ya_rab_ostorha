// Actual decoded image presentations, not sensor publication rate.
export class CameraPerformance {
  constructor(){this.reset();}
  reset(){this.arm=null;this.started=null;this.previous=null;this.frames=[];this.windows=[];this.maxGapMs=0;}
  present(frame,simTime,wallMs,arm){
    if(this.arm!==arm){this.reset();this.arm=arm;}
    if(this.previous?.frame===frame)return;
    if(this.started===null)this.started=wallMs;
    const gap=this.previous?wallMs-this.previous.wallMs:0;
    this.maxGapMs=Math.max(this.maxGapMs,gap);
    this.previous={frame,simTime,wallMs};this.frames.push(this.previous);
    while(wallMs-this.started>=10000){
      const end=this.started+10000,rows=this.frames.filter(f=>f.wallMs>=this.started&&f.wallMs<end);
      const rate=rows.length/10,ratio=rows.length>1?(rows.at(-1).simTime-rows[0].simTime)/((rows.at(-1).wallMs-rows[0].wallMs)/1000):0;
      const maxGap=Math.max(0,...rows.slice(1).map((f,i)=>f.wallMs-rows[i].wallMs));
      this.windows.push({start_wall_ms:this.started,frames:rows.length,fps:rate,simulation_wall_ratio:ratio,max_frame_gap_ms:maxGap,
        passed:rate>=15&&maxGap<=250&&ratio>=.9});
      this.started=end;this.frames=this.frames.filter(f=>f.wallMs>=end);
    }
  }
  snapshot(){return {arm:this.arm,windows:this.windows,maximum_gap_ms:this.maxGapMs,
    passed:this.windows.length>0&&this.maxGapMs<=250&&this.windows.every(w=>w.passed)};}
}
