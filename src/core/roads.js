// Shared road layout for rendering, routing and whole-body constraints.
// Center lines use 10 m increments so A* nodes meet at intersections.
const INNER_X = [-100, -70, -20, 20, 50, 100];
const INNER_Z = [-100, -60, -20, 20, 70, 100];

export function roadLayout(extent = 100) {
  const outer = [];
  for (let n = 140; n <= extent; n += 40) outer.push(-n, n);
  const xs = [...new Set([...INNER_X, ...outer])].sort((a, b) => a - b);
  const zs = [...new Set([...INNER_Z, ...outer])].sort((a, b) => a - b);
  const roads = [
    ...xs.flatMap((x) =>
      (x === -70
        ? [
            { min: -extent, max: -20 },
            { min: 20, max: extent },
          ]
        : [{ min: -extent, max: extent }]
      ).map((span) => ({
        axis: "z",
        fixed: x,
        width: x === -70 ? 8 : 10,
        ...span,
      })),
    ),
    ...zs.flatMap((z) =>
      (z === -60
        ? [
            { min: -extent, max: -20 },
            { min: 20, max: extent },
          ]
        : z === 70
          ? [
              { min: -extent, max: 20 },
              { min: 50, max: extent },
            ]
          : [{ min: -extent, max: extent }]
      ).map((span) => ({
        axis: "x",
        fixed: z,
        width: z === 70 ? 8 : 10,
        ...span,
      })),
    ),
  ];
  if (extent >= 100)
    roads.push(
      {
        axis: "x",
        fixed: -80,
        min: -100,
        max: -20,
        width: 8,
        sideStreet: true,
      },
      { axis: "x", fixed: 40, min: 20, max: 100, width: 8, sideStreet: true },
      { axis: "z", fixed: -40, min: -60, max: 20, width: 8, sideStreet: true },
      // This uneven local link breaks a long regular block. It is a real
      // two-way road in navigation and collision, with no lane paint.
      { axis: "z", fixed: 75, min: -60, max: 40, width: 8, sideStreet: true },
    );
  return { xs, zs, roads };
}
