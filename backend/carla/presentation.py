"""Choose and prepare a seeded native presentation without operator setup."""
import random


def prepare(provider, seed, speed, *, scene='BUSY_ROUTE', guided=False, scenario_id=None):
    p = provider
    p.guided_presentation=guided
    p.presentation_scenario_id = scenario_id
    p.dense_chaos=None
    p.benchmark_prepared=False
    p.presentation_vehicle_variants=None
    p.presentation_vehicle_mode=None
    p._ensure_dashboard_tools()
    if p.benchmark_fixture:
        p.benchmark_fixture.close()
        p.benchmark_fixture = None
    p.stop_navigation()
    p.population.reset_population()
    p.set_controls(brake=1)
    if scenario_id == 'EGYPT_URBAN_CHAOS_V1':
        from ..core.egypt_urban import admission
        from .egypt_urban import prepare_route
        admission(p.dashboard_tools.map_name, speed)
        p.prepare_guided_vehicle(urban=True)
        return {**prepare_route(p, seed), 'speed_kmh': speed}
    if guided:p.prepare_guided_vehicle()
    rng = random.Random(seed)
    tools = p.dashboard_tools
    selection_seed=seed;search_m=260.
    if guided:
        from .crossing_comparison import catalogue
        library=catalogue();spec=library['variants'][seed%len(library['variants'])]
        if tools.map_name.rsplit('/',1)[-1]!=library['map']:raise ValueError('The crossing library requires '+library['map']+'. Select that city before starting.')
        seed=spec['fixture_seed'];rng=random.Random(seed);search_m=library['route_search_distance_m']
    # Seeded choices between known urban starts; every route is planned natively.
    indices = [152] if guided else [80, 152]
    rng.shuffle(indices)
    from .route_crowding import route_slots
    candidates=[]
    for index in indices:
        origin=tools.spawns[index % len(tools.spawns)]
        waypoint=tools.map.get_waypoint(origin.location)
        for _ in range(round(search_m/2)):
            choices=waypoint.next(2.)
            if not choices:break
            prior=waypoint.transform.rotation.yaw
            waypoint=min(choices,key=lambda w:abs((w.transform.rotation.yaw-prior+180)%360-180))
        loc=waypoint.transform.location
        target={'map':tools.map_name,'location':[loc.x,loc.y,loc.z],'name':'Presentation destination'}
        route,native=tools.route_service.plan(origin.location,target)
        if route['length_m']<100:continue
        try:_,capacity=route_slots(native,origin.location,p.connection.api,maximum=40)
        except ValueError:continue
        candidates.append((capacity['target_count'],index,origin,target,route,native))
    if not candidates:raise ValueError('No automatic route has usable native traffic spaces')
    # Prefer a genuinely busier route rather than promising a fleet that cannot
    # physically fit. The seed orders equal-capacity choices and actor behavior.
    capacity,index,origin,target,tools.route,tools.native_route=max(candidates,key=lambda c:c[0])
    p.ego.actor.set_target_velocity(p.connection.api.Vector3D())
    p.ego.actor.set_target_angular_velocity(p.connection.api.Vector3D())
    p.ego.actor.set_transform(origin)
    # Establish the route before spawning: both traffic and native sidewalk
    # selection need the road ahead, rather than the previous trip's route.
    p.population.set_route(tools.route['points'])
    p.set_paused(False)
    return {'destination': target, 'route_length_m': tools.route['length_m'],
        'origin_index': index,'planned_vehicle_capacity':capacity,'population_pending':True,
        'requested_route_vehicles':60 if scene=='DENSE_CHAOS' else 40,'requested_route_pedestrians':100 if scene=='DENSE_CHAOS' else 30,
        'scene':scene,'speed_kmh': speed,'scenario_seed':seed,'selection_seed':selection_seed}


def finish_prepare(p,seed,setup):
    # The sole worker has advanced the teleport. Population geometry now sees
    # the actual new ego pose instead of CARLA's previous-frame actor cache.
    tools=p.dashboard_tools
    if setup.get('scenario_id') == 'EGYPT_URBAN_CHAOS_V1':
        from .egypt_urban import finish_prepare as finish_egypt_prepare
        return finish_egypt_prepare(p, seed, setup)
    if p.guided_presentation:seed=setup['scenario_seed']
    if setup.get('scene')=='DENSE_CHAOS':
        from .dense_chaos import DenseChaos
        from .crossing_comparison import CrossingComparison
        config={**p.population.config,'vehicle_count':60,'pedestrian_count':100,'seed':seed,
            'chaos_percent':100,'speed_behavior':'FAST','driver_behavior':'UNREGULATED',
            'light_compliance_percent':20,'crossing_percent':60,'placement':'EGO_SURROUNDING','vehicle_mix':'MIXED','fast_walk_percent':20}
        if p.guided_presentation:
            # This controlled comparison varies the ego predictor, not NPC
            # violations or random lane changes into a stopped test vehicle.
            # Keep all 60 physical vehicles and 100 pedestrians. The explicit
            # crossing schedule owns pedestrian ingress in both arms.
            config.update(chaos_percent=0,speed_behavior='NORMAL',driver_behavior='NORMAL',
                light_compliance_percent=100,crossing_percent=0)
        p.population.apply(config)
        p.dense_chaos=CrossingComparison(p,seed) if p.guided_presentation else DenseChaos(p,seed)
        if p.guided_presentation:
            api=p.connection.api
            for light in p.world.world.get_actors().filter('traffic.traffic_light*'):
                light.set_state(api.TrafficLightState.Green);light.set_green_time(60.);light.set_yellow_time(3.);light.set_red_time(15.)
        return {**setup,'population_pending':False,'population':dict(p.population.config)}
    config = {**p.population.config, 'vehicle_count': 0, 'pedestrian_count': 30,
        'seed': seed, 'chaos_percent': 45, 'speed_behavior': 'FAST', 'driver_behavior': 'BUSY',
        'light_compliance_percent': 80, 'crossing_percent': 30,'placement':'ROUTE','vehicle_mix':'MIXED'}
    p.population.apply(config)
    p.population.crowd_route(tools.route,tools.native_route,{'route_id':tools.route['id'],
        'seed':seed,'chaos_percent':45,'vehicle_count':40})
    p.population.admit_route_capacity()
    return {**setup,'population_pending':False,'population':dict(p.population.config)}


def population_audit(p):
    if getattr(p,'dense_chaos',None):return p.dense_chaos.audit()
    snapshot=p.world.world.get_snapshot();ego=snapshot.find(p.ego.actor.id)
    if ego is None:raise ValueError('Presentation ego is absent from the current frame')
    pose=ego.get_transform();forward=pose.get_forward_vector();origin=pose.location
    counts={}
    for category,ids in [('vehicles',p.population.vehicles),('pedestrians',p.population.walkers)]:
        actors=[snapshot.find(i) for i in ids];actors=[a for a in actors if a is not None]
        counts[category]={'total':len(actors),'ahead':sum(
            (a.get_transform().location.x-origin.x)*forward.x+(a.get_transform().location.y-origin.y)*forward.y>0 for a in actors)}
    return {'frame_id':snapshot.frame,'counts':counts,'passed':counts['vehicles']['total']>=20 and
        counts['vehicles']['ahead']>=10 and counts['pedestrians']['total']>=30 and counts['pedestrians']['ahead']>=15}
