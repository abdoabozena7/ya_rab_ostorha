"""Blender 4.5: import MIT Rocketbox FBX, bake compatible motion, export GLB.

Run after setup_people.py. Source FBX/TGA stays untouched. Editable Blender
scenes contain the converted materials and the baked idle/walk/run actions.
"""
from pathlib import Path
import math
import bpy

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'assets/source/rocketbox'
OUTPUT=ROOT/'assets/models/people'
CACHE=ROOT/'.cache/asset-textures/rocketbox'
NAMES={'Male_Adult_01':'man-polo','Male_Adult_05':'man-jacket','Female_Adult_01':'woman-shirt','Female_Adult_04':'woman-jacket'}
OUTPUT.mkdir(parents=True,exist_ok=True)
CACHE.mkdir(parents=True,exist_ok=True)
(SOURCE/'editable').mkdir(exist_ok=True)

def texture(path,normal=False):
    image=bpy.data.images.load(str(path),check_existing=True)
    if max(image.size)>1024:image.scale(1024,1024)
    image.file_format='PNG' if normal or 'opacity' in path.name else 'JPEG'
    image.filepath_raw=str(CACHE/(path.stem+('.png' if image.file_format=='PNG' else '.jpg')))
    image.save()
    if normal:image.colorspace_settings.name='Non-Color'
    image.pack()
    return image

for source_name,output_name in NAMES.items():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    folder=SOURCE/'Assets/Avatars/Adults'/source_name
    bpy.ops.import_scene.fbx(filepath=str(folder/'Export'/f'{source_name}.fbx'),use_anim=False)
    avatar=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
    avatar.name='Person'
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    for obj in list(bpy.context.scene.objects):
        if obj!=avatar and obj not in meshes:bpy.data.objects.remove(obj,do_unlink=True)
    for material in bpy.data.materials:
        material.use_nodes=True;nodes=material.node_tree.nodes;nodes.clear()
        shader=nodes.new('ShaderNodeBsdfPrincipled');out=nodes.new('ShaderNodeOutputMaterial')
        links=material.node_tree.links;links.new(shader.outputs['BSDF'],out.inputs['Surface'])
        shader.inputs['Roughness'].default_value=0.85
        shader.inputs['Metallic'].default_value=0
        shader.inputs['Specular IOR Level'].default_value=0.25
        color_path=folder/'Textures'/(material.name+'_color.tga')
        if not color_path.exists():raise FileNotFoundError(color_path)
        node=nodes.new('ShaderNodeTexImage');node.image=texture(color_path)
        links.new(node.outputs['Color'],shader.inputs['Base Color'])
        if 'opacity' in material.name:
            links.new(node.outputs['Alpha'],shader.inputs['Alpha'])
            material.surface_render_method='DITHERED'
            material.use_backface_culling=False
        normal_path=folder/'Textures'/(material.name+'_normal.tga')
        if normal_path.exists():
            node=nodes.new('ShaderNodeTexImage');node.image=texture(normal_path,True)
            normal=nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=0.55
            links.new(node.outputs['Color'],normal.inputs['Color']);links.new(normal.outputs['Normal'],shader.inputs['Normal'])
    actions=[];strides={}
    for clip in ['idle','walk','run']:
        before=set(bpy.data.objects)
        gender='f' if source_name.startswith('Female') else 'm'
        subdir='all_animations_max_motextr_static' if clip=='idle' else 'all_animations_max_motextr_xy'
        suffix='idle_neutral_01' if clip=='idle' else clip+'_neutral'
        path=SOURCE/'Assets/Animations'/subdir/(gender+'_'+suffix+'.max.fbx')
        bpy.ops.import_scene.fbx(filepath=str(path),use_anim=True)
        imported=set(bpy.data.objects)-before
        source=next(o for o in imported if o.type=='ARMATURE')
        action=source.animation_data.action
        start,end=map(round,action.frame_range)
        bpy.context.scene.frame_set(start);first=source.matrix_world.translation.copy()
        bpy.context.scene.frame_set(end);last=source.matrix_world.translation.copy()
        strides[clip]=math.hypot(last.x-first.x,last.y-first.y)
        # Extract translation from the animation. World.step owns movement;
        # the animation retains the captured vertical bob and body rotation.
        for curve in action.fcurves:
            if curve.data_path=='location' and curve.array_index in (0,1):
                for key in curve.keyframe_points:key.co[1]=0;key.handle_left[1]=0;key.handle_right[1]=0
        avatar.animation_data_clear()
        for bone in avatar.pose.bones:
            bone.rotation_mode='QUATERNION'
            bone.location=(0,0,0);bone.rotation_quaternion=(1,0,0,0);bone.scale=(1,1,1)
            if bone.name not in source.pose.bones:continue
            constraint=bone.constraints.new('COPY_ROTATION');constraint.target=source;constraint.subtarget=bone.name
            constraint.target_space='WORLD';constraint.owner_space='WORLD'
            if bone.parent is None:
                position=bone.constraints.new('COPY_LOCATION');position.target=source;position.subtarget=bone.name
                position.target_space='WORLD';position.owner_space='WORLD'
        bpy.ops.object.select_all(action='DESELECT');avatar.select_set(True);bpy.context.view_layer.objects.active=avatar
        bpy.ops.nla.bake(frame_start=start,frame_end=end,step=1,only_selected=False,visual_keying=True,clear_constraints=True,use_current_action=False,bake_types={'POSE'})
        baked=avatar.animation_data.action;baked.name=clip;baked.use_fake_user=True;actions.append(baked)
        for obj in imported:bpy.data.objects.remove(obj,do_unlink=True)
        for extra in list(bpy.data.actions):
            if extra not in actions:bpy.data.actions.remove(extra,do_unlink=True)
    avatar.animation_data.action=actions[0]
    bpy.context.scene.frame_set(1)
    bpy.context.scene['walkStride']=strides['walk']
    bpy.context.scene['runStride']=strides['run']
    bpy.context.scene['source']='Microsoft Rocketbox / MIT'
    bpy.data.orphans_purge(do_recursive=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'editable'/f'{output_name}.blend'),compress=True)
    bpy.ops.export_scene.gltf(filepath=str(OUTPUT/f'{output_name}.glb'),export_format='GLB',export_animations=True,export_animation_mode='ACTIONS',export_extras=True,export_yup=True,export_materials='EXPORT',export_skins=True)
    print('EXPORTED',output_name,strides,flush=True)
