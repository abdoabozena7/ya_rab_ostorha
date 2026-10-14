"""Bound the final read-only browser verification in the independent ledger."""
import json
import time
from .validate_congestion_recovery import OUT,write
from backend.learning.recovery_budget import RecoveryBudget


def main():
    budget=RecoveryBudget();r=budget.reserve('validation',55.)
    marker=OUT/'ui-done.json';marker.unlink(missing_ok=True)
    report={}
    try:
        print('UI_RESERVATION_OPEN',flush=True)
        while time.monotonic()<r[1]+52. and not marker.exists():time.sleep(.25)
        report['ui']=json.loads(marker.read_text()) if marker.exists() else {'passed':False,'reason':'Verification deadline'}
    finally:
        report['elapsed_s']=budget.finish(r);report['budget']=budget.status();write('final-ui.json',report)
        print(json.dumps(report),flush=True)


if __name__=='__main__':main()
