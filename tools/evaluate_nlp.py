"""Run semantic regression requests against the actual local model, not mocks."""
import json
import argparse
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend.threejs.nlp import interpret, MODEL_ID, ModelUnavailable

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases',default='tests/fixtures/nlp-eval.json')
    parser.add_argument('--report',default='output/nlp-evaluation.json')
    args=parser.parse_args()
    cases=json.loads((ROOT/args.cases).read_text(encoding='utf-8'))
    results=[]
    for case in cases:
        try:
            result=interpret(case['text'],case.get('environment','city'),case.get('history'))
            passed=result['action']==case['action'] and result['destination']==case['destination']
        except ModelUnavailable as error:
            result={'error':str(error)};passed=False
        row={'input':case,'result':result,'passed':passed};results.append(row)
        print(json.dumps(row,ensure_ascii=False),flush=True)
    report={'model':MODEL_ID,'passed':sum(r['passed'] for r in results),'total':len(results),'results':results}
    target=ROOT/args.report
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f"Passed {report['passed']}/{report['total']}")
    return 0 if all(r['passed'] for r in results) else 1

if __name__=='__main__':raise SystemExit(main())
