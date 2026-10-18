import {illustratedPreview} from './illustrated-preview.js';
import {previewFrame,previewLabels} from './preview-story.js';

export function installPreviewPlayer(host){
  host.innerHTML='<div class="preview-canvas">'+illustratedPreview+'</div><div class="preview-caption"><strong id="previewModeTitle"></strong><p id="previewMessage" aria-live="off"></p><small>Same sensors, same visible person. Scripted example · actual outcomes can differ.</small></div>';
  const $=selector=>host.querySelector(selector),media=matchMedia('(prefers-reduced-motion: reduce)');
  let mode='NORMAL',playing=!media.matches,enabled=false,inView=true,elapsed=0,last=0,raf=0,phase='';
  function render(){
    const frame=previewFrame(mode,elapsed);host.dataset.previewPhase=frame.phase;host.dataset.previewMode=mode;
    host.dataset.previewPlaying=String(playing&&enabled&&inView&&!document.hidden);
    $('.demo-car-position').setAttribute('transform',`translate(${frame.carX.toFixed(2)} 0)`);
    $('.demo-person').setAttribute('transform',`translate(780 ${(281+frame.pedestrianY).toFixed(2)})`);
    $('.demo-foreground').style.opacity=String(frame.opacity);
    $('.demo-prediction').style.display=frame.prediction?'':'none';$('.demo-contact').style.display=frame.contact?'':'none';
    $('.demo-reactive').style.display=frame.reactive?'':'none';$('.demo-braking').style.display=frame.braking?'':'none';

    $('.demo-detection').setAttribute('y',String(241+frame.pedestrianY));
    $('.demo-sensing').style.display=frame.detected?'':'none';
    $('.demo-cone').setAttribute('d',`M${724+frame.carX} 300 795 267 795 386Z`);
    $('.demo-person').classList.toggle('is-walking',frame.walking&&playing&&enabled);
    const stride=frame.walking?Math.sin(elapsed*12)*5:0;
    $('.demo-left-leg').setAttribute('d',`M-5 1l${-3+stride} 17`);$('.demo-right-leg').setAttribute('d',`M6 1l${6-stride} 16`);
    for(const wheel of host.querySelectorAll('.sketch-wheel'))wheel.setAttribute('transform',`rotate(${(frame.carX+350)*3})`);
    if(phase!==frame.phase){phase=frame.phase;$('#previewMessage').textContent=frame.message;}

  }
  function tick(now){raf=0;if(!playing||!enabled||!inView||document.hidden){last=0;render();return;}
    if(last)elapsed+=(now-last)/1000;last=now;render();raf=requestAnimationFrame(tick);
  }
  function schedule(){if(raf)cancelAnimationFrame(raf);raf=0;last=0;render();if(playing&&enabled&&inView&&!document.hidden)raf=requestAnimationFrame(tick);}
  function select(value){mode=value;elapsed=.02;phase='';playing=!media.matches;
    $('#previewModeTitle').textContent=previewLabels[mode];

    schedule();
  }

  media.addEventListener('change',()=>{playing=!media.matches;schedule();});
  document.addEventListener('visibilitychange',schedule);
  if(globalThis.IntersectionObserver)new IntersectionObserver(entries=>{inView=entries.at(-1).isIntersecting;schedule();},{threshold:.05}).observe(host);
  select('NORMAL');
  return {select,setVisible(value){if(enabled!==value){enabled=value;schedule();}}};
}
