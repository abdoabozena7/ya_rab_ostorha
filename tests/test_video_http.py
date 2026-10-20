import hashlib
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from backend.server import Handler


class VideoHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name)
        self.run=self.root/('run_'+'a'*32);self.run.mkdir()
        self.payload=bytes(range(256))*8
        (self.run/'metadata.json').write_text(json.dumps({'provider':'carla','data_origin':'REAL_SIMULATION'}))
        (self.run/'driving.mp4').write_bytes(self.payload)
        self.status={'status':'READY','source':'RECORDED_NATIVE_DRIVING_CAMERA','sha256':hashlib.sha256(self.payload).hexdigest()}
        self.write_status()
        class QuietHandler(Handler):
            def log_message(self,*args):pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),QuietHandler)
        self.server.simulation_service=SimpleNamespace(recording_directory=self.root)
        self.thread=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.01},daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_port}/runs/normal_city/{self.run.name}/'

    def write_status(self):(self.run/'video-status.json').write_text(json.dumps(self.status))

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(2);self.temporary.cleanup()

    def test_actual_handler_serves_status_exact_ranges_and_head(self):
        with urllib.request.urlopen(self.url+'video-status.json') as response:self.assertEqual(json.load(response),self.status)
        for value,expected in [('bytes=5-12',self.payload[5:13]),('bytes=-4',self.payload[-4:]),('bytes=2040-',self.payload[2040:])]:
            request=urllib.request.Request(self.url+'driving.mp4',headers={'Range':value})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status,206);self.assertEqual(response.read(),expected)
                self.assertEqual(response.headers['Content-Type'],'video/mp4')
        with urllib.request.urlopen(urllib.request.Request(self.url+'driving.mp4',method='HEAD')) as response:
            self.assertEqual(int(response.headers['Content-Length']),len(self.payload));self.assertEqual(response.read(),b'')

    def test_invalid_ranges_raw_files_and_missing_runs_remain_unavailable(self):
        for header in ('bytes=99999-','bytes=5-2','bytes=1-2,4-6','bytes=-0'):
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(self.url+'driving.mp4',headers={'Range':header}))
            self.assertEqual(error.exception.code,416)
        for suffix in ('metadata.json','telemetry/frames.jsonl','../metadata.json'):
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(self.url+suffix)
            self.assertEqual(error.exception.code,404)

    def test_unready_or_modified_exports_do_not_serve_as_native_video(self):
        self.status['status']='ENCODING';self.write_status()
        with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(self.url+'driving.mp4')
        self.status['status']='READY';self.write_status();(self.run/'driving.mp4').write_bytes(b'changed')
        with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(self.url+'driving.mp4')

    def test_annotated_variant_has_independent_checksum_ranges_and_head(self):
        payload=b'annotated native video'
        target=self.run/'driving-annotated.mp4';target.write_bytes(payload)
        self.status['variants']={'annotated':{'status':'READY','source':'RECORDED_NATIVE_DRIVING_CAMERA_WITH_MEASURED_OVERLAY',
            'sha256':hashlib.sha256(payload).hexdigest()}}
        self.write_status()
        request=urllib.request.Request(self.url+target.name,headers={'Range':'bytes=2-6'})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status,206);self.assertEqual(response.read(),payload[2:7])
        with urllib.request.urlopen(urllib.request.Request(self.url+target.name,method='HEAD')) as response:
            self.assertEqual(int(response.headers['Content-Length']),len(payload))
        target.write_bytes(b'corrupted overlay')
        with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(self.url+target.name)

    def test_shared_front_video_has_its_own_verified_status_and_ranges(self):
        target=self.run/'shared-perception.mp4';target.write_bytes(self.payload)
        status={**self.status,'source':'VERIFIED_COMMON_PREFIX_NATIVE_FRONT_CAMERA','video':target.name,'duration_s':.5}
        (self.run/'shared-perception-status.json').write_text(json.dumps(status))
        with urllib.request.urlopen(self.url+'shared-perception-status.json') as response:self.assertEqual(json.load(response),status)
        with urllib.request.urlopen(urllib.request.Request(self.url+target.name,headers={'Range':'bytes=3-8'})) as response:
            self.assertEqual(response.status,206);self.assertEqual(response.read(),self.payload[3:9])
        target.write_bytes(b'changed')
        with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(self.url+target.name)


if __name__=='__main__':unittest.main()
