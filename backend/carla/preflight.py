"""Read-only native connection/version/catalog check, before starting a tick owner."""
import json
from .connection import CarlaConnection


def main():
    connection = CarlaConnection()
    try:
        world = connection.connect()
        print(json.dumps({'source': 'carla', 'version': connection.server_version,
                          'pythonApiVersion': connection.api_version,
                          'map': world.get_map().name,
                          'frame': world.get_snapshot().frame,
                          'availableMaps': connection.client.get_available_maps(),
                          'vehicleBlueprints': [bp.id for bp in world.get_blueprint_library().filter('vehicle.*')]}, indent=2))
    except RuntimeError as error:
        reason = str(error)
        raise SystemExit(reason if reason.startswith('CARLA BLOCKER:') else 'CARLA BLOCKER: ' + reason) from None
    finally:
        connection.disconnect()


if __name__ == '__main__':
    main()
