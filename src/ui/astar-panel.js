const element = (id) => document.getElementById(id);

export function updateAstarPanel({ routeVisible, path, waypointIdx, destination }) {
  const panel = element('astarPanel');
  if (!routeVisible || path.length < 2) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const index = Math.min(waypointIdx, path.length - 1);
  const rows = path.slice(index, index + 5).map((node, offset) => {
    const g = Number.isFinite(node.g) ? node.g : 0;
    const h = destination
      ? Math.abs(node.x - destination.position.x) + Math.abs(node.z - destination.position.z)
      : 0;
    return { index: index + offset, g, h, f: g + h };
  });
  const current = rows[0];
  const maxF = Math.max(1, ...rows.map(({ f }) => f));
  for (const [name, value] of [['F', current.f], ['G', current.g], ['H', current.h]]) {
    element(`aBar${name}`).style.width = `${Math.min(100, value / maxF * 100)}%`;
    element(`aVal${name}`).textContent = value.toFixed(1);
  }
  element('aNodeIdx').textContent = index;
  element('aPathLen').textContent = path.length;
  element('aRemain').textContent = Math.max(0, path.length - 1 - index);

  const body = element('astarTableBody');
  body.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.index === index) tr.className = 'current-wp';
    for (const value of [row.index === index ? `▶ ${row.index}` : row.index,
      row.g.toFixed(0), row.h.toFixed(0), row.f.toFixed(0)]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}
