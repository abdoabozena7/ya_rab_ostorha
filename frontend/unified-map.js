import {predictionWorldPoint,measuredPredictionFresh} from './prediction-view.js';

export function worldToEgo(point,origin,yaw) {
  const dx=point[0]-origin[0],dy=point[1]-origin[1],c=Math.cos(yaw),s=Math.sin(yaw);
  return [dx*c+dy*s,-dx*s+dy*c];
}

// A shallow perspective keeps every native road, route and measured actor in
// the same world-coordinate projection while making the road ahead legible.
export function perspectivePoint(point,origin,yaw,zoom=1,expanded=false,width=480,height=360) {
  const [forward,right]=worldToEgo(point,origin,yaw),scale=(expanded?6:4.8)*zoom;
  const depth=1+Math.max(0,forward)/100;
  const compactScale=expanded?1:Math.max(.7,width/480);
  return [width/2+right*scale*compactScale/depth,height*(262/360)-forward*scale*(expanded?height/360:.75)*.78/depth];
}

export function mapCanvasPoint(x,y,box,width=480,height=360) {
  const scale=Math.min(box.width/width,box.height/height);
  return [(x-box.left-(box.width-width*scale)/2)/scale,(y-box.top-(box.height-height*scale)/2)/scale];
}

export function mapPrediction(prediction,p) {
  return (p.fresh||p.isReplay)&&prediction?.render_reference&&prediction.coordinate_frame==='EGO_AT_EVALUATION'&&
    measuredPredictionFresh(prediction,p.sessionId,p.telemetry?.timestamp)?prediction:null;
}

export function mapForecastStatus(prediction,p) {
  if(!p.fresh&&!p.isReplay)return 'Forecast unavailable · simulator disconnected';
  if(!prediction)return 'Forecast unavailable · waiting for measured motion';
  if(!mapPrediction(prediction,p))return 'Forecast stale or incompatible · paths hidden';
  const age=(p.telemetry.timestamp-prediction.timestamp_s).toFixed(1),tracks=prediction.tracks||[];
  const source=prediction.display_source||prediction.decision_source||'Measured';
  const horizon=prediction.horizon_s??prediction.trajectories?.[0]?.points?.at(-1)?.[0];
  return `${source} · ${age} s old${Number.isFinite(horizon)?' · '+horizon+' s horizon':''} · ${tracks.length?tracks.length+' measured objects':'No tracked actors'}${prediction.model_reason?' · '+prediction.model_reason:''}`;
}

export function installUnifiedMap(p,view,tools) {
  const panel=document.createElement('section');panel.id='unifiedMap';panel.setAttribute('aria-label','Unified Navigation & Prediction Map');
  panel.innerHTML='<button id="unifiedMapToggle" type="button" aria-expanded="false" aria-label="Open route map (M)"></button><header><span><small>LIVE GEOMETRY</small><strong>Navigation</strong></span><span class="unified-map-actions"><button id="unifiedRouteAction" aria-label="Choose a destination">Route ↗</button><button id="expandUnifiedMap" aria-expanded="false" aria-label="Collapse navigation and prediction map">×</button></span></header><div class="map-layer-switch" role="group" aria-label="Map layers"><button data-layer="route">Route</button><button data-layer="predictions">Predictions</button><button data-layer="both" aria-pressed="true">Both</button></div><canvas width="480" height="360" id="unifiedMapCanvas" role="img" aria-label="Actual CARLA road geometry and measured motion forecasts"></canvas><p id="unifiedMapRoute">Waiting for route</p><p id="unifiedMapMeta" role="status">Waiting for map data</p><div class="unified-expanded-tools"><div class="unified-filters"><label><input type="checkbox" data-filter="vehicles" checked>Vehicles</label><label><input type="checkbox" data-filter="people" checked>People</label><label><input type="checkbox" data-filter="paths" checked>Paths</label><label><input type="checkbox" data-filter="conflicts" checked>Conflicts</label></div><label for="unifiedMapActor">Measured object</label><select id="unifiedMapActor"><option value="">Overview</option></select><p id="unifiedActorInfo">Select a measured object to inspect its motion.</p><button id="unifiedChooseDestination">Choose destination ↗</button></div>';
  document.getElementById('frontCameraView').append(panel);
  const $=id=>panel.querySelector('#'+id),canvas=$('unifiedMapCanvas'),ctx=canvas.getContext('2d');
  let layer='both',expanded=false,selected='',markers=[],lastKey='',actorKey='',lastPrediction=null,lastPose=null,lastSession=null,lastVehicle=null,zoom=1;
  const redraw=()=>{lastKey='';if(lastVehicle)map.update(lastVehicle);};
  const zoomTools=document.createElement('div');zoomTools.className='unified-zoom';
  for(const [label,factor] of [['−',.8],['+',1.25],['Recenter',0]]){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-label',label==='+'?'Zoom map in':label==='−'?'Zoom map out':'Recenter map on vehicle');b.onclick=()=>{zoom=factor?Math.max(.25,Math.min(4,zoom*factor)):1;redraw();};zoomTools.append(b);}
  panel.querySelector('.unified-expanded-tools').prepend(zoomTools);
  const filters={vehicles:true,people:true,paths:true,conflicts:true};
  const text=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
  const toggle=()=>{
    expanded=!expanded;panel.classList.toggle('map-expanded',expanded);$('expandUnifiedMap').setAttribute('aria-expanded',String(expanded));
    $('expandUnifiedMap').setAttribute('aria-label',expanded?'Collapse navigation and prediction map':'Expand navigation and prediction map');
    $('unifiedMapToggle').setAttribute('aria-expanded',String(expanded));
    $('unifiedMapToggle').setAttribute('aria-label',expanded?'Close route map (M)':'Open route map (M)');
    $('expandUnifiedMap').textContent='×';redraw();
    if(expanded&&(p.controlMode==='MANUAL'||tools.options.isManualArmed?.()))tools.controls.keys.clear();
  };
  $('expandUnifiedMap').onclick=toggle;
  $('unifiedMapToggle').onclick=toggle;
  panel.addEventListener('keydown',e=>{if(e.key==='Escape'&&expanded){e.stopPropagation();toggle();$('expandUnifiedMap').focus();}});
  panel.querySelectorAll('[data-layer]').forEach(b=>b.onclick=()=>{layer=b.dataset.layer;panel.querySelectorAll('[data-layer]').forEach(other=>other.setAttribute('aria-pressed',String(other===b)));redraw();});
  panel.querySelectorAll('[data-filter]').forEach(box=>box.onchange=()=>{filters[box.dataset.filter]=box.checked;redraw();});
  $('unifiedChooseDestination').onclick=()=>tools.open('routePanel','unifiedChooseDestination');
  $('unifiedRouteAction').onclick=()=>tools.open('routePanel','unifiedRouteAction');
  $('unifiedMapActor').onchange=()=>{selected=$('unifiedMapActor').value;redraw();};
  new ResizeObserver(()=>{
    const box=canvas.getBoundingClientRect();
    if(box.width<40||box.height<40)return;
    const width=Math.round(box.width),height=Math.round(box.height);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;redraw();}
  }).observe(canvas);
  canvas.onclick=event=>{
    const box=canvas.getBoundingClientRect(),[x,y]=mapCanvasPoint(event.clientX,event.clientY,box,canvas.width,canvas.height);
    const close=markers.map(m=>({...m,d:Math.hypot(m.x-x,m.y-y)})).sort((a,b)=>a.d-b.d)[0];
    selected=close?.d<18?close.id:'';$('unifiedMapActor').value=selected;if(!expanded)toggle();else redraw();
  };
  const map={update(vehicle){
    lastVehicle=vehicle;
    if(document.body.dataset.ui!=='guided'||document.body.dataset.workspace!=='drive')return;
    if(!p.fresh&&!p.isReplay)lastPose=null;
    if(lastSession&&p.sessionId&&lastSession!==p.sessionId)lastPose=null;
    if(p.sessionId)lastSession=p.sessionId;
    const prediction=mapPrediction(view.currentPrediction,p),roads=tools.catalog?.roads;
    const key=[p.sessionId,vehicle.frame,prediction?.evaluation_frame,p.route?.id,layer,expanded,selected,document.documentElement.dataset.appearance,Object.values(filters).join()].join(':');
    if(key===lastKey&&lastPrediction===prediction)return;lastKey=key;lastPrediction=prediction;
    if(vehicle.positionWorldM?.every(Number.isFinite)&&Number.isFinite(vehicle.headingRad))lastPose={origin:vehicle.positionWorldM,yaw:vehicle.headingRad};
    panel.dataset.offline=String(!lastPose&&!p.fresh&&!p.isReplay);
    const {origin,yaw}=lastPose||{};
    const colors={landFar:'#E7F0FF',landNear:'#F0FAF7',roadShadow:'#E6ECF6',roadEdge:'#E6ECF6',road:'#FFFFFF',lane:'#E6ECF6',route:'#4B84FC',routeGlow:'#E7F0FF',actor:'#4B84FC',person:'#753CF7',text:'#11182F',muted:'#66738F',destination:'#753CF7'};
    const mapWidth=canvas.width,mapHeight=canvas.height,carY=mapHeight*(262/360);ctx.clearRect(0,0,mapWidth,mapHeight);markers=[];
    const ground=ctx.createLinearGradient(0,0,0,mapHeight);ground.addColorStop(0,colors.landFar);ground.addColorStop(1,colors.landNear);ctx.fillStyle=ground;ctx.fillRect(0,0,mapWidth,mapHeight);
    if(!origin||!Number.isFinite(yaw)){text($('unifiedMapMeta'),'Map unavailable · simulator disconnected');return;}
    const project=world=>perspectivePoint(world,origin,yaw,zoom,expanded,mapWidth,mapHeight);
    const line=(points,color,width=2,dash=[])=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();points.forEach((q,i)=>i?ctx.lineTo(...q):ctx.moveTo(...q));ctx.stroke();ctx.setLineDash([]);};
    // The ribbon is a screen-space rendering of the supplied CARLA centerline.
    // Its tapered width and small cast shadow convey depth without adding streets.
    const ribbon=(points,widths,color,offsetY=0)=>{
      if(points.length<2)return;
      ctx.beginPath();
      for(const side of [1,-1])for(const i of side===1?points.keys():Array.from(points.keys()).reverse()){
        const a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)];
        const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy)||1;
        const x=points[i][0]-dy/length*widths[i]*side/2,y=points[i][1]+dx/length*widths[i]*side/2+offsetY;
        if(side===1&&i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.closePath();ctx.fillStyle=color;ctx.fill();
    };
    if(roads?.segments?.length){ctx.lineCap='round';ctx.lineJoin='round';for(const segment of roads.segments){
      const pts=segment.map(project);if(!pts.some(q=>q[0]>-30&&q[0]<mapWidth+30&&q[1]>-30&&q[1]<mapHeight+30))continue;
      const widths=segment.map(point=>{
        const forward=worldToEgo(point,origin,yaw)[0];
        return Math.max(expanded?6:3,34*(expanded?mapWidth/480:.65)*zoom/(1+Math.max(0,forward)/75));
      });
      ribbon(pts,widths.map(width=>width+9),colors.roadShadow,5);
      ribbon(pts,widths.map(width=>width+5),colors.roadEdge,2);
      ribbon(pts,widths,colors.road);
      line(pts,colors.lane,1.5,[9,13]);
    }}
    if(layer!=='predictions'&&p.route?.points?.length){const path=p.route.points.map(project);line(path,colors.routeGlow,12);line(path,colors.route,5);
      if(p.route.destination?.location){const q=project(p.route.destination.location),x=Math.max(20,Math.min(mapWidth-20,q[0])),y=Math.max(22,Math.min(mapHeight-35,q[1]));
        ctx.fillStyle=colors.destination;ctx.beginPath();ctx.moveTo(x,y+11);ctx.lineTo(x-8,y-3);ctx.arc(x,y-4,8,Math.PI,0);ctx.closePath();ctx.fill();
        ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,y-4,3,0,Math.PI*2);ctx.fill();
      }
    }
    const convert=point=>project(predictionWorldPoint(point,prediction.render_reference));
    const tracks=(prediction?.tracks||[]).filter(t=>t.class==='person'?filters.people:filters.vehicles);
    if(prediction&&layer!=='route') {
      const ids=new Set(tracks.filter(t=>t.confirmed).map(t=>String(t.id))),counts=new Map();
      if(filters.paths)for(const mode of prediction.trajectories||[]) {
        const id=String(mode.track_id),count=counts.get(id)||0;if(!ids.has(id)||count>=3)continue;counts.set(id,count+1);
        const path=mode.points.map(row=>convert([row[1],row[2],0])),color=mode.source?.includes('TRAJECTRON')?selected&&selected!==id?'#a898cb66':'#ae7ce9':selected&&selected!==id?'#3ca0a666':colors.actor;
        line(path,color,selected===id?3.6:2.6,[7,5]);
        if(path.length){const end=path.at(-1);ctx.fillStyle=color;ctx.beginPath();ctx.arc(end[0],end[1],selected===id?4.5:3,0,Math.PI*2);ctx.fill();}
      }
      if(filters.conflicts&&prediction.conflict_point){const q=convert([...prediction.conflict_point.point_m,0]);ctx.strokeStyle='#dc8b36';ctx.lineWidth=2;ctx.beginPath();ctx.arc(...q,13,0,Math.PI*2);ctx.stroke();}
    }
    // Measured actors remain visible when only the route layer is selected.
    if(prediction)for(const tr of tracks){const [x,y]=convert([...tr.position_m,0]),id=String(tr.id);markers.push({id,x,y});ctx.fillStyle=selected===id?colors.route:tr.confirmed?tr.class==='person'?colors.person:colors.actor:colors.muted;
        if(tr.class==='person'){ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();}else{ctx.fillRect(x-4,y-7,8,14);}
        if(selected===id){ctx.strokeStyle=colors.route;ctx.beginPath();ctx.arc(x,y,11,0,Math.PI*2);ctx.stroke();}
      }
    const carX=mapWidth/2;ctx.shadowColor='#b05c7955';ctx.shadowBlur=12;ctx.fillStyle=colors.route;ctx.beginPath();ctx.arc(carX,carY,Math.min(19,mapWidth*.08),0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(carX,carY-15);ctx.lineTo(carX-9,carY+11);ctx.lineTo(carX,carY+6);ctx.lineTo(carX+9,carY+11);ctx.closePath();ctx.fill();
    if(expanded){ctx.fillStyle=colors.text;ctx.font='bold 11px Geist, sans-serif';ctx.fillText('YOU ↑',carX+24,carY+4);
      ctx.font='10px Geist, sans-serif';ctx.fillStyle=colors.muted;ctx.fillText((p.world?.map||'CARLA')+' · native road map',12,mapHeight-17);}
    const age=prediction?Math.max(0,p.telemetry.timestamp-prediction.timestamp_s).toFixed(1):null;
    const coverage=p.safetySystem?.observed_road_range_m;
    const gap=p.safetySystem?.measured_range_m;
    const measuredRoad=p.fresh&&Number.isFinite(coverage)?`Road seen ${coverage.toFixed(1)} m${Number.isFinite(gap)?` · Front gap ${gap.toFixed(1)} m`:''} · `:'';
    text($('unifiedMapMeta'),(!p.fresh&&!p.isReplay?'Last measured map · ':roads?'':'Road geometry unavailable · ')+measuredRoad+mapForecastStatus(view.currentPrediction,p));
    text($('unifiedMapRoute'),p.route?.destination?.name?`${p.route.destination.name} · ${Number.isFinite(p.route.remaining_m)?Math.round(p.route.remaining_m)+' m remaining':'route selected'}`:'Choose a destination to see the route');
    const ids=tracks.map(t=>t.id).join('|');
    if(ids!==actorKey){actorKey=ids;const empty=document.createElement('option');empty.value='';empty.textContent='Overview';$('unifiedMapActor').replaceChildren(empty,...tracks.map(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.class+' #'+t.id;return o;}));if(!tracks.some(t=>String(t.id)===selected))selected='';$('unifiedMapActor').value=selected;}
    const tr=tracks.find(t=>String(t.id)===selected),assessment=prediction?.object_assessments?.[selected];
    text($('unifiedActorInfo'),tr?`${tr.class} #${tr.id} · ${(Math.hypot(...tr.velocity_mps)*3.6).toFixed(1)} km/h · ${Math.hypot(...tr.velocity_mps)<.3?'stationary':Math.round(Math.atan2(tr.velocity_mps[1],tr.velocity_mps[0])*180/Math.PI)+'° relative to ego at measurement'} · ${assessment?.status?.replaceAll('_',' ')||'intersection unassessed'}${Number.isFinite(assessment?.minimum_clearance_m)?' · gap '+assessment.minimum_clearance_m.toFixed(1)+' m':''} · gaze unknown`:'Select a measured object to inspect its motion.');
    canvas.setAttribute('aria-label',`${roads?'CARLA road geometry':'Road geometry unavailable'}; ${p.route?'route selected':'no route'}; ${prediction?tracks.length+' measured objects, '+age+' seconds old':'prediction unavailable'}. Expand for keyboard object selection.`);
  }};
  new MutationObserver(redraw).observe(document.documentElement,{attributes:true,attributeFilter:['data-appearance']});
  return map;
}
