async page=>{
  const checks=[];
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(200);
    const measurement=await page.evaluate(()=>{
      const box=id=>{const rect=document.getElementById(id).getBoundingClientRect();return{left:rect.left,
        top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};};
      return {camera:box('frontCameraView'),map:box('unifiedMap'),viewport:innerWidth,
        document_width:document.documentElement.scrollWidth};
    });
    if(measurement.camera.height<250)throw new Error('Camera collapsed at viewport '+width);
    if(measurement.map.top<measurement.camera.top-1||measurement.map.bottom>measurement.camera.bottom+1)
      throw new Error('Circular map is vertically clipped at viewport '+width);
    if(measurement.document_width>width+1)throw new Error('Horizontal overflow at viewport '+width);
    checks.push({width,...measurement});
    await page.screenshot({path:'output/playwright/driving-verification-layout-'+width+'.png',fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  return {passed:true,native_mutations:0,checks};
}
