import importlib
import sys
import struct


class CarlaBlocker(RuntimeError):
    pass


def ensure_runtime(version=None):
    version = version or sys.version_info[:2]
    if not (3, 8) <= tuple(version[:2]) <= (3, 12):
        raise CarlaBlocker("CARLA BLOCKER: CARLA 0.10.0 requires a matching Python 3.8-3.12 x64 API; "
                           f"current Python is {version[0]}.{version[1]}. Install Python 3.12 and the shipped cp312 Windows wheel.")
    if struct.calcsize('P') != 8:
        raise CarlaBlocker('CARLA BLOCKER: a Windows x64 Python runtime is required')


class CarlaConnection:
    def __init__(self, host='127.0.0.1', port=2000, version='0.10.0', timeout=10):
        self.host, self.port, self.expected_version, self.timeout = host, port, version, timeout
        self.client = self.api = None
        self.server_version = self.api_version = None

    def connect(self):
        ensure_runtime()
        try:
            self.api = importlib.import_module('carla')
        except ImportError as error:
            raise CarlaBlocker("CARLA BLOCKER: install the Python API wheel shipped with CARLA 0.10.0, "
                               "matching this Python version and Windows x64") from error
        try:
            self.client = self.api.Client(self.host, self.port)
            self.client.set_timeout(self.timeout)
            self.api_version = self.client.get_client_version()
            self.server_version = self.client.get_server_version()
            if self.api_version != self.server_version or self.server_version.split('-')[0] != self.expected_version:
                raise CarlaBlocker(f"CARLA BLOCKER: version mismatch; target {self.expected_version}, "
                                   f"client {self.api_version}, server {self.server_version}")
            world = self.client.get_world()
            return world
        except Exception:
            self.disconnect()
            raise

    def disconnect(self):
        # The API has no Client.close(); owned actors/settings are cleaned by the provider.
        self.client = None

    def is_connected(self):
        if self.client is None:
            return False
        try:
            self.client.get_world().get_snapshot()
            return True
        except RuntimeError:
            return False
