import copy
import unittest
import chaos_probe as chaos


def parking_row():
    cars=[]
    for i in range(5):
        x=8+i*15;inner=1.35+i*.12
        cars.extend([{'side':'LEFT','exists':True,'along_min_m':x-2,'along_max_m':x+2,'lateral_min_m':-3.5,'lateral_max_m':-inner},
                     {'side':'RIGHT','exists':True,'along_min_m':x-2,'along_max_m':x+2,'lateral_min_m':inner,'lateral_max_m':3.5}])
    return {'ego_width_m':1.8,'road_band_m':6.5,'parked':cars}


class ChaosControls(unittest.TestCase):
    def test_parked_barrier_is_not_passable(self):
        row=parking_row()
        for car in row['parked']:
            if car['side']=='LEFT':car['lateral_max_m']=-.5
            else:car['lateral_min_m']=.5
        self.assertFalse(chaos.parking_summary([row])['accepted'])
    def test_missing_or_one_sided_parked_vehicles_fail(self):
        row=parking_row();row['parked'].pop()
        self.assertFalse(chaos.parking_summary([row])['accepted'])
        row=parking_row()
        for car in row['parked']:car['side']='LEFT'
        self.assertFalse(chaos.parking_summary([row])['accepted'])
    def test_real_bounded_varying_clearance_meets_geometry_oracle(self):
        self.assertTrue(chaos.parking_summary([parking_row()])['accepted'])
    def test_nonfinite_gap_does_not_qualify(self):
        row=parking_row();row['road_band_m']=float('nan')
        self.assertFalse(chaos.parking_summary([row])['accepted'])
    def test_assigned_tasks_do_not_count_as_crossings(self):
        events=[{'entity':i,'event':'TASK_ASSIGNED','direction':'LEFT_TO_RIGHT'} for i in range(24)]
        population=[{'host_ms':i*1000,'road_crossers':0} for i in range(12)]
        r=chaos.crossing_summary(events,population)
        self.assertFalse(r['accepted']);self.assertEqual(r['completed_crossings'],0)
    def test_one_direction_or_zero_elapsed_road_samples_fail(self):
        events=[{'entity':i,'event':'ENTERED_ROAD','direction':'LEFT_TO_RIGHT'} for i in range(8)]
        events.extend({'entity':i,'event':'COMPLETED','direction':'LEFT_TO_RIGHT'} for i in range(8))
        population=[{'host_ms':0,'road_crossers':5} for _ in range(12)]
        self.assertFalse(chaos.crossing_summary(events,population)['accepted'])
    def test_actual_entries_bidirectional_completions_and_elapsed_occupancy(self):
        events=[{'entity':i,'event':'ENTERED_ROAD','direction':'LEFT_TO_RIGHT'} for i in range(8)]
        events.extend({'entity':i,'event':'COMPLETED','direction':('LEFT_TO_RIGHT' if i%2 else 'RIGHT_TO_LEFT')} for i in range(8))
        population=[{'host_ms':i*1000,'road_crossers':3} for i in range(10)]
        self.assertTrue(chaos.crossing_summary(events,population)['accepted'])


if __name__=='__main__':unittest.main()
