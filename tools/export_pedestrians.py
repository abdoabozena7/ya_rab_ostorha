"""Run with Blender 4.5 --background --disable-autoexec --python this_file.

The editable CC0 source scenes are kept in assets/source/pedestrians.
Only locomotion clips are shipped to the browser. No scene scripts are run.
"""
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets/models/people"
OUTPUT.mkdir(parents=True, exist_ok=True)
for source in sorted((ROOT / "assets/source/pedestrians").glob("*.blend")):
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            obj.data.validate(clean_customdata=False)
        if obj.animation_data:
            obj.animation_data.action = None
            for track in list(obj.animation_data.nla_tracks):
                obj.animation_data.nla_tracks.remove(track)
    for action in list(bpy.data.actions):
        name = action.name.lower().split("_")[-1]
        if name not in {"idle", "walk", "run"}:
            bpy.data.actions.remove(action, do_unlink=True)
        else:
            action.name = name
    for armature in [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]:
        armature.animation_data_create()
        armature.animation_data.action = bpy.data.actions.get("idle")
    # Convert the original Blender Internal diffuse materials to glTF PBR.
    for material in bpy.data.materials:
        color = tuple(material.diffuse_color)
        material.use_nodes = True
        material.node_tree.nodes.clear()
        shader = material.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
        output = material.node_tree.nodes.new('ShaderNodeOutputMaterial')
        material.node_tree.links.new(shader.outputs['BSDF'], output.inputs['Surface'])
        shader.inputs["Base Color"].default_value = color
        shader.inputs["Roughness"].default_value = 0.85
        shader.inputs["Metallic"].default_value = 0
    bpy.context.scene.frame_set(0)
    bpy.ops.export_scene.gltf(filepath=str(OUTPUT / f"{source.stem}.glb"),
        export_format="GLB", export_animations=True, export_animation_mode="ACTIONS",
        export_yup=True, export_materials="EXPORT", export_skins=True)
    print(f"EXPORTED {source.stem}", flush=True)
