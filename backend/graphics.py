"""Four camera/render presets backed by CARLA's two native quality levels."""
import configparser
import io
from pathlib import Path

PRESETS={
    'LOW':{'quality':'Low','resolution':'1280x720','rgb':'640x360','postprocess':False,'bloom':0.},
    'BALANCED':{'quality':'Low','resolution':'1600x900','rgb':'800x450','postprocess':False,'bloom':0.},
    'HIGH':{'quality':'Epic','resolution':'1280x720','rgb':'800x450','postprocess':True,'bloom':.15},
    'ULTRA':{'quality':'Epic','resolution':'1920x1080','rgb':'1280x720','postprocess':True,'bloom':.5}}

def camera(preset):
    p=PRESETS[preset]
    return {'camera_resolution':p['rgb'],'camera_postprocess':p['postprocess'],
            'camera_motion_blur':0.,'camera_bloom':p['bloom']}


def launch(preset):
    p = PRESETS[preset]
    return {'quality':p['quality'],'resolution':p['resolution'],'render_profile':preset}


def write_render_config(source, destination, profile):
    """Keep the package defaults, overriding only rendering budgets for this launch."""
    if profile not in PRESETS:
        raise ValueError('Unknown render profile')
    high = profile in ('HIGH','ULTRA')
    pool = 1400 if profile == 'ULTRA' else 1200 if high else 1000
    values = {'r.TextureStreaming':1, 'r.Streaming.PoolSize':pool,
              'r.Streaming.LimitPoolSizeToVRAM':1, 'r.Streaming.MaxTempMemoryAllowed':64,
              'r.Streaming.MaxEffectiveScreenSize':1440 if profile == 'ULTRA' else 1080,
              'r.Streaming.UsePerTextureBias':1, 'r.Streaming.MipBias':1,
              'r.DistanceFieldAO':0, 'r.DistanceFieldShadowing':0, 'r.AOGlobalDistanceField':0,
              'r.DistanceFields.AtlasSizeXY':256, 'r.DistanceFields.AtlasSizeZ':256,
              'r.VolumetricFog':0, 'r.RenderTargetPoolMin':200,
              'r.Shadow.MaxResolution':1024, 'r.Shadow.MaxCSMResolution':1024,
              'r.Shadow.CSM.MaxCascades':2, 'r.Shadow.DistanceScale':0.7,
              'r.Shadow.RadiusThreshold':0.04,
              # Retain native 720p/450p camera pixels, textures and temporal AA.
              # Cut expensive reflections/translucency rather than weakening
              # the safety sensor rig or lowering its requested sampling rate.
              'r.SSR.Quality':2 if profile=='ULTRA' else 0,
              'r.SceneColorFringeQuality':0, 'r.MotionBlurQuality':0,
              'r.LightShaftQuality':0, 'r.RefractionQuality':2 if profile=='ULTRA' else 0,
              'r.TranslucencyVolumeBlur':0, 'r.TranslucencyLightingVolumeDim':32,
              'r.PostProcessAAQuality':4 if profile=='ULTRA' else 3,
              'r.ShadowQuality':3 if high else 1, 'r.BloomQuality':3 if high else 0,
              'r.SSS.Quality':0, 'r.SSS.Scale':0,
              'r.VSync':0, 't.MaxFPS':0}
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    config['/Script/Engine.RendererSettings'] = {k:str(v) for k,v in values.items()}
    config['SystemSettings'] = {k:str(v) for k,v in values.items()}
    overrides = io.StringIO()
    config.write(overrides, space_around_delimiters=False)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = Path(source)
    original = source.read_text(encoding='utf-8-sig') if source.exists() else ''
    begin, end = '; YA_RAB_OSTORHA_RENDER_BEGIN', '; YA_RAB_OSTORHA_RENDER_END'
    if begin in original:
        prefix, _, block = original.partition(begin)
        _, found, suffix = block.partition(end)
        if not found:
            raise ValueError('Incomplete managed render configuration')
        original = prefix.rstrip()+'\n'+suffix.lstrip('\n')
    # UE removes comments when saving its INI. Replace old budget keys without
    # collapsing unrelated duplicate entries such as Core.System Paths arrays.
    section, lines = '', []
    for line in original.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            section = stripped[1:-1]
        if section in config and line.partition('=')[0].strip() in values:
            continue
        lines.append(line)
    original = ''.join(lines)
    # Unreal merges repeated sections; keep unrelated keys and native array entries.
    temporary = destination.with_suffix(destination.suffix+'.tmp')
    temporary.write_text(original.rstrip()+'\n\n'+begin+'\n'+overrides.getvalue()+end+'\n',encoding='utf-8')
    temporary.replace(destination)
    return destination
