"""Read-only physical configuration for auditing matched native drivers."""
import math


def physical_configuration(actor):
    physics=actor.get_physics_control()
    def numbers(value,keys):
        return {key:getattr(value,key) for key in keys
                if type(getattr(value,key,None)) in (int,float,bool) and math.isfinite(getattr(value,key))}
    result=numbers(physics,('mass','drag_coefficient','max_rpm','moi','damping_rate_full_throttle',
        'damping_rate_zero_throttle_clutch_engaged','damping_rate_zero_throttle_clutch_disengaged',
        'use_gear_autobox','gear_switch_time','clutch_strength','final_ratio','use_sweep_wheel_collision'))
    result['wheels']=[numbers(wheel,('tire_friction','damping_rate','max_steer_angle','radius',
                                    'max_brake_torque','max_handbrake_torque')) for wheel in physics.wheels]
    result['torque_curve']=[[point.x,point.y] for point in physics.torque_curve]
    result['center_of_mass']=[physics.center_of_mass.x,physics.center_of_mass.y,physics.center_of_mass.z]
    return result
