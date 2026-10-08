class EgoVehicle:
    def __init__(self, world, blueprint_id='vehicle.lincoln.mkz_2020', spawn_index=0, *, strict_spawn=False):
        self.world, self.blueprint_id, self.spawn_index = world, blueprint_id, spawn_index
        self.strict_spawn = strict_spawn
        self.actor = None
        self.selected_spawn_index = None
        self.spawn_transform = None

    def spawn(self):
        self.destroy()
        blueprint = self.world.get_blueprint_library().find(self.blueprint_id)
        blueprint.set_attribute('role_name', 'ostorha_ego')
        points = self.world.get_map().get_spawn_points()
        if not 0 <= self.spawn_index < len(points):
            raise ValueError(f'Spawn index {self.spawn_index} outside map spawn points (count {len(points)})')
        order = [self.spawn_index] if self.strict_spawn else [self.spawn_index] + [i for i in range(len(points)) if i != self.spawn_index]
        for index in order:
            self.actor = self.world.try_spawn_actor(blueprint, points[index])
            if self.actor is not None:
                self.selected_spawn_index = index
                self.spawn_transform = points[index]
                break
        if self.actor is None:
            raise RuntimeError(f'All {len(points)} CARLA spawn points are occupied')
        self.actor.set_autopilot(False)
        return self.actor

    def destroy(self):
        if self.actor is not None:
            actor = self.actor
            if actor.is_alive and not actor.destroy():
                raise RuntimeError(f'CARLA could not destroy owned ego actor {actor.id}')
            self.actor = None
