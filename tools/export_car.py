"""Run with Blender 4.5 --background --python tools/export_car.py."""
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".cache/models/car-concept/CarConcept-standard.glb"
OUTPUT = ROOT / "assets/models/vehicles/player-concept.glb"
EDITABLE = ROOT / "assets/source/car-concept/player-concept.blend"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
for name in ("InteriorSteeringEmblem", "License Plate"):
    part = bpy.data.objects.get(name)
    if part:
        bpy.data.objects.remove(part, do_unlink=True)
for obj in bpy.data.objects:
    rename = {
        "WheelFrontL": "wheel-front-left",
        "WheelFrontR": "wheel-front-right",
        "WheelRearL": "wheel-rear-left",
        "WheelRearR": "wheel-rear-right",
    }
    if obj.name in rename:
        obj.name = rename[obj.name]

def wheel_part(obj):
    current = obj
    while current:
        if current.name.startswith("wheel-"):
            return True
        current = current.parent
    return False


# The source has roughly 80 separate static body meshes. Combine them before
# export so the street scene does not issue a draw call for every tiny trim.
body = [obj for obj in bpy.data.objects if obj.type == "MESH" and not wheel_part(obj)]
bpy.ops.object.select_all(action="DESELECT")
for obj in body:
    obj.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects.get("BodyUnderside") or body[0]
bpy.ops.object.join()
bpy.context.view_layer.objects.active.name = "body-shell"
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.outliner.orphans_purge(do_recursive=True)

bpy.ops.file.pack_all()
EDITABLE.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(EDITABLE), compress=True)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    export_yup=True,
    export_materials="EXPORT",
    export_animations=False,
)
print(f"Exported {OUTPUT}")
