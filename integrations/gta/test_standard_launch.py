import unittest
import standard_launch as launch
import winreg


class OrdinaryControls(unittest.TestCase):
    def test_foreign_target_is_not_owner_game(self):
        with self.assertRaises(ValueError):launch.exact_entry({r'C:\other\PlayGTAV.exe':('RUNASADMIN',winreg.REG_SZ)})
    def test_mixed_or_changed_flags_are_not_removed(self):
        for value in ('HIGHDPIAWARE','RUNASADMIN HIGHDPIAWARE'):
            with self.assertRaises(ValueError):launch.exact_entry({str(launch.LAUNCHER):(value,winreg.REG_SZ)})
    def test_wrong_registry_type_is_rejected(self):
        with self.assertRaises(ValueError):launch.exact_entry({str(launch.LAUNCHER):('RUNASADMIN',winreg.REG_EXPAND_SZ)})
    def test_elevated_or_unobserved_token_does_not_qualify(self):
        result=dict(bootstrap_verified=True,cleanup_confirmed=True,files_restored=True,protected_inputs_unchanged=True,owned_game_pid=7)
        self.assertFalse(launch.qualified(result,{7:True}));self.assertFalse(launch.qualified(result,{}))
        self.assertFalse(launch.qualified(result,{7:None}))


if __name__=='__main__':unittest.main()
