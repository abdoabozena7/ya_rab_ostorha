"""Budget-aware, one-shot Egypt matrix. Preflight never launches CARLA."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import uuid

from backend.core.egypt_urban import (
    ROOT, SCENARIO_ID, ACCEPTANCE, acceptance_matrix, configuration, source_fingerprint,
)


def matrix_plan(*, acceptance=False, development_seed=None, first='NORMAL'):
    config = configuration()
    if first not in ('NORMAL', 'ROBOSPHERE'):
        raise ValueError('Choose a supported first driver')
    if acceptance:
        if development_seed is not None:
            raise ValueError('The reserved acceptance partition cannot be overridden')
        return [{'seed': seed, 'first_mode': mode} for seed in config['holdout_seeds']
                for mode in ('NORMAL', 'ROBOSPHERE')]
    seed = config['development_seeds'][0] if development_seed is None else development_seed
    if seed not in config['development_seeds']:
        raise ValueError('Development uses only declared non-holdout seeds')
    return [{'seed': seed, 'first_mode': first}]


def existing_budget_status(rule_ticket=None, *, directory=ROOT / 'output' / 'hybrid-driving'):
    if rule_ticket:
        from backend.learning.native_validation_budget import NativeValidationBudget
        budget = NativeValidationBudget(rule_ticket)
        status = budget.status()
        return {**status, 'unfinished': 0, 'kind': 'EXISTING_RULE_TICKET',
                'authorized': budget.ticket.get('scope') == 'NATIVE_RULE_REPAIR',
                'sha256': hashlib.sha256(Path(rule_ticket).read_bytes()).hexdigest()}
    path = Path(directory) / 'budget.sqlite'
    if not path.is_file():
        return {'kind': 'EXISTING_HYBRID_LEDGER', 'remaining_s': 0., 'authorized': False,
                'unfinished': 0, 'reason': 'No existing authorized ledger; none was created'}
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        gross, unfinished = db.execute(
            'SELECT COALESCE(SUM(seconds),0),COALESCE(SUM(CASE WHEN finished=0 THEN 1 ELSE 0 END),0) FROM reservations').fetchone()
        excluded = db.execute('SELECT COALESCE(SUM(excluded_s),0) FROM sleep_adjustments').fetchone()[0]
    return {'kind': 'EXISTING_HYBRID_LEDGER', 'cap_s': 14400., 'charged_s': gross - excluded,
            'gross_recorded_s': gross, 'excluded_verified_sleep_s': excluded,
            'remaining_s': max(0., 14400. - gross + excluded), 'unfinished': unfinished,
            'authorized': True, 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def preflight(plan, seconds_per_pair, status):
    if type(seconds_per_pair) not in (int, float) or not 180. <= seconds_per_pair <= 1800.:
        raise ValueError('Use an identified 180--1800 second reservation per complete pair')
    cleanup = len(plan) * 300.
    required = len(plan) * seconds_per_pair + cleanup
    ready = bool(status.get('authorized') and status.get('unfinished') == 0 and status['remaining_s'] >= required)
    return {'scenario_id': SCENARIO_ID, 'source': 'READ_ONLY_NATIVE_AUTHORIZATION_PREFLIGHT',
            'can_run': ready, 'native_acceptance': False, 'engine_started': False,
            'reason': 'Existing window can cover the requested matrix' if ready
                else 'Pending: existing authorized window cannot cover this matrix; no allowance was reset or extended',
            'required_reservation_s': required, 'planned_pairs': plan, 'planned_trips': len(plan) * 2,
            'cleanup_reservation_s': cleanup,
            'budget_before': status}


def compact_pair(pair):
    result = {k: v for k, v in pair.items() if k in ('version', 'order', 'conditions_match', 'manifest', 'runs', 'scenario_validation')}
    result['manifest'] = {k: v for k, v in result['manifest'].items() if k != 'initial_conditions'}
    result['runs'] = {mode: {**run, 'setup': {k: v for k, v in run['setup'].items() if k != 'initial_conditions'}}
                      for mode, run in result['runs'].items()}
    return result


def write_report(path, report):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf8')
    temporary.replace(path)


def run(args):
    plan = matrix_plan(acceptance=args.acceptance, development_seed=args.development_seed, first=args.first)
    before = existing_budget_status(args.rule_ticket)
    report = preflight(plan, args.seconds_per_pair, before)
    report.update(created_at_utc=datetime.now(timezone.utc).isoformat(), source_sha256=source_fingerprint())
    target = Path(args.report) if args.report else ROOT / 'output' / 'egypt-urban-chaos' / (uuid.uuid4().hex + '.json')
    write_report(target, report)
    if not args.run or not report['can_run']:
        report['budget_after'] = existing_budget_status(args.rule_ticket)
        report['authorization_unchanged'] = before.get('sha256') == report['budget_after'].get('sha256')
        write_report(target, report)
        print(json.dumps({'report': str(target), 'can_run': report['can_run'], 'reason': report['reason']}))
        return 2 if args.run and not report['can_run'] else 0
    if args.rule_ticket:
        from backend.learning.native_validation_budget import NativeValidationBudget
        budget = NativeValidationBudget(args.rule_ticket)
        budget.activate_rule()
        reservation = budget.experiment('comparison_v2_run', report['required_reservation_s'])
    else:
        from backend.learning.hybrid_budget import HybridBudget
        budget = HybridBudget()
        reservation = budget.experiment('egypt-urban-chaos-acceptance' if args.acceptance else 'egypt-urban-chaos-development',
                                        report['required_reservation_s'])
    report['pairs'] = []
    report['engine_started'] = None
    try:
        with reservation:
            from .validate_crossing_pair import run as run_pair
            for item in plan:
                if source_fingerprint() != report['source_sha256']:
                    raise RuntimeError('Frozen source changed; remaining holdout trips are pending, not retried')
                options = SimpleNamespace(seed=item['seed'], first=item['first_mode'], seconds=args.seconds_per_pair,
                    render_profile=args.render_profile, scenario=SCENARIO_ID, rule_ticket=args.rule_ticket,
                    holdout_acceptance=args.acceptance)
                run_pair(options)
                folder = options.report_folder
                raw = json.loads((folder / 'report.json').read_text(encoding='utf8'))
                if raw.get('render_profile'):
                    report['engine_started'] = True
                report['pairs'].append({key: raw.get(key) for key in ('seed', 'first_mode', 'source', 'source_sha256',
                    'source_unchanged', 'attempts_retained', 'native_acceptance')})
                report['pairs'][-1].update(pair=compact_pair(raw.get('pair') or {'manifest': {}, 'runs': {}}),
                    report=str(folder / 'report.json'), report_sha256=hashlib.sha256((folder / 'report.json').read_bytes()).hexdigest())
                write_report(target, report)
    except (OSError, ValueError, RuntimeError, TimeoutError, sqlite3.Error) as error:
        report['error'] = str(error)
    finally:
        report['budget_after'] = existing_budget_status(args.rule_ticket)
        report['source_unchanged'] = source_fingerprint() == report['source_sha256']
        if args.acceptance:
            assessment = acceptance_matrix(report['pairs'], report['source_sha256'])
            report.update(accepted=assessment['accepted'] and report['source_unchanged'] and not report.get('error'),
                          gates=assessment['gates'])
            if report['accepted']:
                write_report(ACCEPTANCE, assessment)
        else:
            report['accepted'] = False
        write_report(target, report)
    print(json.dumps({'report': str(target), 'accepted': report['accepted'], 'error': report.get('error')}))
    return 0 if report.get('accepted') else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Use an existing window; otherwise read-only preflight')
    parser.add_argument('--acceptance', action='store_true', help='Reserved three seeds, both orders, no retries')
    parser.add_argument('--development-seed', type=int)
    parser.add_argument('--first', choices=('NORMAL', 'ROBOSPHERE'), default='NORMAL')
    parser.add_argument('--seconds-per-pair', type=float, default=900.)
    parser.add_argument('--rule-ticket', help='An existing unexpired RULE repair ticket; never creates one')
    parser.add_argument('--render-profile', choices=('LOW', 'BALANCED', 'HIGH'), default='LOW')
    parser.add_argument('--report')
    raise SystemExit(run(parser.parse_args()))
