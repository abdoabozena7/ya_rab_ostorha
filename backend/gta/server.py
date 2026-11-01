"""Loopback-only live GTA inspection inside the project's dashboard server entry."""
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit

from backend.providers import create_provider

ROOT = Path(__file__).resolve().parents[2]


class GtaHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def respond(self, status, value):
        data = json.dumps(value, allow_nan=False, separators=(',', ':')).encode()
        self.send_response(status);self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store');self.send_header('Content-Length', str(len(data)))
        self.end_headers();self.wfile.write(data)

    def local_request(self):
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        return self.client_address[0] == '127.0.0.1' and self.headers.get('Host') in allowed

    def do_GET(self):
        if not self.local_request():
            return self.respond(403, {'error': 'Loopback Host required'})
        path = urlsplit(self.path).path
        if path == '/':
            self.send_response(302);self.send_header('Location', '/gta-live.html');self.end_headers();return
        if path in ('/api/gta/state', '/api/health'):
            return self.respond(200, self.server.provider.snapshot())
        if path == '/api/gta/image':
            try:
                query = parse_qs(urlsplit(self.path).query)
                image, metadata = self.server.provider.image(int(query['serial'][0]), query.get('kind', ['rgb'])[0])
            except (KeyError, ValueError) as e:
                return self.respond(400, {'error': str(e)})
            except RuntimeError as e:
                return self.respond(503, {'error': str(e)})
            self.send_response(200);self.send_header('Content-Type', 'image/png')
            self.send_header('Cache-Control', 'no-store');self.send_header('Content-Length', str(len(image)))
            for key, value in metadata.items():
                self.send_header('X-GTA-'+key.replace('_', '-'), str(value))
            self.end_headers();self.wfile.write(image);return
        if path.startswith('/api/'):
            return self.respond(404, {'error': 'Unknown GTA endpoint'})
        return super().do_GET()

    def do_POST(self):
        origins = {f'http://{h}:{self.server.server_port}' for h in ('localhost', '127.0.0.1')}
        if not self.local_request() or self.headers.get('Origin') not in origins | {None}:
            return self.respond(403, {'error': 'Local same-origin control required'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096 or self.headers.get_content_type() != 'application/json':
                raise ValueError('Small JSON body required')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Object required')
            path = urlsplit(self.path).path
            if path == '/api/gta/acquire':
                result = self.server.provider.acquire(data.get('client'))
            elif path == '/api/gta/stop':
                with self.server.provider.lock:
                    if self.server.provider.goal:
                        self.server.provider.goal.stop()
                    self.server.provider.intent = None
                result = {'stopped': True}
            elif path == '/api/gta/control':
                result = self.server.provider.control(data)
            else:
                return self.respond(404, {'error': 'Unknown GTA control'})
            return self.respond(200, result)
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self.respond(400, {'error': str(e)})
        except RuntimeError as e:
            return self.respond(409, {'error': str(e)})


def serve(run_directory, *, host='127.0.0.1', port=8000, duration=None):
    if host != '127.0.0.1':
        raise ValueError('GTA inspection binds only to127.0.0.1')
    directory = Path(run_directory)
    for part in (directory, *directory.parents):
        if part.exists() and getattr(part.stat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Reparse runtime directory refused')
    directory = directory.resolve()
    allowed = (ROOT/'.runtime-proof/gta-live-control-20261031/runs/native-live-dashboard',
               ROOT/'.runtime-proof/gta-goal-driver-20261031/runs/native-goal-journey',
               ROOT/'.runtime-proof/gta-human-demonstrations-20261031/runs/native-human-demo')
    allowed += (ROOT/'.runtime-proof/gta-foundation-20261031/runs/native-foundation',)
    allowed += (ROOT/'.runtime-proof/gta-foundation-20261031/setup',)
    if not any(directory.is_relative_to(p) for p in allowed):
        raise ValueError('Explicit owned GTA live runtime directory required')
    provider = create_provider('gta', run_directory=directory)
    server = ThreadingHTTPServer((host, port), GtaHandler)
    server.daemon_threads = True
    server.provider = provider
    (directory/'http-ready.json').write_text(json.dumps({'url': f'http://{host}:{server.server_port}/gta-live.html', 'pid': __import__('os').getpid()}))
    if duration:
        timer = threading.Timer(duration, server.shutdown);timer.daemon = True;timer.start()
    try:
        server.serve_forever(poll_interval=.1)
    finally:
        provider.close();server.server_close()
