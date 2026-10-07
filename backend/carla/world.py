"""One tick owner; restore the simulator's original settings on shutdown."""


class CarlaWorld:
    def __init__(self, world, fixed_delta=.05):
        if not 0 < fixed_delta <= .1:
            raise ValueError('fixed_delta_seconds must be > 0 and <= 0.1')
        self.world = world
        self.previous = world.get_settings()
        self.spectator_transform = world.get_spectator().get_transform()
        if self.previous.synchronous_mode:
            raise RuntimeError('CARLA world already has synchronous ticking enabled; stop the other tick owner first')
        settings = world.get_settings()
        settings.synchronous_mode = True
        settings.fixed_delta_seconds = fixed_delta
        settings.substepping = True
        settings.max_substep_delta_time = .01
        settings.max_substeps = 10
        try:
            world.apply_settings(settings)
        except Exception:
            world.apply_settings(self.previous)
            raise
        self.paused = False

    def advance(self):
        frame = self.world.get_snapshot().frame if self.paused else self.world.tick()
        snapshot = self.world.get_snapshot()
        if snapshot.frame != frame:
            raise RuntimeError('CARLA snapshot frame changed; another client may be ticking the world')
        return snapshot

    def state(self, snapshot):
        return {'source': 'carla', 'map': self.world.get_map().name,
                'frame': snapshot.frame, 'timestamp': snapshot.timestamp.elapsed_seconds,
                'fixedDeltaSeconds': self.world.get_settings().fixed_delta_seconds,
                'synchronous': True, 'paused': self.paused}

    def restore(self):
        try:
            self.world.get_spectator().set_transform(self.spectator_transform)
        finally:
            self.world.apply_settings(self.previous)
