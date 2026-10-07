"""Read the actual local installation and native server; never substitute mocks."""
import json
import platform
import subprocess
import sys
from pathlib import Path
from backend.carla.connection import CarlaConnection


def main():
    connection = CarlaConnection()
    world = connection.connect()
    try:
        gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=name,memory.total,memory.used,driver_version',
                                       '--format=csv,noheader,nounits'], text=True).strip()
        ram = subprocess.check_output(['pwsh', '-NoProfile', '-Command',
                                      '(Get-CimInstance Win32_PhysicalMemory | Measure-Object Capacity -Sum).Sum'], text=True).strip()
        install = Path('C:/CARLA/CARLA_0.9.16')
        manager = connection.client.get_trafficmanager(8003)
        result = {'server_version': connection.server_version, 'python_api_version': connection.api_version,
                  'python_version': platform.python_version(), 'python_executable': sys.executable,
                  'python_api_path': connection.api.__file__, 'installation': str(install),
                  'launcher': str(install/'CarlaUE4.exe'),
                  'native_executable': str(install/'CarlaUE4/Binaries/Win64/CarlaUE4-Win64-Shipping.exe'),
                  'map': world.get_map().name, 'gpu_name_vram_mib_used_mib_driver': gpu,
                  'physical_memory_bytes': int(ram), 'user_reported_memory_gb': 32,
                  'blueprint_count': len(world.get_blueprint_library()),
                  'vehicle_blueprint_count': len(world.get_blueprint_library().filter('vehicle.*')),
                  'traffic_manager_port': manager.get_port(), 'vehicles': len(world.get_actors().filter('vehicle.*')),
                  'sensor_actors': len(world.get_actors().filter('sensor.*')),
                  'world_settings': {'synchronous': world.get_settings().synchronous_mode,
                                     'fixed_delta_seconds': world.get_settings().fixed_delta_seconds}, 'status': 'PASS'}
        output = Path('output/native-validation'); output.mkdir(parents=True, exist_ok=True)
        (output/'installation.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
    finally:
        connection.disconnect()


if __name__ == '__main__':
    main()
