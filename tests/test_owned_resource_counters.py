import ctypes
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend.core.resources import process_resources, system_memory_status, wddm_process_engines


class OwnedGpuCounterTests(unittest.TestCase):
    def query(self, entries, pids=(41,)):
        result=SimpleNamespace(returncode=0,stdout=json.dumps(entries),stderr='')
        with patch('backend.core.resources.os.name','nt'),patch('backend.core.resources.subprocess.run',return_value=result):
            return wddm_process_engines(pids)

    def test_preserves_separate_engine_and_adapter_utilization_without_sum(self):
        entries=[{'Name':'pid_41_luid_0x00000000_0x0000F67F_phys_0_eng_0_engtype_3D','UtilizationPercentage':60},
                 {'Name':'pid_41_luid_0x00000000_0x0000F67F_phys_0_eng_1_engtype_Copy','UtilizationPercentage':30},
                 {'Name':'pid_41_luid_0x00000000_0x0000F619_phys_0_eng_0_engtype_3D','UtilizationPercentage':10}]
        actual=self.query(entries,(41,42))
        self.assertEqual(actual['status'],'MEASURED')
        self.assertEqual(actual['missingPids'],[42])
        self.assertEqual([row['utilization_percent'] for row in actual['processes'][0]['engines']],[60,30,10])
        self.assertNotIn('utilization_percent',actual['processes'][0])
        self.assertIn('NOT_SUMMED',actual['scope'])

    def test_empty_output_is_explicitly_unavailable_not_zero(self):
        actual=self.query([])
        self.assertEqual(actual['status'],'UNAVAILABLE')
        self.assertEqual(actual['missingPids'],[41])
        self.assertEqual(actual['processes'],[])

    def test_singleton_powershell_object_is_supported(self):
        actual=self.query({'Name':'pid_41_luid_0x0_0xFF_phys_0_eng_2_engtype_Copy','UtilizationPercentage':0})
        self.assertEqual(actual['status'],'MEASURED')
        self.assertEqual(actual['processes'][0]['engines'][0]['utilization_percent'],0)

    def test_identity_and_nonfinite_or_out_of_range_values_are_rejected(self):
        valid='pid_41_luid_0x0_0xFF_phys_0_eng_2_engtype_Copy'
        for name,value in ((valid,-1),(valid,101),(valid,True),(valid,float('nan')),
                           (valid,float('inf')),(valid,'30'),(valid.replace('pid_41_','pid_42_'),20),
                           ('pid_41_malformed',20)):
            with self.subTest(name=name,value=value),self.assertRaises(ValueError):
                self.query({'Name':name,'UtilizationPercentage':value})

    def test_bad_ids_are_rejected_before_starting_any_query(self):
        for ids in ((),(0,),(-1,),(True,),('41',)):
            with self.subTest(ids=ids),patch('backend.core.resources.os.name','nt'),self.assertRaises(ValueError):
                wddm_process_engines(ids)

    def test_command_is_owned_pid_filtered_and_failures_are_explicit(self):
        result=SimpleNamespace(returncode=1,stdout='',stderr='denied')
        with patch('backend.core.resources.os.name','nt'),patch('backend.core.resources.subprocess.run',return_value=result) as run:
            with self.assertRaisesRegex(OSError,'denied'):
                wddm_process_engines([41])
            self.assertIn("Name LIKE 'pid_41_%'",run.call_args.args[0][-1])
            self.assertEqual(run.call_args.kwargs['timeout'],10)

    def test_non_windows_is_not_reported_as_success(self):
        with patch('backend.core.resources.os.name','posix'),self.assertRaises(OSError):
            wddm_process_engines([41])
        with patch('backend.core.resources.os.name','posix'),self.assertRaises(OSError):
            system_memory_status()


@unittest.skipUnless(os.name=='nt','Windows native API only')
class RealOwnedProcessCounterTests(unittest.TestCase):
    def test_real_own_process_and_physical_commit_fields(self):
        actual=process_resources(os.getpid())
        self.assertEqual(actual['pid'],os.getpid())
        self.assertGreater(actual['working_set_mib'],0)
        self.assertGreaterEqual(actual['page_fault_count'],0)
        self.assertEqual(actual['page_fault_scope'],'SOFT_AND_HARD_CUMULATIVE')
        memory=system_memory_status()
        self.assertGreater(memory['physical_total_bytes'],0)
        self.assertGreaterEqual(memory['physical_available_bytes'],0)
        self.assertLessEqual(memory['physical_available_bytes'],memory['physical_total_bytes'])
        self.assertGreaterEqual(memory['commit_limit_bytes'],memory['physical_total_bytes'])
        self.assertLessEqual(memory['commit_available_bytes'],memory['commit_limit_bytes'])


if __name__=='__main__':
    unittest.main()
