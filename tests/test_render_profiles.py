import configparser
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend.graphics import PRESETS, launch, write_render_config
from backend.carla.dashboard_tools import validate_settings
from backend.carla.runtime import NativeRuntime, native_processes
from backend.carla.provider import CarlaProvider


class RenderProfileTests(unittest.TestCase):
    def test_budgeted_profiles_remain_distinct_across_restart_validation(self):
        provider = object.__new__(CarlaProvider)
        provider.connection = SimpleNamespace(host='127.0.0.1')
        for name in PRESETS:
            with self.subTest(profile=name):
                data = launch(name)
                self.assertEqual(validate_settings({'next_launch':data})['next_launch'],data)
                self.assertEqual(data['render_profile'],name)
                self.assertEqual(provider.validate_graphics({'preset':name}),data)

    def test_untrusted_profile_and_quality_mismatch_are_rejected(self):
        for profile in ('../Engine.ini', [], 'HIGH'):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                validate_settings({'next_launch':{'quality':'Low','resolution':'1280x720','render_profile':profile}})

    def test_native_array_entries_and_other_user_settings_are_preserved(self):
        original = '[Core.System]\nPaths=one\nPaths=two\n\n[Custom]\nKeep=42\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'Engine.ini'
            path.write_text(original,encoding='utf-8')
            write_render_config(path,path,'HIGH')
            first = path.read_text(encoding='utf-8')
            self.assertTrue(first.startswith(original.rstrip()))
            write_render_config(path,path,'LOW')
            second = path.read_text(encoding='utf-8')
            self.assertTrue(second.startswith(original.rstrip()))
            self.assertEqual(second.count('; YA_RAB_OSTORHA_RENDER_BEGIN'),1)
            config = configparser.ConfigParser(strict=False)
            config.read(path)
            self.assertEqual(config.getint('SystemSettings','r.Streaming.PoolSize'),1000)
            self.assertEqual(config.getint('Custom','Keep'),42)

    def test_high_has_bounded_textures_and_shadows_with_real_rendering_enabled(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'Engine.ini'
            write_render_config(path,path,'HIGH')
            config = configparser.ConfigParser()
            config.read(path)
            settings = config['SystemSettings']
            self.assertEqual(settings.getint('r.TextureStreaming'),1)
            self.assertLessEqual(settings.getint('r.Streaming.PoolSize'),1400)
            self.assertLessEqual(settings.getint('r.Shadow.CSM.MaxCascades'),2)
            self.assertEqual(settings.getint('r.DistanceFieldAO'),0)
            self.assertNotIn('r.no_rendering_mode',settings)

    def test_engine_normalized_config_does_not_accumulate_old_budget_values(self):
        original = ('[Core.System]\nPaths=one\nPaths=two\n[SystemSettings]\n'
                    'r.Streaming.PoolSize=1200\nr.Streaming.PoolSize=1200\n'
                    'r.CustomUserSetting=42\n')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'Engine.ini'
            path.write_text(original,encoding='utf-8')
            write_render_config(path,path,'LOW')
            text = path.read_text(encoding='utf-8')
            self.assertEqual(text.count('r.Streaming.PoolSize='),2)
            self.assertNotIn('PoolSize=1200',text)
            self.assertIn('r.CustomUserSetting=42',text)
            self.assertIn('Paths=one\nPaths=two',text)

    def test_incomplete_managed_block_does_not_overwrite_user_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'Engine.ini'
            original = '[Custom]\nKeep=42\n; YA_RAB_OSTORHA_RENDER_BEGIN\n'
            path.write_text(original,encoding='utf-8')
            with self.assertRaises(ValueError):
                write_render_config(path,path,'HIGH')
            self.assertEqual(path.read_text(encoding='utf-8'),original)

    def test_legacy_launch_metadata_uses_safe_defaults_and_detects_engine_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            install = Path(directory)/'install'
            install.mkdir()
            executable = install/'CarlaUE4.exe'
            executable.touch()
            (install/'.carla-install.json').write_text(json.dumps({
                'executable':str(executable),'version':'0.9.16',
                'packageVerified':True,'pythonApiValidated':True}))
            process = Mock(returncode=7)
            process.poll.return_value = 7
            runtime = object.__new__(NativeRuntime)
            with patch('backend.carla.runtime.INSTALL',install), \
                    patch.dict('os.environ',{'LOCALAPPDATA':directory}), \
                    patch('backend.carla.runtime.subprocess.Popen',return_value=process) as start, \
                    self.assertRaisesRegex(RuntimeError,'exited during startup'):
                runtime.launch({'quality':'Epic','resolution':'1280x720',
                                'renderer':None,'render_profile':None},'127.0.0.1',2000,None)
            args = start.call_args.args[0]
            self.assertIn('-D3D12',args)
            self.assertIn('-ostorha-render-profile=HIGH',args)
            self.assertEqual(len([arg for arg in args if arg.startswith('-abslog=')]),1)

    def test_low_startup_logs_are_unique_without_enabling_performance_render_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            install = Path(directory)/'install'
            install.mkdir()
            executable = install/'CarlaUE4.exe'
            executable.touch()
            (install/'.carla-install.json').write_text(json.dumps({
                'executable':str(executable),'version':'0.9.16',
                'packageVerified':True,'pythonApiValidated':True}))
            process = Mock(returncode=3221226505)
            process.poll.return_value = process.returncode
            paths = []
            for profile in ('LOW','LOW','PERFORMANCE_60'):
                runtime = object.__new__(NativeRuntime)
                with patch('backend.carla.runtime.INSTALL',install), \
                        patch.dict('os.environ',{'LOCALAPPDATA':directory}), \
                        patch('backend.carla.runtime.subprocess.Popen',return_value=process) as start, \
                        self.assertRaisesRegex(RuntimeError,'engine log:'):
                    runtime.launch({**launch(profile),'renderer':'D3D12','offscreen':True},
                                   '127.0.0.1',2000,None)
                arguments = start.call_args.args[0]
                log_args = [arg.removeprefix('-abslog=') for arg in arguments if arg.startswith('-abslog=')]
                self.assertEqual(log_args,[str(runtime.engine_log)])
                self.assertTrue(runtime.engine_log.is_absolute())
                self.assertTrue(runtime.engine_log.parent.is_dir())
                self.assertIn('-D3D12',arguments)
                self.assertIn('-RenderOffScreen',arguments)
                self.assertEqual(any(arg.startswith('-ExecCmds=') for arg in arguments),profile=='PERFORMANCE_60')
                paths.extend(log_args)
            self.assertEqual(len(set(paths)),3)

    def test_failed_identity_query_is_not_an_empty_process_list_and_exposes_native_error(self):
        result = SimpleNamespace(returncode=5,stdout='',stderr='Scoped query failure fixture')
        with patch('backend.carla.runtime.subprocess.run',return_value=result), \
                self.assertRaisesRegex(RuntimeError,'query exit 5.*Scoped query failure fixture'):
            native_processes()
