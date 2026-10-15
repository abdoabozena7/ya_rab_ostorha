"""Choose and prepare a seeded native presentation without operator setup."""
import random


def prepare(provider, seed, speed):
    p = provider
    p._ensure_dashboard_tools()
    if p.benchmark_fixture:
        p.benchmark_fixture.close()
        p.benchmark_fixture = None
    p.stop_navigation()
    p.population.reset_population()
    p.set_controls(brake=1)
    rng = random.Random(seed)
    tools = p.dashboard_tools
    # Seeded choices between known urban starts; every route is planned natively.
    indices = [80, 152]
    rng.shuffle(indices)
    origin = tools.spawns[indices[0] % len(tools.spawns)]
    p.ego.actor.set_target_velocity(p.connection.api.Vector3D())
    p.ego.actor.set_target_angular_velocity(p.connection.api.Vector3D())
    p.ego.actor.set_transform(origin)
    waypoint = tools.map.get_waypoint(origin.location)
    for _ in range(130):
        choices = waypoint.next(2.)
        if not choices:
            break
        prior = waypoint.transform.rotation.yaw
        waypoint = min(choices, key=lambda w: abs((w.transform.rotation.yaw-prior+180) % 360-180))
    loc = waypoint.transform.location
    target = {'map': tools.map_name, 'location': [loc.x, loc.y, loc.z], 'name': 'Presentation destination'}
    tools.route, tools.native_route = tools.route_service.plan(origin.location, target)
    if tools.route['length_m'] < 100:
        raise ValueError('Automatic route is too short; choose Restart for a new seed')
    config = {**p.population.config, 'vehicle_count': 20, 'pedestrian_count': 15,
        'seed': seed, 'chaos_percent': 45, 'speed_behavior': 'FAST', 'driver_behavior': 'BUSY',
        'light_compliance_percent': 80, 'crossing_percent': 30}
    p.population.apply(config)
    p.population.set_route(tools.route['points'])
    p.set_paused(False)
    return {'destination': target, 'route_length_m': tools.route['length_m'],
        'origin_index': indices[0], 'population': dict(config), 'speed_kmh': speed}
