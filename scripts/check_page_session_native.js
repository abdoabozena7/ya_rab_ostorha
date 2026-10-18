// Explicit native check: starts a short Normal drive, then opens a new isolated
// page which saves/interrupts it and prepares a fresh scene in the same engine.
async page=>{
 const root='http://127.0.0.1:8000',failures=[],errors=[],requests=[];
 const watch=p=>{p.on('pageerror',e=>errors.push(e.message));p.on('requestfailed',r=>failures.push({url:r.url(),reason:r.failure()?.errorText}));p.on('request',r=>requests.push({page:p===page?'A':'B',url:r.url()}));};
 watch(page);
 const state=async()=>await (await page.request.get(root+'/api/state')).json();
 const wait=async predicate=>{const end=Date.now()+120000;while(Date.now()<end){const s=await state();if(predicate(s))return s;await page.waitForTimeout(200);}throw Error('Native phase timeout');};
 await page.getByRole('button',{name:'Start the normal drive',exact:true}).waitFor({state:'visible',timeout:120000});
 await page.waitForFunction(()=>!document.getElementById('drivePrimaryAction').disabled);
 const first=await wait(s=>s.presentation?.status==='CHOOSING'&&!!s.presentation.page_id);
 if(!await page.getByRole('radio',{name:/See the world before our solution/}).isChecked())throw Error('Default mode is not selected');
 await page.waitForTimeout(1200);
 const idleRequests=requests.filter(r=>/\/api\/simulation\/(camera\.jpg|perception|prediction)/.test(r.url));
 if(idleRequests.length)throw Error('Invisible camera/analysis requested on starting page');
 await page.getByRole('button',{name:'Start the normal drive',exact:true}).click();
 await wait(s=>s.presentation.status==='DRIVING'&&s.presentation.id===first.presentation.id);
 await page.waitForTimeout(2500);
 const browser=page.context().browser(),context=await browser.newContext({viewport:{width:1440,height:1000}});
 const second=await context.newPage();watch(second);
 try{
  await second.goto(root+'/?verification=fresh-page');
  await second.waitForFunction(()=>document.getElementById('drivePrimaryAction')?.dataset.loading==='true',null,{timeout:30000});
  const loading=await second.locator('#drivePrimaryAction').evaluate(b=>({disabled:b.disabled,background:getComputedStyle(b).backgroundColor,fill:getComputedStyle(b,'::before').backgroundImage,animation:getComputedStyle(b,'::before').animationName,gpuHidden:document.getElementById('missionFreeGPU').hidden}));
  if(!loading.disabled||!loading.gpuHidden||loading.background!=='rgb(255, 255, 255)'||loading.fill!=='none')throw Error('Loading appearance/readiness mismatch '+JSON.stringify(loading));
  await second.screenshot({path:'output/playwright/page-session-loading.jpg',type:'jpeg',quality:80,fullPage:true});
  const prepared=await wait(s=>s.presentation?.status==='CHOOSING'&&s.presentation.page_id!==first.presentation.page_id);
  await second.waitForFunction(()=>!document.getElementById('drivePrimaryAction').disabled&&!document.getElementById('missionFreeGPU').hidden);
  await page.getByRole('button',{name:'Prepare a fresh drive here',exact:true}).waitFor({state:'visible'});
  if(await page.locator('#missionFreeGPU').isVisible())throw Error('Old page shows current session GPU action');
  if(prepared.presentation.id===first.presentation.id)throw Error('New page resumed an existing presentation');
  const run=prepared.journeyComparison.runs.NORMAL;
  if(run.reason!=='page_replaced'||run.status!=='INTERRUPTED'||prepared.recording)throw Error('Previous attempt not preserved/closed');
  await second.screenshot({path:'output/playwright/page-session-ready.jpg',type:'jpeg',quality:80,fullPage:true});
  return {scope:'NATIVE_NEW_PAGE_SAVES_AND_REBUILDS_NOT_DRIVING_ACCEPTANCE',first:{id:first.presentation.id,page:first.presentation.page_id},second:{id:prepared.presentation.id,page:prepared.presentation.page_id,condition:prepared.presentation.prepared_condition_id,seed:prepared.presentation.seed,actual:prepared.population.actual},previous:{status:run.status,reason:run.reason,distance_m:run.distance_m,collisions:run.collisions},loading,idleMediaRequests:idleRequests.length,errors,failures};
 }finally{await context.close();}
}
