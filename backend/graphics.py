"""Four camera/render presets backed by CARLA's two native quality levels."""
PRESETS={
    'LOW':{'quality':'Low','resolution':'1280x720','rgb':'640x360','postprocess':False,'bloom':0.},
    'BALANCED':{'quality':'Low','resolution':'1600x900','rgb':'800x450','postprocess':False,'bloom':0.},
    'HIGH':{'quality':'Epic','resolution':'1280x720','rgb':'800x450','postprocess':True,'bloom':.15},
    'ULTRA':{'quality':'Epic','resolution':'1920x1080','rgb':'1280x720','postprocess':True,'bloom':.5}}

def camera(preset):
    p=PRESETS[preset]
    return {'camera_resolution':p['rgb'],'camera_postprocess':p['postprocess'],
            'camera_motion_blur':0.,'camera_bloom':p['bloom']}
