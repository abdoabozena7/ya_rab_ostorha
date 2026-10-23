"""Closed-loop evaluation identities and admission for harness-driven native journeys.

Configurations select only the safety decision layer applied after the shared
route controller. Every configuration keeps sensor freshness limits, physical
braking, collision handling and the command arbiter unchanged.
"""
from dataclasses import dataclass, field
import uuid

CONFIGURATIONS = {
    'A_REACTIVE': {'driving_mode': 'NORMAL', 'decision_layer': None, 'learned_risk': False,
                   'description': 'Existing Normal reactive sensor braking'},
    'B_PHYSICAL_PREDICTIVE': {'driving_mode': 'ROBOSPHERE', 'decision_layer': None, 'learned_risk': False,
                              'description': 'Existing predictive RULE (Ya Rab Ostorha)'},
    'C_LEARNED_RISK': {'driving_mode': 'ROBOSPHERE', 'decision_layer': 'LEARNED_RISK', 'learned_risk': True,
                       'description': 'Calibrated crossing risk with the independent physical supervisor'},
    'D_EVIDENCE_BUDGETED': {'driving_mode': 'ROBOSPHERE', 'decision_layer': 'EVIDENCE_BUDGETED', 'learned_risk': True,
                            'description': 'Evidence-budgeted decisions using calibrated risk when admitted'},
    'E_PHYSICAL_ABLATION': {'driving_mode': 'ROBOSPHERE', 'decision_layer': 'EVIDENCE_BUDGETED', 'learned_risk': False,
                            'description': 'Evidence-budgeted decisions without learned risk'},
}
MAXIMUM_EVALUATION_SPEED_KMH = 60.


@dataclass(frozen=True)
class EvaluationAdmission:
    configuration: str
    requested_speed_kmh: float
    experimental_risk_model: bool = False
    evaluation_id: str = field(default_factory=lambda: 'eval_'+uuid.uuid4().hex)
    max_speed_kmh: float = MAXIMUM_EVALUATION_SPEED_KMH

    def __post_init__(self):
        if self.configuration not in CONFIGURATIONS:raise ValueError('Unknown evaluation configuration')
        if not 5 <= self.requested_speed_kmh <= self.max_speed_kmh <= MAXIMUM_EVALUATION_SPEED_KMH:
            raise ValueError('Evaluation speed must be 5-60 km/h')
        if type(self.experimental_risk_model) is not bool:raise ValueError('Explicit experimental-risk flag required')

    @property
    def spec(self):return CONFIGURATIONS[self.configuration]

    def snapshot(self):
        return {'evaluation_id': self.evaluation_id, 'configuration': self.configuration,
                'requested_speed_kmh': self.requested_speed_kmh, 'max_speed_kmh': self.max_speed_kmh,
                'experimental_risk_model': self.experimental_risk_model, **self.spec,
                'raw_sensor_recording': False, 'record': 'HARNESS_COMPACT_EPISODE_LOG'}
