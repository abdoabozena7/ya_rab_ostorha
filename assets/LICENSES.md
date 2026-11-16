# 3D assets

The downloaded models are released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/):

- `models/vehicles/`: [Car Kit 3.1](https://kenney.nl/assets/car-kit)
- `models/buildings/`: [City Kit (Commercial) 2.1](https://kenney.nl/assets/city-kit-commercial)
- `models/props/`: [City Kit (Roads) 2.1](https://kenney.nl/assets/city-kit-roads)
- `models/pedestrians/`: [Blocky Characters 2.0](https://kenney.nl/assets/blocky-characters)
- `models/tuktuks/auto-rickshaw.glb`: [Auto Rickshaw by 3DAssets.dev](https://3dassets.dev/assets/indian-bazaar-street-and-temple-auto-rickshaw-51b91c47)
- `models/tuktuks/street-food-tuktuk.glb`: [Street Food Tuk Tuk by 3DAssets.dev](https://3dassets.dev/assets/street-food-market-and-food-trucks-street-food-tuk-tuk-a9641f44)

Keep each Kenney folder's texture alongside its GLB files when editing or replacing models. The 3DAssets.dev GLBs have embedded textures. Blender can import every GLB here for geometry and material changes. `src/simulation/traffic.js` also contains a fallback tuk-tuk assembled from separate editable meshes.

## Visual polish additions

The complete current credit record, including the CC BY 3.0 Motorcycle and Van by Poly by Google, is in [public/assets/ATTRIBUTION.md](../public/assets/ATTRIBUTION.md). Preserve that record with redistributed assets.

## Recovered standalone Three.js assets

The 6 October saved game uses the following additional assets, restored with
their original notices. Existing native-era assets and credits above are retained.

- `models/vehicles/traffic-{saloon,hatchback,crossover,minivan}.glb`:
  [Road Car Showroom Lineup](https://3dassets.dev/packs/road-car-showroom-lineup)
  by 3DAssets.dev, CC0 1.0. The pack reports AI-assisted creation.
- `models/props/market-produce.glb`:
  [Fruit and Vegetable Stall](https://3dassets.dev/assets/indian-bazaar-street-and-temple-fruit-and-vegetable-st-280ccd20),
  3DAssets.dev, CC0 1.0.
- `models/props/roof-water-tank.glb`:
  [Rooftop Water Tank on Frame](https://3dassets.dev/assets/indian-bazaar-street-and-temple-rooftop-water-tank-c4ec1b54),
  3DAssets.dev, CC0 1.0.
- `models/people/{man-polo,man-jacket,woman-shirt,woman-jacket}.glb`:
  [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox),
  revision `0943055db6ec570bcef9f2c8b41c9e5467c808f9`, copyright (c) 2020
  Microsoft, [MIT notice](source/rocketbox/LICENSE.md). FBX characters and
  compatible idle/walk/run clips were converted to textured GLB rigs with
  measured stride lengths and no simulation movement baked into animation.
- Earlier `models/people/male-*.glb` and `female-*.glb`:
  [Quaternius Animated Men](https://quaternius.com/packs/animatedmen.html) and
  [Animated Women](https://quaternius.com/packs/animatedwomen.html), CC0 1.0;
  retained historical assets, not the current pedestrian catalog.
- `models/vehicles/player-concept.glb`:
  [Khronos Car Concept](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept),
  revision `c6a6bd13ab2b3c685c7903d03561b8a9392f38b8`,
  [CC BY 4.0 notice](source/car-concept/LICENSE.md). The recovered export script
  removes the emblem and plate meshes; the source license excludes trademarks.
- `lighting/urban_alley_01_1k.hdr`:
  [Urban Alley 01](https://polyhaven.com/a/urban_alley_01) by Andreas Mischok,
  Poly Haven, CC0. Used for reflections, not the visible background.
- `textures/roads/`: [Asphalt 07](https://polyhaven.com/a/asphalt_07) and
  [Concrete Pavement 02](https://polyhaven.com/a/concrete_pavement_02) by
  Charlotte Baglioni, Poly Haven, CC0; 1K diffuse and OpenGL normal maps.

`src/render/world-view.js` owns the recovered runtime transforms.
The recovered `tools/setup_*.py` and export tools retain the pinned asset
sources and conversions. Original model weights and large editable/source
texture packs are not restored by the default workflow.
