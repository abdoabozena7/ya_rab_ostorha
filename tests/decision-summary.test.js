import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionSummary} from '../frontend/prediction-view.js';

test('decision readout is empty without an active evaluation layer',()=>{
  assert.equal(decisionSummary(null),'');
  assert.equal(decisionSummary({decision_layer:null,evidence_decision:null,status:'BRAKING'}),'');
});

test('decision readout shows only published values and labels experimental risk',()=>{
  const safety={decision_layer:'EVIDENCE_BUDGETED',evidence_decision:{layer:'EVIDENCE_BUDGETED_PEDESTRIAN_V1',
    response:'CAUTIOUS_APPROACH',target_speed_mps:5,reason:'Bounded approach at the highest verified speed',
    people:[{risk_3s:.42,uncertainty_m:.25},{uncertainty_m:.3}],risk_status:{status:'READY',experimental:true}}};
  const text=decisionSummary(safety);
  assert.match(text,/Evidence budget · cautious approach · limit 18 km\/h/);
  assert.match(text,/crossing risk within 3 s 42% \(experimental model\)/);
  assert.match(text,/tracking ±0\.30 m/);
  safety.evidence_decision.risk_status={status:'NO_ADMITTED_OR_EXPERIMENTAL_MODEL'};
  assert.doesNotMatch(decisionSummary(safety),/crossing risk/);
  delete safety.evidence_decision.target_speed_mps;safety.evidence_decision.people=[];
  assert.doesNotMatch(decisionSummary(safety),/limit|tracking/);
});
