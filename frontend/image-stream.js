import {CameraPerformance} from './camera-performance.js';

const protocol='ostorha-image-v1',maximumBytes=4*1024*1024;

export function parseImagePacket(buffer){
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<5||buffer.byteLength>maximumBytes+16388)
    throw new Error('Invalid image packet size');
  const length=new DataView(buffer).getUint32(0);
  if(length<2||length>16384||4+length>=buffer.byteLength)throw new Error('Invalid image header size');
  const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(buffer,4,length)));
  if(header.protocol!==protocol||header.content_type!=='image/jpeg'||
    typeof header.session_id!=='string'||!header.session_id||typeof header.camera_id!=='string'||
    !['frontCamera','drivingCamera'].includes(header.camera_id)||
    !Number.isSafeInteger(header.frame_id)||header.frame_id<0||
    !Number.isFinite(header.simulation_timestamp_s)||header.simulation_timestamp_s<0||
    ![header.width,header.height].every(v=>Number.isInteger(v)&&v>0&&v<=4096)||
    header.payload_bytes!==buffer.byteLength-4-length||header.payload_bytes>maximumBytes)
    throw new Error('Invalid image identity, dimensions or payload');
  if(header.capture_unix_s!==null&&!Number.isFinite(header.capture_unix_s))
    throw new Error('Invalid image capture clock');
  return {header,payload:new Uint8Array(buffer,4+length)};
}

export class CameraImageStream {
  constructor({Socket=globalThis.WebSocket,decode=blob=>globalThis.createImageBitmap(blob),
    raf=callback=>globalThis.requestAnimationFrame(callback),cancel=token=>globalThis.cancelAnimationFrame(token),
    now=()=>performance.now(),wallNow=()=>performance.timeOrigin+performance.now(),
    visible=()=>!globalThis.document?.hidden,draw,onPresent=()=>{},onUnavailable=()=>{},
    meter=new CameraPerformance()}={}){
    Object.assign(this,{Socket,decode,raf,cancel,now,wallNow,visible,draw,onPresent,onUnavailable,meter});
    this.enabled=false;this.generation=0;this.socket=null;this.decoding=null;
    this.pending=null;this.ready=null;this.lastFrame=-1;this.lastSimTime=null;this.offsetMs=null;this.clockUncertaintyMs=null;
    this.drops={late:0,superseded:0,session:0,outOfOrder:0};this.retryAt=0;this.decodeMs=null;
    this.imageLatencyMs=null;this.lastPresentedAt=null;this.reportedAt=-Infinity;
  }
  configure({enabled,sessionId,url,cameraId='drivingCamera',profile='LEGACY',arm}={}){
    if(!enabled||!sessionId||!url){if(this.enabled)this.stop();return;}
    const key=[sessionId,url,cameraId].join(':');
    this.arm=(arm||key)+':'+cameraId;this.meter.setProfile(profile);
    if(this.enabled&&key===this.key)return;
    this.stop();this.enabled=true;this.key=key;this.sessionId=sessionId;this.url=url;this.cameraId=cameraId;
    this.meter.reset();this.onUnavailable('Waiting for this session camera');
    this.lastFrame=-1;this.lastSimTime=null;this.offsetMs=this.clockUncertaintyMs=null;this.retryAt=0;this.connect();
    this.rafToken=this.raf(time=>this.render(time));
  }
  connect(){
    if(!this.enabled||this.socket||this.now()<this.retryAt)return;
    const generation=this.generation,socket=new this.Socket(this.url);
    this.socket=socket;socket.binaryType='arraybuffer';
    socket.onopen=()=>{
      if(this.socket!==socket||generation!==this.generation)return;
      this.clockSentAt=this.wallNow();
      socket.send(JSON.stringify({type:'subscribe',session_id:this.sessionId,camera_id:this.cameraId,
        client_unix_ms:this.clockSentAt}));
    };
    socket.onmessage=event=>{
      if(this.socket!==socket||generation!==this.generation)return;
      try{
        if(typeof event.data==='string'){
          const message=JSON.parse(event.data);
          if(message.type==='image_stream'){
            if(message.session_id!==this.sessionId||message.camera_id!==this.cameraId||message.protocol!==protocol||
              message.client_unix_ms!==this.clockSentAt||!Number.isFinite(message.server_unix_ms))
              throw new Error('Image clock/session handshake mismatch');
            const received=this.wallNow();
            this.offsetMs=message.server_unix_ms-(this.clockSentAt+received)/2;
            this.clockUncertaintyMs=Math.max(0,(received-this.clockSentAt)/2);
          } else if(message.status==='ERROR'||message.status==='SESSION_CHANGED'){
            throw new Error(message.error||'Image session changed');
          }
          return;
        }
        if(this.offsetMs===null)throw new Error('Image arrived before its clock handshake');
        const image=parseImagePacket(event.data),h=image.header;
        socket.send(JSON.stringify({type:'ack',session_id:h.session_id,frame_id:h.frame_id,metrics:this.metrics()}));
        if(h.session_id!==this.sessionId||h.camera_id!==this.cameraId){this.drops.session++;return;}
        if(h.frame_id<=this.lastFrame||h.frame_id<=(this.pending?.header.frame_id??-1)||
          h.frame_id<=(this.ready?.header.frame_id??-1)||h.frame_id<=(this.decoding?.header.frame_id??-1)||
          this.lastSimTime!==null&&h.simulation_timestamp_s<=this.lastSimTime){this.drops.outOfOrder++;return;}
        if(this.expired(h)){this.drops.late++;return;}
        if(this.pending)this.drops.superseded++;
        this.pending=image;this.startDecode();
      }catch(error){this.fail(error.message);}
    };
    socket.onerror=()=>this.fail('Image WebSocket connection error');
    socket.onclose=()=>{
      if(this.socket!==socket)return;
      this.socket=null;this.generation++;this.decoding=null;this.retryAt=this.now()+500;
      this.clearPending();this.onUnavailable('Image stream disconnected; controls are separate');
    };
  }
  expired(header){
    if(header.capture_unix_s===null)return false;
    return this.wallNow()+this.offsetMs-header.capture_unix_s*1000>250;
  }
  startDecode(){
    if(this.decoding||!this.pending||!this.enabled)return;
    const job=this.pending,generation=this.generation;this.pending=null;this.decoding=job;
    const began=this.now();
    Promise.resolve().then(()=>this.decode(new Blob([job.payload],{type:'image/jpeg'}))).then(bitmap=>{
      if(!this.enabled||generation!==this.generation){bitmap.close();return;}
      if(bitmap.width!==job.header.width||bitmap.height!==job.header.height){
        bitmap.close();throw new Error('Decoded JPEG dimensions differ from native metadata');
      }
      if(this.expired(job.header)){this.drops.late++;bitmap.close();return;}
      if(this.ready){this.drops.superseded++;this.ready.bitmap.close();}
      this.decodeMs=this.now()-began;this.ready={header:job.header,bitmap};
    }).catch(error=>{
      if(this.enabled&&generation===this.generation)this.fail('Image decode failed: '+error.message);
    }).finally(()=>{
      if(this.decoding===job){this.decoding=null;this.startDecode();}
    });
  }
  render(wallMs){
    if(!this.enabled)return;
    this.connect();this.meter.advance(wallMs);
    const image=this.ready;this.ready=null;
    if(image){
      if(image.header.frame_id<=this.lastFrame){
        this.drops.outOfOrder++;image.bitmap.close();
      }else if(!this.visible()||this.expired(image.header)){
        this.drops.late++;image.bitmap.close();
      }else{
        try{
          this.draw(image.bitmap,image.header);
          const h=image.header;
          this.meter.present(h.frame_id,h.simulation_timestamp_s,wallMs,this.arm);
          this.lastFrame=h.frame_id;this.lastSimTime=h.simulation_timestamp_s;this.lastPresentedAt=this.wallNow();
          this.imageLatencyMs=h.capture_unix_s===null?null:Math.max(0,this.lastPresentedAt+this.offsetMs-h.capture_unix_s*1000);
          this.onPresent(h,this.meter.snapshot(),this.metrics());
        }catch(error){this.fail('Image presentation failed: '+error.message);}
        finally{image.bitmap.close();}
      }
    }
    if(this.lastPresentedAt!==null&&this.wallNow()-this.lastPresentedAt>250){
      this.lastPresentedAt=null;this.onUnavailable('Image expired; waiting for a fresh camera frame');
    }
    this.rafToken=this.raf(time=>this.render(time));
  }
  metrics(){
    const s=this.meter.snapshot(),w=s.windows.at(-1);
    const values={displayedFrames:s.displayed_frames,displayFps:w?.fps,p95IntervalMs:w?.p95_frame_interval_ms,
      imageLatencyMs:this.imageLatencyMs,decodeMs:this.decodeMs,clockUncertaintyMs:this.clockUncertaintyMs,
      droppedLate:this.drops.late,droppedSuperseded:this.drops.superseded,droppedSession:this.drops.session,
      droppedOutOfOrder:this.drops.outOfOrder,completedWindows:s.completed_windows,failedWindows:s.failed_windows,
      renderedAtUnixMs:this.lastPresentedAt};
    return Object.fromEntries(Object.entries(values).filter(([,v])=>Number.isFinite(v)&&v>=0));
  }
  fail(message){
    this.onUnavailable(message);this.retryAt=this.now()+1000;this.generation++;this.decoding=null;
    const socket=this.socket;this.socket=null;socket?.close();
    this.clearPending();
  }
  clearPending(){
    this.pending=null;this.ready?.bitmap.close();this.ready=null;
  }
  stop(){
    this.enabled=false;this.generation++;this.cancel(this.rafToken);this.rafToken=null;
    const socket=this.socket;this.socket=null;socket?.close();
    this.clearPending();this.decoding=null;this.lastPresentedAt=null;
  }
}
