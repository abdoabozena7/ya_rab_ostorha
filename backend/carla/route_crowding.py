"""Route-sized native traffic placement. Environment generation, never ego sensing."""
def sidewalk_route_candidates(candidates,points,ego_transform):
    """Rank existing native sidewalk/navmesh points along the route ahead.

    Candidates were already verified outside driving lanes. This does not
    fabricate pedestrians in the road or script an inevitable collision.
    """
    f=ego_transform.get_forward_vector();origin=ego_transform.location
    ranked=[]
    for candidate in candidates:
        location=candidate[0]
        gap=min(location.distance(p) for p in points)
        if gap>22.:continue
        forward=(location.x-origin.x)*f.x+(location.y-origin.y)*f.y
        distance=location.distance(origin)
        rank=(0 if 12.<forward<100. else 1,gap+distance*.08)
        ranked.append((rank,candidate))
    # A route without usable sidewalk retains the real local candidates;
    # spawning on a driving surface is never a fallback.
    return [c for _,c in sorted(ranked,key=lambda item:item[0])] or candidates
def destination_key(route):
    target = (route or {}).get('destination') or {}
    return {'map': target.get('map'), 'location': target.get('location')}


def driving_lanes(waypoint, api):
    """Return neighbouring driving lanes facing the route's direction."""
    lanes = {0: waypoint}
    forward = waypoint.transform.get_forward_vector()
    for direction, method in ((-1, 'get_left_lane'), (1, 'get_right_lane')):
        current = waypoint
        for offset in range(1, 4):
            current = getattr(current, method)()
            if current is None or current.lane_type != api.LaneType.Driving or current.lane_width < 2.5:
                break
            facing = current.transform.get_forward_vector()
            if forward.x*facing.x + forward.y*facing.y < .8:
                break
            lanes[direction*offset] = current
    return lanes


def route_slots(native_route, ego_location, api, maximum=75, spacing=12., occupied=()):
    """Safe starting slots across the route, with a denser nearby presence.

    The internal actor limit bounds rendering cost; it is not a requested count.
    No junction spawns, opposing lanes, duplicate road sections or ego overlap.
    """
    waypoints = [entry[0] for entry in native_route]
    if len(waypoints) < 2:
        raise ValueError('Choose a longer road destination before adding traffic')
    lane_rows = [driving_lanes(wp, api) for wp in waypoints]
    distances = [0.]
    for before, after in zip(waypoints, waypoints[1:]):
        distances.append(distances[-1] + before.transform.location.distance(after.transform.location))
    slots = []
    last = -spacing
    for index, (wp, distance) in enumerate(zip(waypoints, distances)):
        if distance-last < spacing or wp.is_junction or wp.lane_width < 2.5 or distances[-1]-distance < 8.:
            continue
        last = distance
        for offset, lane in lane_rows[index].items():
            location = lane.transform.location
            if lane.is_junction or location.distance(ego_location) < 16.:
                continue
            if any(location.distance(other) < 6. for other in occupied):
                continue
            if any(location.distance(slot['transform'].location) < 3. for slot in slots):
                continue
            t = lane.transform
            transform = api.Transform(api.Location(location.x, location.y, location.z+.3), t.rotation)
            slots.append({'transform': transform, 'index': index, 'offset': offset, 'distance_m': distance})
    available = len(slots)
    if available > maximum:
        near = [s for s in slots if s['distance_m'] <= 60.][:min(10, maximum)]
        remaining = [s for s in slots if s not in near]
        count = maximum-len(near)
        indices = [round(i*(len(remaining)-1)/max(1, count-1)) for i in range(count)]
        slots = near + [remaining[i] for i in indices]
    if not slots:
        raise ValueError('This route has no safe traffic spaces. Choose a longer destination')
    for slot in slots:
        # Build paths only for the bounded selected fleet, rather than every
        # possible road space on a long route. Keep parallel lanes where present.
        slot['path'] = [row.get(slot['offset'], waypoints[i]).transform.location
                        for i, row in enumerate(lane_rows[slot['index']:], slot['index'])]
    return slots, {'route_length_m': round(distances[-1], 1), 'available_slots': available,
                   'target_count': len(slots), 'capacity_capped': available > maximum}
