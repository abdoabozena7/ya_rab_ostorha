// Real-time browser verification of scripted illustrations, with isolated native transport.
async page=>{
 const checks=[],samples={};
 await page.setViewportSize({width:1440,height:1000});
 await page.evaluate(()=>window.setMissionFixture({connected:true,available:true,mode:'PAUSED',presentation:{status:'IDLE'},journey:{status:'IDLE'},simulatorStop:{available:true,status:'IDLE'},simulatorStart:{status:'READY',available:true}}));
 await page.waitForFunction(()=>document.body.dataset.mission==='choose');
 const preview=page.locator('#missionPreview');
 if(await preview.locator('button').count())throw Error('Preview toolbar remains');
 const sample=()=>preview.evaluate(e=>({phase:e.dataset.previewPhase,car:e.querySelector('.demo-car-position').getAttribute('transform'),person:e.querySelector('.demo-person').getAttribute('transform'),sensing:getComputedStyle(e.querySelector('.demo-sensing')).display!=='none',prediction:getComputedStyle(e.querySelector('.demo-prediction')).display!=='none'}));
 const phase=value=>page.waitForFunction(value=>document.getElementById('missionPreview').dataset.previewPhase===value,value);
 const select=async mode=>{await page.locator('[name=firstDrive][value='+mode+']').click();await preview.scrollIntoViewIfNeeded();};
 await select('NORMAL');samples.normalSeen=await sample();if(!samples.normalSeen.sensing)throw Error('Normal cannot see person');
 await phase('late-detection');samples.reactive=await sample();
 await phase('contact');samples.contact=await sample();
 await preview.screenshot({path:'output/playwright/crossing-contact.png'});
 checks.push('Normal sees person from the pavement, moves, brakes reactively and contacts at speed');
 await select('ROBOSPHERE');samples.protectedSeen=await sample();if(!samples.protectedSeen.sensing)throw Error('Protected sensor missing');
 await phase('predicting');samples.prediction=await sample();if(samples.prediction.person!=='translate(780 281.00)')throw Error('Prediction starts after crossing');
 await phase('stopped');samples.stopped=await sample();
 await preview.getByText('Stopped for a predicted pedestrian crossing.',{exact:true}).waitFor({state:'visible'});
 await preview.screenshot({path:'output/playwright/crossing-stopped.png'});
 await phase('safe');samples.safe=await sample();if(samples.stopped.car!==samples.safe.car)throw Error('Car moved before person cleared');
 await preview.screenshot({path:'output/playwright/crossing-safe.png'});
 await phase('replaying');await phase('approaching');checks.push('Early prediction stops the car, allows crossing and automatically loops without controls');
 await page.setViewportSize({width:390,height:740});await select('ROBOSPHERE');await phase('stopped');
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
 await preview.screenshot({path:'output/playwright/crossing-mobile.png'});
 checks.push('Mobile preserves the drawing and full explanation');
 await page.emulateMedia({reducedMotion:'reduce'});const paused=await sample();await page.waitForTimeout(250);if((await sample()).car!==paused.car)throw Error('Reduced motion did not pause');
 await page.emulateMedia({reducedMotion:'no-preference'});
 const d={guided:true,id:'crossing-fixture',status:'DRIVING',arm:0,modes:['NORMAL','ROBOSPHERE'],pair_id:'crossing-pair'};
 await page.evaluate(d=>window.setMissionFixture({presentation:d,journey:{status:'RUNNING',presentation_id:d.id},mode:'AUTOMATIC'}),d);
 await page.waitForFunction(()=>document.body.dataset.mission==='driving');const hidden=await sample();await page.waitForTimeout(250);if(await preview.isVisible()||(await sample()).car!==hidden.car)throw Error('Hidden drawing still running');
 checks.push('Reduced motion and live-camera handoff stop illustration movement');
 await page.evaluate(()=>window.setMissionFixture({presentation:{status:'IDLE'},journey:{status:'IDLE'},mode:'PAUSED'}));
 await page.waitForFunction(()=>document.body.dataset.mission==='choose');
 const evidence=await page.evaluate(()=>window.missionEvidence());if(evidence.errors.length)throw Error(evidence.errors.join(';'));
 return {scope:evidence.scope,checks,samples,errors:evidence.errors};
}
