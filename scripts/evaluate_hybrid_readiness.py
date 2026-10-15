"""Publish missing/failed native gates without promoting diagnostic trials."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
from backend.core.hybrid_acceptance import validate
from backend.core.hybrid_config import configuration,source_fingerprint

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--results',help='Frozen native acceptance-case evidence, separate from diagnostic reports')
    parser.add_argument('--output',default='docs/evidence/hybrid_driving/acceptance.json')
    args=parser.parse_args();config=configuration();fingerprint=source_fingerprint()
    results=json.loads(Path(args.results).read_text(encoding='utf8')) if args.results else {'cases':[]}
    results['source_hash_verified']=(results.get('source_hash_verified') is True
                                    and results.get('source_fingerprint')==fingerprint)
    report=validate(config,results)
    report.update(version=1,generated_at_utc=datetime.now(timezone.utc).isoformat(),
        scope='FROZEN_NATIVE_ACCEPTANCE_ONLY_DIAGNOSTICS_ARE_NOT_A_COHORT',
        source_fingerprint=fingerprint,accepted_speed_kmh=config['requested_maximum_kmh'] if report['accepted'] else 0,
        native_results_source=str(Path(args.results).resolve()) if args.results else None,
        diagnostic_index='docs/evidence/hybrid_driving/diagnostics.json',
        explanation='Missing native evidence stays missing. Source-changing diagnostics and isolated browser fixtures do not satisfy these gates.')
    output=ROOT/args.output;output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf8')
    print(json.dumps({'accepted':report['accepted'],'passed_gates':sum(report['gates'].values()),
                      'required_gates':len(report['gates']),'output':str(output)}))
    return 0 if report['accepted'] else 1


if __name__=='__main__':raise SystemExit(main())
