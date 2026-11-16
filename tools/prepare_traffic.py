"""Run with Blender 4.5 --background --python tools/prepare_traffic.py.

Creates one editable Blender project for each imported road car. The runtime
GLBs remain the exact pinned downloads until a model is intentionally exported.
"""

from pathlib import Path
import bpy


ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "assets" / "models" / "vehicles"
OUTPUT = ROOT / "assets" / "source" / "traffic"
OUTPUT.mkdir(parents=True, exist_ok=True)

for name in ("traffic-saloon", "traffic-hatchback", "traffic-crossover", "traffic-minivan"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(INPUT / f"{name}.glb"))
    bpy.context.scene["source_asset"] = name
    bpy.context.scene["license"] = "CC0 1.0 / 3DAssets.dev Road Car Showroom Lineup"
    bpy.ops.file.pack_all()
    destination = OUTPUT / f"{name}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(destination), compress=True)
    print(f"Saved editable {destination}")
