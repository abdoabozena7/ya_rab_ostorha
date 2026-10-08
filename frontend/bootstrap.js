// The classic bundle avoids unreliable module fetches in the embedded browser.
// Surface startup failures instead of leaving apparently usable controls.
window.addEventListener('error',event => {
  const script=event.target;
  if (!String(event.filename||script?.src||'').includes('dashboard.bundle.js')) return;
  const status=document.getElementById('operationStatus');
  if (!status) return;
  status.textContent='تعذر تشغيل الداشبورد. أعد تحميل الصفحة. '+(event.message||'تعذر تحميل الواجهة');
  status.setAttribute('role','alert');
},true);
