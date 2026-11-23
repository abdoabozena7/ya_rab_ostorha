export async function clickCityTool(page, id, action = "click") {
  const target = page.locator(`#${id}`);
  const tools = page.locator("#cityTools:not([open]) > summary");
  if (await target.isHidden() && await tools.isVisible()) await tools[action]();
  return target[action]();
}
