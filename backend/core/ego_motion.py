"""One signed onboard speed convention, including rollback and gear transitions."""


def signed_speed(ego):
    measured=getattr(ego,'longitudinal_speed_mps',None)
    return measured if measured is not None else ego.speed_mps*(-1. if ego.reverse else 1.)


def motion_speed(ego):
    """Forward/rear travel excludes vertical suspension motion when measured."""
    return abs(signed_speed(ego))
