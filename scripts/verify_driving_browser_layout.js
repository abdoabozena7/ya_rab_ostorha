async page=>{
  const checks=[];
  for(const {width,height} of [{width:1920,height:911},{width:1536,height:728},{width:1280,height:720},{width:390,height:740}]){
    await page.setViewportSize({width,height});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForTimeout(200);
    const measurement=await page.evaluate(()=>{
      const box=id=>{const rect=document.getElementById(id).getBoundingClientRect();return{left:rect.left,
        top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};};
      return {camera:box('frontCameraView'),map:box('unifiedMap'),viewport:innerWidth,
        document_width:document.documentElement.scrollWidth,document_height:document.scrollingElement.scrollHeight,
        viewport_height:innerHeight,image_fit:getComputedStyle(document.getElementById('authoritativeCamera')).objectFit,
        image_loaded:document.getElementById('authoritativeCamera').naturalWidth>0};
    });
    if(measurement.camera.height<250)throw new Error('Camera collapsed at viewport '+width);
    if(measurement.map.top<measurement.camera.top-1||measurement.map.bottom>measurement.camera.bottom+1)
      throw new Error('Circular map is vertically clipped at viewport '+width);
    if(measurement.document_width>width+1)throw new Error('Horizontal overflow at viewport '+width);
    if(measurement.image_fit!=='contain')throw new Error('Camera image may be cropped at viewport '+width);
    if(!measurement.image_loaded)throw new Error('The saved camera image has not loaded at viewport '+width);
    if(width===1920)await page.screenshot({path:'output/playwright/start-scroll-1920-top.png'});
    await page.mouse.move(width/2,height-40);
    await page.mouse.wheel(0,10000);
    await page.waitForTimeout(200);
    const scrolled=await page.evaluate(()=>({scroll_y:scrollY,
      camera_bottom:document.getElementById('frontCameraView').getBoundingClientRect().bottom,
      primary:document.getElementById('drivePrimaryAction').getBoundingClientRect().toJSON()}));
    if(measurement.document_height>height+1&&scrolled.scroll_y<1)throw new Error('Mouse wheel cannot scroll the page at viewport '+width);
    if(scrolled.camera_bottom>height+1)throw new Error('Camera bottom remains unreachable at viewport '+width);
    if(scrolled.primary.top<0||scrolled.primary.bottom>height)throw new Error('Main action is not reachable while scrolling at viewport '+width);
    if(width===1920)await page.screenshot({path:'output/playwright/start-scroll-1920-bottom.png'});
    checks.push({width,height,...measurement,scrolled});
    await page.screenshot({path:'output/playwright/start-scroll-layout-'+width+'x'+height+'.png',fullPage:true});
  }
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.setViewportSize({width:1440,height:1000});
  return {passed:true,native_mutations:0,checks};
}
