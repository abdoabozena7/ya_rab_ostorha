// The classic bundle avoids unreliable module fetches in the embedded browser.
// Surface startup failures instead of leaving apparently usable controls.
window.addEventListener('error',event => {
  const script=event.target;
  if (!String(event.filename||script?.src||'').includes('dashboard.bundle.js')) return;
  const status=document.getElementById('operationStatus');
  if (!status) return;
  status.textContent='Dashboard failed to start. Reload the page. '+(event.message||'Interface failed to load');
  status.setAttribute('role','alert');
},true);
