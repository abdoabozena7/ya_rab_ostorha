// Apply the saved dashboard appearance before the stylesheet paints.
(() => {
  const storageKey = 'dashboard-appearance';
  let appearance = 'light';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light') appearance = saved;
  } catch { /* Storage can be unavailable. */ }
  document.documentElement.dataset.appearance = appearance;
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('dashboardAppearance');
    select.value = appearance;
    select.addEventListener('change', () => {
      appearance = select.value === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.appearance = appearance;
      try { localStorage.setItem(storageKey, appearance); } catch { /* Appearance still works for this page. */ }
    });
  });
})();
