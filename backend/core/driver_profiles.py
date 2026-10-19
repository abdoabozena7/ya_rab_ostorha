"""Recorded capabilities for the sensor-reactive/predictive comparison."""

SENSOR_COMPARISON_PROTOCOL = 'SENSOR_REACTIVE_PREDICTIVE_V1'


def driver_profile(mode):
    if mode not in ('NORMAL', 'ROBOSPHERE'):
        raise ValueError('Sensor comparison requires NORMAL or ROBOSPHERE')
    predictive = mode == 'ROBOSPHERE'
    return {'version': 1, 'protocol': SENSOR_COMPARISON_PROTOCOL,
            'id': 'ROBOSPHERE_PREDICTIVE_RULE_V1' if predictive else 'NORMAL_REACTIVE_SENSORS_V1',
            'controller': 'RULE' if predictive else 'REACTIVE_SENSORS',
            'sensor_obstacle_braking': True, 'motion_prediction_used': predictive,
            'learned_control_used': False, 'reinforcement_learning_used': False}
