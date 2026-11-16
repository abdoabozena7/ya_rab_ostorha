"""Run: blender --background asset.blend --python tools/export_traffic.py -- name.

Example name: traffic-saloon. This intentionally replaces that runtime GLB.
"""

from pathlib import Path
import sys
import bpy


ROOT = Path(__file__).resolve().parents[1]
VALID = {"traffic-saloon", "traffic-hatchback", "traffic-crossover", "traffic-minivan"}
name = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else ""
if name not in VALID:
    raise ValueError(f"Choose one of: {', '.join(sorted(VALID))}")
source = (ROOT / "assets" / "source" / "traffic" / f"{name}.blend").resolve()
if Path(bpy.data.filepath).resolve() != source:
    raise ValueError(f"Open {source} before exporting")
destination = ROOT / "assets" / "models" / "vehicles" / f"{name}.glb"
bpy.ops.export_scene.gltf(
    filepath=str(destination),
    export_format="GLB",
    export_yup=True,
    export_materials="EXPORT",
    export_animations=False,
)
print(f"Exported {destination}")
