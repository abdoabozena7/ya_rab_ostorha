# Asset attribution

Stage 1 reuses the repository's existing models; no new model files were downloaded.
Runtime files remain in `/assets/models/` until the later asset-manager migration.

| Asset / original filenames | Creator | Source | License | Used for |
| --- | --- | --- | --- | --- |
| Car Kit 3.1: `sedan.glb`, `taxi.glb`, `suv.glb`, `van.glb`, `ambulance.glb`; `Textures/colormap.png` | Kenney | https://kenney.nl/assets/car-kit | CC0 1.0 | Player sedan and cloned traffic vehicles |
| City Kit Commercial 2.1: `building-a.glb`, `building-c.glb`, `building-h.glb`, `building-skyscraper-a.glb`; `Textures/colormap.png` | Kenney | https://kenney.nl/assets/city-kit-commercial | CC0 1.0 | Existing city buildings |
| City Kit Roads 2.1: `light-curved.glb`; `Textures/colormap.png` | Kenney | https://kenney.nl/assets/city-kit-roads | CC0 1.0, per existing repository attribution | Street lights |
| Blocky Characters 2.0: `character-a.glb` through `character-f.glb`; `Textures/texture-a.png` through `texture-f.png` | Kenney | https://kenney.nl/assets/blocky-characters | CC0 1.0 | Animated pedestrians |
| `auto-rickshaw.glb` | 3DAssets.dev | https://3dassets.dev/assets/indian-bazaar-street-and-temple-auto-rickshaw-51b91c47 | CC0 1.0, per existing repository attribution; not reverified in Stage 1 | Existing tuk-tuk traffic |
| `street-food-tuktuk.glb` | 3DAssets.dev | https://3dassets.dev/assets/street-food-market-and-food-trucks-street-food-tuk-tuk-a9641f44 | CC0 1.0, per existing repository attribution; not reverified in Stage 1 | Existing tuk-tuk traffic |

The Car Kit, Commercial City Kit and Blocky Characters source pages were checked on 2026-09-27. See also the original record: [`assets/LICENSES.md`](../../assets/LICENSES.md).

For any subsequent download, record its creator, direct source, verified license, original filenames, and use here before importing it. No Blender is required.

## Visual polish imports — 2026-09-28

The following source licenses were checked before downloading. Exact selected filenames and uses are recorded below as imports are selected.

- Quaternius, **Car** (Poly Pizza ID `unqqkULtRU`): https://poly.pizza/m/unqqkULtRU — CC0 1.0; downloaded GLB for player/traffic evaluation.
- Kenney, **Car Kit 3.1**: https://kenney.nl/assets/car-kit — CC0 1.0; archive `kenney_car-kit.zip`; additional vehicle silhouettes.
- Kenney, **Nature Kit**: https://kenney.nl/assets/nature-kit — CC0 1.0; palm/tree/plant models.
- Kenney, **City Kit Roads**: https://kenney.nl/assets/city-kit-roads — CC0 1.0; bins, barriers and road props.
- Kenney, **City Kit Commercial**: https://kenney.nl/assets/city-kit-commercial — CC0 1.0; additional facade variants.

### Selected original files

- car-kit: `sedan-sports.glb`, `hatchback-sports.glb`, `delivery.glb`, `delivery-flat.glb`, `truck-flat.glb`, `suv-luxury.glb`, `wheel-racing.glb`, `box.glb`, `cone.glb`; installed under `assets/models/vehicles/`.
- city-kit-commercial: `building-b.glb`, `building-d.glb`, `building-e.glb`, `building-f.glb`, `building-g.glb`, `building-i.glb`, `building-j.glb`, `building-k.glb`, `building-l.glb`, `low-detail-building-a.glb`, `low-detail-building-c.glb`, `low-detail-building-wide-a.glb`, `detail-awning.glb`, `detail-awning-wide.glb`, `detail-parasol-a.glb`; installed under `assets/models/buildings/`.
- city-kit-roads: `dumpster.glb`, `construction-cone.glb`, `construction-barrier.glb`, `electricity-pole.glb`, `road-sign-stop.glb`, `light-square.glb`; installed under `assets/models/props/`.
- nature-kit: `tree_palmDetailedTall.glb`, `tree_palmBend.glb`, `tree_default.glb`, `plant_bushLarge.glb`; installed under `assets/models/vegetation/`.
- Quaternius original download: `Car by Quaternius - unqqkULtRU.glb`, renamed `quaternius-sedan.glb`. Used for the player vehicle. Paint/glass materials customized; wheel pivots and plate added in code. Source geometry retained.

### Poly by Google additions

- **Motorcycle** by **Poly by Google**, https://poly.pizza/m/dse64pqMKAR, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Original `Motorcycle by Poly by Google - dse64pqMKAR.glb`, installed as `assets/models/vehicles/motorcycle.glb`. Rescaled, paint adjusted, Kenney rider added.
- **Van** by **Poly by Google**, https://poly.pizza/m/aT_24cDaW1a, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Original `Van by Poly by Google - aT_24cDaW1a.glb`, installed as `assets/models/vehicles/microbus.glb`. Rescaled, recolored with blue stripe, Arabic destination sign added.

Licenses verified on the individual model pages on 2026-09-28. Attribution and modification notices must travel with redistributed assets.

- Kenney **Furniture Kit 1.0**, https://kenney.nl/assets/furniture-kit — CC0 1.0 (verified 2026-09-28). Original `bench.glb`, `chair.glb`, `tableRound.glb`, `trashcan.glb`, `pottedPlant.glb`, extracted from `kenney_furniture-kit.zip` into `assets/models/furniture/`; reused as cafe and sidewalk props.


## Player sedan — October 2026

The active player sedan is original procedural geometry in `src/render/detailed-sedan.js`, distributed under the project MIT license. It replaces the Quaternius sedan as the active player visual. The earlier GLB and its source credit remain in the repository. No vehicle brand or commercial model is represented.
