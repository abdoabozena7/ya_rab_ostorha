"""Recorded capabilities for the sensor-reactive/predictive comparison."""

SENSOR_COMPARISON_PROTOCOL = 'SENSOR_REACTIVE_PREDICTIVE_V1'
SENSOR_COMPARISON_PROTOCOLS = (SENSOR_COMPARISON_PROTOCOL, 'EGYPT_COMPLETE_DRIVERS_V1')


def driver_profile(mode, scenario_id=None):
    if mode not in ('NORMAL', 'ROBOSPHERE'):
        raise ValueError('Sensor comparison requires NORMAL or ROBOSPHERE')
    predictive = mode == 'ROBOSPHERE'
    if scenario_id == 'EGYPT_URBAN_CHAOS_V1':
        from .egypt_urban import PROTOCOL, DRIVER_ID
        return {'version': 2 if predictive else 1, 'protocol': PROTOCOL,
                'id': DRIVER_ID if predictive else 'NORMAL_REACTIVE_SENSORS_V1',
                'controller': 'URBAN_MANEUVER_RULE' if predictive else 'REACTIVE_SENSORS',
                'sensor_obstacle_braking': True, 'motion_prediction_used': predictive,
                'moving_vehicle_overtaking': predictive, 'complete_maneuver_verification': predictive,
                'maximum_speed_kmh': 60, 'comparison_scope': 'COMPLETE_DRIVERS',
                'learned_control_used': False, 'reinforcement_learning_used': False}
    return {'version': 1, 'protocol': SENSOR_COMPARISON_PROTOCOL,
            'id': 'ROBOSPHERE_PREDICTIVE_RULE_V1' if predictive else 'NORMAL_REACTIVE_SENSORS_V1',
            'controller': 'RULE' if predictive else 'REACTIVE_SENSORS',
            'sensor_obstacle_braking': True, 'motion_prediction_used': predictive,
            'learned_control_used': False, 'reinforcement_learning_used': False}
