"""Isolated Egypt development and frozen one-shot acceptance. Preflight is read-only."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import time
from types import SimpleNamespace
import uuid

from backend.core.egypt_urban import (
    ROOT, SCENARIO_ID, ACCEPTANCE, acceptance_matrix, configuration, evaluate_matrix,
    publication_gates, source_fingerprint, source_manifest,
)
from backend.learning.egypt_budget import (
    DIRECTORY, PROGRESS, EgyptBudget, remaining_seconds, save_json,
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
    if development_seed is not None and development_seed not in config['development_seeds']:
        raise ValueError('Development uses only declared non-holdout seeds')
    return ([{'seed': development_seed, 'first_mode': first}] if development_seed is not None else
            [{'seed': seed, 'first_mode': mode} for seed in config['development_seeds']
             for mode in ('NORMAL', 'ROBOSPHERE')])


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


def preflight(plan, seconds_per_pair, status, *, acceptance=False):
    if type(seconds_per_pair) not in (int, float) or not 180. <= seconds_per_pair <= 1800.:
        raise ValueError('Use an identified 180--1800 second reservation per complete pair')
    cleanup = len(plan) * 300.
    required = len(plan) * seconds_per_pair + cleanup
    remaining = min(status['remaining_s'], status.get(
        'acceptance_remaining_s' if acceptance else 'development_remaining_s', status['remaining_s']))
    ready = bool(status.get('authorized') and status.get('unfinished') == 0 and remaining >= required
                 and not (acceptance and status.get('acceptance_attempted')))
    return {'scenario_id': SCENARIO_ID, 'source': 'READ_ONLY_NATIVE_AUTHORIZATION_PREFLIGHT',
            'can_run': ready, 'native_acceptance': False, 'engine_started': False,
            'reason': 'Authorized phase can cover the requested matrix' if ready else
                'Frozen acceptance was already attempted; no retries or automatic extension' if acceptance and status.get('acceptance_attempted') else
                'Unfinished reservation remains crash-charged; inspect retained evidence and cleanup' if status.get('unfinished') else
                'Pending: authorized phase cannot cover this matrix; no allowance was reset or extended',
            'required_reservation_s': required, 'planned_pairs': plan, 'planned_trips': len(plan) * 2,
            'cleanup_reservation_s': cleanup,
            'budget_before': status}


def compact_pair(pair):
    result = {k: v for k, v in pair.items() if k in ('version', 'order', 'conditions_match', 'manifest', 'runs', 'scenario_validation')}
    result['manifest'] = {k: v for k, v in (result.get('manifest') or {}).items() if k != 'initial_conditions'}
    result['runs'] = {mode: {**run, 'setup': {k: v for k, v in (run.get('setup') or {}).items() if k != 'initial_conditions'}}
                      for mode, run in (result.get('runs') or {}).items()}
    return result


def write_report(path, report):
    save_json(path, report)


def save_current_and_shutdown(folder, deadline):
    """Use the dashboard's recording/SDK/engine shutdown, never kill its live attempt."""
    from scripts.final_runtime import state
    from backend.carla.runtime import native_processes
    shutdown_deadline = min(deadline, time.monotonic() + 150.)
    current = state()
    save_json(folder / 'before-validation.json', {'source': 'PRE_VALIDATION_DASHBOARD_SNAPSHOT', 'state': current})
    if current and current.get('simulatorStart', {}).get('status') == 'STARTING':
        raise RuntimeError('Wait for the in-flight dashboard startup before validation')
    if current and current.get('connected'):
        from websockets.sync.client import connect
        from websockets.exceptions import ConnectionClosed
        try:
            command_deadline = min(shutdown_deadline, time.monotonic() + 30.)
            with connect('ws://127.0.0.1:8001', open_timeout=remaining_seconds(command_deadline, 10)) as ws:
                ws.recv(timeout=remaining_seconds(command_deadline, 10))
                ws.send(json.dumps({'type': 'stop_simulator', 'sequence': 1}))
                while True:
                    reply = json.loads(ws.recv(timeout=remaining_seconds(command_deadline, 20)))
                    if reply.get('type') == 'error':
                        raise RuntimeError(reply['error'])
                    if reply.get('acknowledged', 0) >= 1:
                        break
        except ConnectionClosed as error:
            save_json(folder / 'shutdown-socket.json', {'closed_during_normal_handoff': str(error)})
    elif native_processes(timeout=remaining_seconds(deadline, 15)) and not (
            current and current.get('simulatorStop', {}).get('status') == 'STOPPING'):
        raise RuntimeError('An unowned CARLA engine is running; normal dashboard shutdown is required')
    while True:
        processes = native_processes(timeout=remaining_seconds(shutdown_deadline, 15))
        current = state()
        if not processes and (not current or not current.get('connected') and
                current.get('simulatorStop', {}).get('status') != 'STOPPING'):
            save_json(folder / 'shutdown-complete.json', {'native_processes': [], 'dashboard': current})
            return
        if current and current.get('simulatorStop', {}).get('status') == 'FAILED':
            raise RuntimeError('Normal CARLA shutdown failed: ' + str(current['simulatorStop']))
        remaining_seconds(shutdown_deadline, 1.)
        time.sleep(.5)


def completed_trips(pairs):
    return sum(run.get('status') not in (None, 'RUNNING') for item in pairs
               for run in item.get('pair', {}).get('runs', {}).values())


def failed_pair_gates(item):
    from backend.core.egypt_urban import evaluate_pair
    gates = evaluate_pair(item.get('pair', {}))['gates']
    failures = [name for name, passed in gates.items() if not passed]
    for name in ('completed_without_shortening', 'finish_completed', 'exports_closed', 'cleanup_confirmed',
                 'simulator_exit_confirmed', 'source_unchanged', 'attempts_retained'):
        if item.get(name) is not True:
            failures.append(name)
    for name in ('independent_cleanup_probe', 'video_playback_after_exit'):
        if item.get(name, {}).get('passed') is not True:
            failures.append(name)
    if item.get('native_acceptance') is not True:
        failures.append('native_pair_acceptance')
    for key in ('error', 'finalization_error', 'cleanup_error'):
        if item.get(key):
            failures.append(key + ': ' + str(item[key]))
    if item.get('preparation_failure'):
        failures.append('preparation: ' + str(item['preparation_failure'].get('message')))
    for mode, run in item.get('pair', {}).get('runs', {}).items():
        if run.get('status') == 'ERROR':
            failures.append(mode + ': ' + str(run.get('reason') or 'Native drive failed'))
    for failure in item.get('drive_failures', []):
        detail = (failure.get('fault') or {}).get('message') or failure.get('reason')
        if detail:
            failures.append(str(failure.get('mode')) + ': ' + str(detail))
    stop = item.get('drive_stop') or {}
    if stop.get('status') == 'ERROR' and stop.get('detail') and stop['detail'] != stop.get('reason'):
        failures.append('drive: ' + str(stop['detail']))
    return [f"{item['seed']}/{item['first_mode']}: {name}" for name in failures]


def development_record(budget, fingerprint):
    path = budget.directory / 'development.json'
    if not path.exists():
        return {'source_sha256': fingerprint, 'pairs': []}
    record = json.loads(path.read_text(encoding='utf8'))
    return record if record.get('source_sha256') == fingerprint else {'source_sha256': fingerprint, 'pairs': []}


def publish_progress(report, target, *, current=None):
    progress = {'state': report['state'], 'phase': report['phase'], 'scenario_id': SCENARIO_ID,
                'source_sha256': report['source_sha256'], 'report': str(target),
                'completed_trips': completed_trips(report.get('pairs', [])) + report.get('partial_completed_trips', 0) + (
                    completed_trips([{'pair': current}]) if current else 0),
                'total_trips': 12, 'failed_gates': report.get('failed_gates', []),
                'error': report.get('error'), 'updated_at_utc': datetime.now(timezone.utc).isoformat()}
    save_json(PROGRESS, progress)


def run(args):
    if getattr(args, 'allocate_egypt_budget', False):
        if args.run or args.acceptance or args.rule_ticket:
            raise ValueError('Allocate the separate allowance without running native work or using a RULE ticket')
        budget = EgyptBudget.create(args.egypt_budget or DIRECTORY)
        print(json.dumps({'allocated': budget.status(), 'engine_started': False}))
        return 0
    plan = matrix_plan(acceptance=args.acceptance, development_seed=args.development_seed, first=args.first)
    if args.render_profile != 'LOW' or args.acceptance and args.seconds_per_pair != 900.:
        raise ValueError('Egypt uses Town10/LOW; frozen acceptance reserves 900 + 300 seconds per pair')
    if getattr(args, 'egypt_budget', None) and args.rule_ticket:
        raise ValueError('Egypt and RULE authorizations are isolated, not combined')
    budget = EgyptBudget(args.egypt_budget) if getattr(args, 'egypt_budget', None) else None
    before = budget.status() if budget else existing_budget_status(args.rule_ticket)
    report = preflight(plan, args.seconds_per_pair, before, acceptance=args.acceptance)
    fingerprint = source_fingerprint()
    development = development_record(budget, fingerprint) if budget else {'pairs': [], 'source_sha256': fingerprint}
    development_ready = evaluate_matrix(development['pairs'], fingerprint, acceptance=False)['passed']
    if not budget or args.acceptance and not development_ready:
        report.update(can_run=False, reason='Separate --egypt-budget required' if not budget else
                      'Full current-source development matrix must pass before the protected acceptance window can be used')
    report.update(created_at_utc=datetime.now(timezone.utc).isoformat(), source_sha256=fingerprint,
                  source_manifest=source_manifest(), phase='ACCEPTANCE' if args.acceptance else 'DEVELOPMENT',
                  state='PENDING', accepted=False, development_passed=False, pairs=[],
                  development=development if args.acceptance else None)
    target = Path(args.report) if args.report else ROOT / 'output' / 'egypt-urban-chaos' / (uuid.uuid4().hex + '.json')
    write_report(target, report)
    if not args.run or not report['can_run']:
        report['budget_after'] = budget.status() if budget else existing_budget_status(args.rule_ticket)
        report['authorization_unchanged'] = before.get('sha256') == report['budget_after'].get('sha256')
        write_report(target, report)
        print(json.dumps({'report': str(target), 'can_run': report['can_run'], 'reason': report['reason']}))
        return 2 if args.run and not report['can_run'] else 0
    report['engine_started'] = None
    interrupted = False
    active_attempt = None
    try:
        with budget.experiment(report['phase'], report['required_reservation_s'], target) as ticket:
            report.update(state='RUNNING', reservation={**ticket})
            write_report(target, report)
            publish_progress(report, target)
            save_current_and_shutdown(target.parent / (target.stem + '-handoff'), ticket['expires_monotonic_s'])
            budget.activate(ticket)
            from .validate_crossing_pair import run as run_pair
            for item in plan:
                if source_fingerprint() != fingerprint:
                    raise RuntimeError('Frozen source changed; remaining holdout trips are pending, not retried')
                budget.claim_attempt(ticket, item['seed'], item['first_mode'], fingerprint)
                deadline = min(ticket['expires_monotonic_s'], time.monotonic() + args.seconds_per_pair + 300.)
                options = SimpleNamespace(seed=item['seed'], first=item['first_mode'], seconds=args.seconds_per_pair,
                    render_profile='LOW', scenario=SCENARIO_ID, rule_ticket=None, holdout_acceptance=args.acceptance,
                    egypt_budget=str(budget.directory), egypt_reservation=ticket['reservation_id'], egypt_deadline=deadline,
                    on_progress=lambda pair: publish_progress(report, target, current=pair))
                active_attempt = options
                ticket['cleanup_verified'] = False
                run_pair(options)
                folder = options.report_folder
                raw = json.loads((folder / 'report.json').read_text(encoding='utf8'))
                ticket['cleanup_verified'] = raw.get('simulator_exit_confirmed') is True
                if raw.get('render_profile'):
                    report['engine_started'] = True
                report['pairs'].append({key: raw.get(key) for key in ('seed', 'first_mode', 'source', 'source_sha256',
                    'source_unchanged', 'attempts_retained', 'native_acceptance', 'completed_without_shortening',
                    'finish_completed', 'exports_closed', 'cleanup_confirmed', 'simulator_exit_confirmed',
                    'independent_cleanup_probe', 'video_playback_after_exit', 'render_profile', 'error',
                    'finalization_error', 'cleanup_error', 'worker_deadline_expired', 'native_worker_exit_code')})
                report['pairs'][-1].update(pair=compact_pair(raw.get('pair') or {'manifest': {}, 'runs': {}}),
                    preparation_failure=(raw.get('presentation') or {}).get('failure'),
                    drive_failures=(raw.get('presentation') or {}).get('failures') or [],
                    drive_stop=raw.get('last_drive_stop'),
                    report=str(folder / 'report.json'), report_sha256=hashlib.sha256((folder / 'report.json').read_bytes()).hexdigest())
                write_report(target, report)
                budget.finish_attempt(ticket, item['seed'], item['first_mode'], raw.get('native_acceptance') is True, folder / 'report.json')
                report['failed_gates'] = [gate for pair in report['pairs'] for gate in failed_pair_gates(pair)]
                publish_progress(report, target)
                active_attempt = None
    except KeyboardInterrupt:
        interrupted = True
        report['error'] = 'Interrupted; all reservations, raw attempts and checkpoints are retained'
    except (OSError, ValueError, RuntimeError, TimeoutError, sqlite3.Error, subprocess.SubprocessError) as error:
        report['error'] = str(error)
    finally:
        if active_attempt is not None and getattr(active_attempt, 'report_folder', None):
            partial = active_attempt.report_folder / 'report.json'
            report['interrupted_attempt'] = {'seed': active_attempt.seed, 'first_mode': active_attempt.first,
                                             'report': str(partial), 'report_exists': partial.is_file()}
            if partial.is_file() and not any(pair.get('report') == str(partial) for pair in report['pairs']):
                try:
                    saved = json.loads(partial.read_text(encoding='utf8'))
                    if not isinstance(saved, dict):
                        raise ValueError('Expected an interrupted worker report object')
                    report['partial_completed_trips'] = completed_trips([saved])
                except (OSError, ValueError) as error:
                    report['interrupted_attempt']['read_error'] = str(error)
            budget.finish_attempt(ticket, active_attempt.seed, active_attempt.first, False, partial)
        report['budget_after'] = budget.status()
        report['source_unchanged'] = source_fingerprint() == fingerprint
        report['failed_gates'] = [gate for pair in report['pairs'] for gate in failed_pair_gates(pair)]
        if not report['source_unchanged']:
            report['failed_gates'].append('frozen_source')
        if args.acceptance:
            assessment = acceptance_matrix(report['pairs'], fingerprint)
            gates = {**assessment['gates'], **publication_gates(report, fingerprint)}
            report.update(accepted=all(gates.values()) and not report.get('error'), gates=gates)
            report['failed_gates'].extend(name for name, passed in gates.items() if not passed)
        else:
            report['development_passed'] = bool(report['pairs']) and not report.get('error') and report['source_unchanged'] and all(
                pair.get('native_acceptance') is True for pair in report['pairs'])
            latest = {(pair['seed'], pair['first_mode']): pair for pair in [*development['pairs'], *report['pairs']]}
            development = {'source_sha256': fingerprint, 'pairs': list(latest.values())}
            report['development_matrix_passed'] = evaluate_matrix(development['pairs'], fingerprint, acceptance=False)['passed']
            save_json(budget.directory / 'development.json', development)
        report['state'] = ('INTERRUPTED' if interrupted else 'ACCEPTED' if report['accepted'] else
                           'DEVELOPMENT_PASSED' if report['development_passed'] else 'FAILED')
        report['native_acceptance'] = report['accepted']
        if report.get('error'):
            report['failed_gates'].append('runner_completed_within_reservation')
        write_report(target, report)
        if report['accepted']:
            write_report(ACCEPTANCE, report)
        publish_progress(report, target)
    print(json.dumps({'report': str(target), 'accepted': report['accepted'],
                      'development_passed': report['development_passed'], 'failed_gates': report['failed_gates'],
                      'error': report.get('error')}))
    return 130 if interrupted else 0 if report['accepted'] or report['development_passed'] else 1


def parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Execute with the separate Egypt allowance; otherwise read-only preflight')
    parser.add_argument('--egypt-budget', help='Directory of the separately allocated Egypt ledger')
    parser.add_argument('--allocate-egypt-budget', action='store_true', help='Allocate once, without starting native work or a reservation')
    parser.add_argument('--acceptance', action='store_true', help='Reserved three seeds, both orders, no retries')
    parser.add_argument('--development-seed', type=int)
    parser.add_argument('--first', choices=('NORMAL', 'ROBOSPHERE'), default='NORMAL')
    parser.add_argument('--seconds-per-pair', type=float, default=900.)
    parser.add_argument('--rule-ticket', help='Read-only inspection of an existing RULE ticket; never funds Egypt execution')
    parser.add_argument('--render-profile', choices=('LOW',), default='LOW')
    parser.add_argument('--report')
    return parser


if __name__ == '__main__':
    raise SystemExit(run(parser().parse_args()))
