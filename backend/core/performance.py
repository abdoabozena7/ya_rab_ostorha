"""Opt-in runtime rates; requested frequencies are not measured throughput."""
RUN_PROFILES = ('LEGACY', 'PERFORMANCE_60')
GPU_BUDGET_MIB = 4608


def validate_run_profile(name):
    if not isinstance(name, str) or name not in RUN_PROFILES:
        raise ValueError('Run profile must be LEGACY or PERFORMANCE_60')
    return name


def rates(name, fixed_delta=.05):
    validate_run_profile(name)
    split = name == 'PERFORMANCE_60'
    return {'profile': name, 'physicsHz': 60 if split else 1/fixed_delta,
            'decisionHz': 20 if split else 1/fixed_delta,
            'displayCaptureHz': 60 if split else 1/fixed_delta,
            'physicsStepsPerDecision': 3 if split else 1,
            'gpuBudgetMiB': GPU_BUDGET_MIB, 'acceptance': 'NOT_PROMOTED' if split else 'EXISTING_DEFAULT'}
