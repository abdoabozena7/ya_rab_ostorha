"""Native annotations must never become RGB detector inputs."""
from types import SimpleNamespace as NS
from unittest import TestCase
from unittest.mock import Mock
from backend.carla.scene_overlays import draw


class NativeSceneOverlayTests(TestCase):
    def test_measured_world_geometry_uses_only_server_hud_primitives(self):
        debug=Mock()
        provider=NS(connection=NS(api=Mock()),world=NS(world=NS(debug=debug)),
            last_vehicle={'timestamp':1.},fixed_delta=.05)
        prediction={'visual_version':1,'timestamp_s':1.,'evaluation_frame':10,
            'render_reference':{'position_m':[0.,0.,0.],'rotation_rad':{}},
            'boxes_3d':[{'track_id':'person','class':'person','source':'CURRENT_SENSOR_GEOMETRY',
                'measurement_frame':10,'center_m':[10.,2.,1.],'half_size_m':[.3,.3,.8]}],
            'trajectories':[{'track_id':'person','class':'person','points':[[0.,10.,2.],[1.,10.,0.]],
                'used_for_actuation':True}]}
        draw(provider,prediction)
        debug.draw_hud_box.assert_called_once()
        debug.draw_hud_arrow.assert_called_once()
        debug.draw_hud_line.assert_called_once()
        for name in ('draw_box','draw_arrow','draw_line'):getattr(debug,name).assert_not_called()
        self.assertAlmostEqual(debug.draw_hud_box.call_args.kwargs['life_time'],.0501)
