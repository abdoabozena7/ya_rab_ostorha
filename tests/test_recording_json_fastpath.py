from dataclasses import dataclass
from enum import IntEnum, Enum
import json
import math
from types import MappingProxyType
import unittest
from unittest.mock import patch

from backend.core.contracts import freeze_json
from backend.core.recording import _json_default, _json_text, encode_row, queued_snapshot


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)


class RecordingJsonFastPathTests(unittest.TestCase):
    def test_numeric_queue_charge_keeps_exact_frozen_identity_and_bound(self):
        value=freeze_json([1.,2,True,False,None,-0.])
        owned,size=queued_snapshot(value)
        self.assertIs(owned,value)
        self.assertEqual(size,64+80*len(value))

    def test_queue_dispatch_preserves_scalar_subclasses_and_baseline_rejection(self):
        class Float(float):
            pass
        value=freeze_json([Float(.1),1.])
        owned,size=queued_snapshot(value)
        self.assertIs(owned,value)
        self.assertEqual(size,64+80*len(value))
        self.assertIs(type(owned[0]),Float)
        class Meta(type):
            __hash__=None
        class UnhashableFloat(float,metaclass=Meta):
            pass
        invalid=freeze_json([UnhashableFloat(.1),1.])
        with self.assertRaises(TypeError):
            queued_snapshot(invalid)

    def test_mutable_queue_ownership_and_non_numeric_charges_are_not_bypassed(self):
        original={'values':([{'text':['word']}],),'prediction':freeze_json({'values':[.1,.2]})}
        owned,size=queued_snapshot(original)
        original['values'][0][0]['text'].append('changed')
        self.assertEqual(owned['values'][0][0]['text'],['word'])
        self.assertIs(owned['prediction'],original['prediction'])
        self.assertGreater(size,0)
        text=freeze_json(['word'])
        copied,charge=queued_snapshot(text)
        self.assertIs(copied,text)
        self.assertEqual(charge,64+(64+len('word')*6)+16)

    def test_exact_frozen_values_preserve_all_fields_types_and_precision(self):
        source={'nested':[[.1,-0.,1.2345678901234567,1e-120,1e120]],
                'integer':10**100,'negative_integer':-10**100,'flags':[True,False,None],
                'text':'ASCII and \u03c0 / escaped\ntext','empty':{},'empty_sequence':[]}
        frozen=freeze_json(source)
        expected=json.dumps(frozen,default=_json_default,allow_nan=False,separators=(',',':'))
        actual=_json_text(frozen)
        self.assertIsInstance(actual,str)
        self.assertEqual(canonical(json.loads(actual)),canonical(json.loads(expected)))
        self.assertIs(type(json.loads(actual)['integer']),int)
        self.assertEqual(math.copysign(1.,json.loads(actual)['nested'][0][1]),-1.)
        self.assertEqual(json.loads(encode_row(frozen)),source)

    def test_only_exact_internal_roots_use_the_fast_encoder(self):
        with patch('ujson.dumps',wraps=__import__('ujson').dumps) as fast:
            for value in ({'nested':[1.,2.]},MappingProxyType({'nested':[1.,2.]}),({'nested':[1.]},)):
                self.assertEqual(json.loads(_json_text(value)),
                                 json.loads(json.dumps(value,default=_json_default,separators=(',',':'))))
            fast.assert_not_called()
            _json_text(freeze_json({'nested':[1.,2.]}))
            _json_text(freeze_json([1.,2.]))
            self.assertEqual(fast.call_count,2)
            for call in fast.call_args_list:
                self.assertFalse(call.kwargs['allow_nan'])
                self.assertTrue(call.kwargs['reject_bytes'])

    def test_invalid_values_are_not_replaced_or_silently_encoded(self):
        for value in (float('nan'),float('inf'),-float('inf'),b'raw'):
            with self.subTest(value=value),self.assertRaises((ValueError,TypeError)):
                freeze_json({'invalid':value})
            with self.subTest(raw=value),self.assertRaises((ValueError,TypeError)):
                _json_text({'invalid':value})
        cycle=[];cycle.append(cycle)
        with self.assertRaises((ValueError,RecursionError)):
            _json_text(cycle)

    def test_enum_and_scalar_subclasses_remain_semantically_identical(self):
        class Number(IntEnum):
            ONE=1
        class Text(str,Enum):
            NAME='value'
        class Float(float):
            pass
        class String(str):
            pass
        data={String('key'):[Number.ONE,Text.NAME,Float(.1),String('text')]}
        frozen=freeze_json(data)
        expected=json.dumps(frozen,default=_json_default,allow_nan=False,separators=(',',':'))
        self.assertEqual(canonical(json.loads(_json_text(frozen))),canonical(json.loads(expected)))

    def test_dataclass_and_public_input_path_is_unchanged(self):
        @dataclass
        class Packet:
            value:float
            nested:object
        value=Packet(1.25,freeze_json({'values':[.1,.2]}))
        expected=json.dumps(value,default=_json_default,allow_nan=False,separators=(',',':'))
        self.assertEqual(_json_text(value),expected)


if __name__=='__main__':
    unittest.main()
