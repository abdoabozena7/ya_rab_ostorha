import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from backend.learning.recovery_budget import RecoveryBudget,active_ticket


class RecoveryBudgetTests(unittest.TestCase):
    def test_crashed_reservations_cannot_expand_new_six_hundred_second_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            b=RecoveryBudget(Path(directory)/'budget.sqlite')
            b.reserve('validation',600.)
            self.assertEqual(b.status()['hard_cap_s'],600.)
            self.assertEqual(b.status()['charged_s'],600.)
            with self.assertRaises(ValueError):b.reserve('validation',.1)
            with self.assertRaises(ValueError):b.reserve('training',1.)

    def test_a_file_alone_finished_reservation_or_forged_duration_cannot_authorize(self):
        with tempfile.TemporaryDirectory() as directory,patch('backend.learning.recovery_budget.ROOT',Path(directory)):
            root=Path(directory)/'output/congestion-recovery';root.mkdir(parents=True)
            gate=root/'validation-ticket.json';now=time.monotonic()
            ticket={'scope':'CONGESTION_RECOVERY_20261014','reservation_id':'missing',
                'started_monotonic_s':now,'expires_monotonic_s':now+10.}
            gate.write_text(json.dumps(ticket));self.assertIsNone(active_ticket())
            budget=RecoveryBudget(root/'budget.sqlite');reservation=budget.reserve('validation',10.)
            ticket.update(reservation_id=reservation[0],started_monotonic_s=reservation[1],expires_monotonic_s=reservation[1]+9.)
            gate.write_text(json.dumps(ticket));self.assertIsNotNone(active_ticket())
            ticket['expires_monotonic_s']=reservation[1]+11.;gate.write_text(json.dumps(ticket));self.assertIsNone(active_ticket())
            ticket['expires_monotonic_s']=reservation[1]+9.;gate.write_text(json.dumps(ticket));budget.finish(reservation)
            self.assertIsNone(active_ticket())


if __name__=='__main__':unittest.main()
