// Apply the saved dashboard appearance before the stylesheet paints.
(() => {
  const storageKey = 'dashboard-appearance-v2';
  // Migrate the old dark cockpit preference to the approved light design.
  let appearance = 'light';
  document.documentElement.dataset.appearance = appearance;
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('dashboardAppearance');
    select.value = appearance;
    select.addEventListener('change', () => {
      appearance = 'light';
      document.documentElement.dataset.appearance = appearance;
      try { localStorage.setItem(storageKey, appearance); } catch { /* Appearance still works for this page. */ }
    });
  });
})();
