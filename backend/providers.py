"""Only construction boundary imports a native adapter, lazily."""
def create_provider(name, **configuration):
    if name != 'carla':
        raise ValueError('No production adapter configured for this provider')
    from .carla.provider import CarlaProvider
    return CarlaProvider(**configuration)
