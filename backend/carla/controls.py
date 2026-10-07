"""Convert application inputs to native CARLA VehicleControl."""
import math


def native_control(api, *, throttle=0, brake=0, steering=0, parkingbrake=0, gear=1):
    for value, low in ((throttle, 0), (brake, 0), (steering, -1), (parkingbrake, 0)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= 1:
            raise ValueError('Invalid vehicle control')
    if isinstance(gear, bool) or not isinstance(gear, int) or gear not in {-1, 0, 1}:
        raise ValueError('Application gear must be -1 (R), 0 (N), or 1 (automatic D)')
    # Application steering is positive left; CARLA steering is positive right.
    return api.VehicleControl(throttle=throttle, brake=brake, steer=-steering,
                              hand_brake=parkingbrake > 0, reverse=gear == -1,
                              manual_gear_shift=gear == 0, gear=gear)
