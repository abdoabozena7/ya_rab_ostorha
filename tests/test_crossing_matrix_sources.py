import copy
import unittest
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile
from scripts.native.validate_crossing_matrix import same_case_sources
from scripts.crossing_user_acceptance import source_compatible_with_matrix


class MatrixSourceTests(unittest.TestCase):
    def test_matrix_review_verifies_archives_and_only_permits_other_fixture_edits(self):
        old={'revision':17,'map':'T','variants':[{'id':'A','start_s':4.7},{'id':'B','start_s':4.6}]}
        new=copy.deepcopy(old);new['variants'][1]['waiting_yaw_offset_deg']=180
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);archive=folder/'source.zip'
            with zipfile.ZipFile(archive,'w') as z:z.writestr('config/crossing-comparison.json',json.dumps(old))
            raw=json.dumps(new).encode();(folder/'scenario-catalogue.json').write_bytes(raw)
            hashes={'backend/core/service.py':'same','config/crossing-comparison.json':'old'}
            report={'seed':0,'source_hashes':hashes,'source_archive':{'path':str(archive),
                'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}}
            matrix={'source_hashes':{**hashes,'config/crossing-comparison.json':hashlib.sha256(raw).hexdigest()},
                'scenario_catalogue_file':'scenario-catalogue.json'}
            self.assertTrue(source_compatible_with_matrix(report,matrix,folder))
            self.assertFalse(source_compatible_with_matrix({**report,'seed':1},matrix,folder))
            changed=copy.deepcopy(matrix);changed['source_hashes']['backend/core/service.py']='different'
            self.assertFalse(source_compatible_with_matrix(report,changed,folder))
            (folder/'scenario-catalogue.json').write_bytes(b'corrupt')
            self.assertFalse(source_compatible_with_matrix(report,matrix,folder))
            archive.write_bytes(b'corrupt')
            self.assertFalse(source_compatible_with_matrix(report,{'source_hashes':hashes},folder))

    def test_reuse_keeps_control_code_and_the_exact_selected_fixture_strict(self):
        old={'protocol':'P','revision':12,'map':'T','spawn_index':152,'variants':[
            {'id':'A','start_s':4.7,'validated':False},{'id':'B','start_s':5.,'validated':False}]}
        new=copy.deepcopy(old);new['variants'][1]['start_s']=4.55
        hashes={'backend/core/service.py':'same','config/crossing-comparison.json':'old'}
        current={**hashes,'config/crossing-comparison.json':'new'}
        report={'seed':0,'source_hashes':hashes}
        self.assertTrue(same_case_sources(report,current,old,new))
        self.assertFalse(same_case_sources({**report,'seed':1},current,old,new))
        self.assertFalse(same_case_sources(report,{**current,'backend/core/service.py':'changed'},old,new))
        self.assertFalse(same_case_sources(report,{**current,'backend/new.py':'added'},old,new))
        for field,value in [('map','OTHER'),('spawn_index',1),('revision',13)]:
            changed=copy.deepcopy(new);changed[field]=value
            self.assertFalse(same_case_sources(report,current,old,changed))
        annotated=copy.deepcopy(old);annotated['variants'][0]['validated']=True
        self.assertTrue(same_case_sources(report,current,old,annotated))
