import { PLACES, findPlaceInText } from '../simulation/places.js?v=drive-final';

export function mountPhone(onDestination) {
  const toggle = document.getElementById('phoneToggleBtn');
  const panel = document.getElementById('inGamePhone');
  const input = document.getElementById('destinationInput');
  const status = document.getElementById('phoneStatus');
  document.getElementById('phonePlaces').textContent = PLACES.map((place) => place.name).join(' • ');

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) input.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });
  document.getElementById('destinationForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const place = findPlaceInText(input.value);
    if (!place) {
      status.textContent = 'مش لاقي المكان. اختار اسم من الأماكن المكتوبة.';
      return;
    }
    onDestination(place);
    status.textContent = `تمام، رايح ${place.name}.`;
    input.value = '';
  });
}
