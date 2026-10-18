// Run through playwright-cli after verify_guided_mission_ui.js installs its isolated fixture.
async page=>{
  const checks=[],layouts=[];
  const welcome={connected:false,available:false,presentation:{status:'IDLE'},journey:{status:'IDLE'},mode:'DISCONNECTED',simulatorStop:{available:true,status:'STOPPED'},simulatorStart:{status:'IDLE',available:true}};
  const fixture=async(patch,screen)=>{await page.evaluate(patch=>window.setMissionFixture(patch),patch);await page.waitForFunction(screen=>document.body.dataset.mission===screen,screen);};
  await fixture(welcome,'welcome');
  const theme=await page.evaluate(async()=>{
    await Promise.all([document.fonts.load('16px Outfit'),document.fonts.load('32px "Reenie Beanie"')]);
    const body=getComputedStyle(document.body),grain=getComputedStyle(document.body,'::after');
    return {font:body.fontFamily,background:body.backgroundColor,text:body.color,
      fontsLoaded:document.fonts.check('16px Outfit')&&document.fonts.check('32px "Reenie Beanie"'),
      grain:{opacity:grain.opacity,blend:grain.mixBlendMode,pointerEvents:grain.pointerEvents,frequency:grain.backgroundImage.includes('.65')},
      fontRequests:performance.getEntriesByType('resource').filter(e=>/\.(ttf|woff2?)(\?|$)/.test(e.name)).map(e=>e.name)};
  });
  if(!theme.fontsLoaded||!theme.font.startsWith('Outfit')||theme.background!=='rgb(253, 252, 248)'||theme.text!=='rgb(41, 37, 36)')throw Error('Theme / local fonts missing: '+JSON.stringify(theme));
  if(theme.grain.opacity!=='0.35'||theme.grain.blend!=='overlay'||theme.grain.pointerEvents!=='none'||!theme.grain.frequency)throw Error('Paper grain configuration missing');
  if(theme.fontRequests.some(url=>new URL(url).origin!=='http://127.0.0.1:8016'))throw Error('External font request');
  checks.push('Requested palette, both local fonts and noninteractive 35% SVG grain');
  for(const [width,height] of [[1440,1000],[1280,720],[390,740],[320,640]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));
    await page.getByRole('button',{name:'Start simulation',exact:true}).waitFor({state:'visible'});
    const m=await page.evaluate(()=>{
      const action=document.getElementById('drivePrimaryAction').getBoundingClientRect(),logo=document.querySelector('.brand-mark').getBoundingClientRect(),nav=document.querySelector('.app-header').getBoundingClientRect();
      return {screen:'welcome',width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,actionBottom:action.bottom,logoWidth:logo.width,navWidth:nav.width};
    });
    if(m.scrollWidth>width+1||m.actionBottom>height||m.logoWidth<25||m.navWidth>width-31)throw Error('Welcome layout: '+JSON.stringify(m));
    layouts.push(m);
    if(width===1440||width===390)await page.screenshot({path:`output/playwright/softly-welcome-${width}.png`,fullPage:true});
  }
  checks.push('Welcome action, coral logo and inset navigation fit desktop and 320px / 390px mobile');
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>{document.body.style.zoom='2';scrollTo(0,0);});
  await page.getByRole('button',{name:'Start simulation',exact:true}).scrollIntoViewIfNeeded();
  const zoom=await page.evaluate(()=>({zoom:getComputedStyle(document.body).zoom,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bottom:document.getElementById('drivePrimaryAction').getBoundingClientRect().bottom,height:innerHeight}));
  if(zoom.scrollWidth>zoom.width+1||zoom.bottom>zoom.height+1)throw Error('200% CSS zoom reflow: '+JSON.stringify(zoom));
  layouts.push(zoom);await page.evaluate(()=>document.body.style.removeProperty('zoom'));
  checks.push('200% CSS zoom reflow keeps the action reachable without horizontal overflow');
  await page.setViewportSize({width:390,height:740});
  const faq=page.getByRole('button',{name:'Does protection prevent every contact?',exact:true});
  await faq.scrollIntoViewIfNeeded();await faq.click();
  await page.waitForFunction(()=>document.querySelector('#missionAnswer1').getBoundingClientRect().height>70);
  if(await faq.getAttribute('aria-expanded')!=='true')throw Error('FAQ did not open');
  await page.screenshot({path:'output/playwright/softly-faq-mobile.png',fullPage:true});
  await faq.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#missionAnswer1').inert&&document.querySelector('#missionAnswer1').getBoundingClientRect().height<1);
  checks.push('FAQ expands, explains actual protection limits and closes with Enter');
  await page.emulateMedia({reducedMotion:'reduce'});
  const motion=await page.evaluate(()=>({blob:getComputedStyle(document.querySelector('#missionAtmosphere i')).animationName,reveal:getComputedStyle(document.getElementById('missionGuide')).transitionDuration,opacity:getComputedStyle(document.getElementById('missionGuide')).opacity}));
  if(motion.blob!=='none'||motion.reveal!=='0s'||motion.opacity!=='1')throw Error('Reduced motion: '+JSON.stringify(motion));
  checks.push('Reduced motion removes floating / reveal animations and leaves content visible');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));
  await fixture({connected:true,available:true,mode:'PAUSED',simulatorStop:{available:true,status:'IDLE'},simulatorStart:{status:'READY',available:true}},'choose');
  await page.getByRole('radio',{name:'The solution Protected · RULE protection',exact:true}).check();
  if(!await page.getByRole('button',{name:'Start the protected drive',exact:true}).isVisible())throw Error('Protected choice action missing');
  await page.screenshot({path:'output/playwright/softly-choice-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  await page.locator('#cockpitDetails').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
  await page.screenshot({path:'output/playwright/softly-menu-desktop.png',fullPage:true});
  await page.keyboard.press('Escape');
  if(!await page.getByRole('button',{name:'Menu',exact:true}).evaluate(e=>e===document.activeElement))throw Error('Menu focus');
  checks.push('Pale drive choices retain radio semantics and Menu restores keyboard focus');
  const d={guided:true,id:'softly-fixture',status:'DRIVING',arm:1,modes:['NORMAL','ROBOSPHERE'],pair_id:'softly-pair',setup:{scene:'DENSE_CHAOS'}};
  await fixture({presentation:d,journey:{status:'RUNNING',presentation_id:d.id},mode:'AUTOMATIC'},'driving');
  const quiet=await page.evaluate(()=>({blobs:getComputedStyle(document.getElementById('missionAtmosphere')).display,camera:getComputedStyle(document.getElementById('authoritativeCamera')).objectFit}));
  if(quiet.blobs!=='none'||quiet.camera!=='contain')throw Error('Live view configuration: '+JSON.stringify(quiet));
  await page.setViewportSize({width:390,height:740});await page.getByRole('button',{name:'End drive & compare',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'output/playwright/softly-drive-mobile.png',fullPage:true});
  checks.push('Live view removes floating blobs and contains the entire camera frame');
  await page.getByRole('button',{name:'Emergency stop',exact:true}).click();
  const emergency=(await page.evaluate(()=>window.missionEvidence())).commands;
  if(!emergency.some(c=>c.type==='emergency_stop'))throw Error('Emergency command missing: '+JSON.stringify(emergency.slice(-4)));
  checks.push('Visible emergency action dispatches the real emergency command to the isolated transport');
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));
  const normal={status:'COLLISION',reason:'collision',distance_m:71.8,collisions:1,duration_s:14},protectedRun={status:'SHORTENED',reason:'guided_shortened',distance_m:19.4,collisions:0,duration_s:6};
  await fixture({mode:'PAUSED',journey:{status:'PAUSED'},presentation:{...d,status:'RESULTS'},journeyComparison:{version:4,pair_id:d.pair_id,conditions_match:true,runs:{NORMAL:normal,ROBOSPHERE:protectedRun}}},'comparison');
  await page.getByRole('button',{name:'Finish',exact:true}).waitFor({state:'visible'});
  await page.screenshot({path:'output/playwright/softly-comparison-desktop.png',fullPage:true});
  const evidence=await page.evaluate(()=>window.missionEvidence());
  if(evidence.errors.length)throw Error('Browser exceptions: '+evidence.errors.join(';'));
  return {scope:evidence.scope,checks,theme,layouts,motion,errors:evidence.errors,notes:['Camera images and metrics in these screenshots are isolated fixtures, not a new native drive.','CSS zoom is a reflow probe; browser chrome zoom and OS scaling were not automated.']};
}
