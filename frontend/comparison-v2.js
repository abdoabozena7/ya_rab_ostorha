import {showWorkspace} from './presentation-ui.js';
export const comparisonV2Busy = state => ['QUEUED','RESETTING','RUNNING','STOPPING'].includes(state?.phase);

export function comparisonStartBlocked(provider) {
  if (provider.isReplay) return 'Replay is read only.';
  if (!provider.fresh) return 'Connect CARLA to start a journey.';
  if (provider.restarting) return 'Wait for the simulator restart.';
  if (provider.controlMode === 'EMERGENCY_STOP') return 'Acknowledge the emergency stop first.';
  if (!provider.comparisonV2) return 'This backend does not provide the RULE journey.';
  if (comparisonV2Busy(provider.comparisonV2) || comparisonV2Busy(provider.comparisonDemo)) return 'A recorded run is active. Stop it before starting another.';
  if (provider.trafficPreparation && !['IDLE','READY'].includes(provider.trafficPreparation.status)) return 'Finish traffic preparation first.';
  const budget = provider.comparisonV2.budget;
  if (!Number.isFinite(budget?.remaining_s) || !Number.isFinite(budget?.recommended_run_allowance_s)) return 'Restart the dashboard backend to verify the experiment allowance.';
  if (budget.remaining_s < budget.recommended_run_allowance_s) return `Experiment budget: ${budget.remaining_s.toFixed(1)} s remain; a journey needs a ${budget.recommended_run_allowance_s.toFixed(0)} s allowance. Review saved results.`;
  return '';
}

export function installComparisonV2(provider, stopManual) {
  const legacy = document.querySelector('.comparison-demo');
  const box = document.createElement('section'); box.className = 'comparison-v2';
  box.setAttribute('aria-labelledby','journeyControlsTitle');
  box.innerHTML = '<h3 id="journeyControlsTitle">Recorded journey</h3><div class="comparison-actions"><button id="ruleDrivingBtn" class="primary">Rules driving</button><button id="modelDrivingBtn" aria-label="YA RAB OSTORHA Model · experimental">Model <span>experimental</span></button><button id="comparisonV2StopBtn">Stop journey</button></div><p id="comparisonV2Status" role="status"></p><p id="comparisonV2Results" class="muted"></p><button id="journeyResultsBtn">Review recorded journey</button>';
  document.querySelector('.drive-actions').after(box);
  const details = document.createElement('details'); details.innerHTML = '<summary>Historical safety comparison</summary>'; legacy.before(details); details.append(legacy);
  let pending = null;
  for (const [id,side] of [['ruleDrivingBtn','RULE'],['modelDrivingBtn','MODEL']]) {
    document.getElementById(id).onclick = () => {
      if (pending || comparisonStartBlocked(provider) || side === 'MODEL' && !provider.comparisonV2?.model_available) return;
      stopManual();
      if (provider.dashboardAction('comparison_v2',{operation:'RUN',side})) {
        pending = {sequence:provider.sequence, session:provider.sessionId, side}; update();showWorkspace('drive');
      }
    };
  }
  document.getElementById('comparisonV2StopBtn').onclick = () => provider.stopDriving('comparison_v2_stop');
  document.getElementById('journeyResultsBtn').onclick = () => document.getElementById('resultsTab').click();
  function update() {
    const state = provider.comparisonV2, busy = comparisonV2Busy(state);
    if (pending && (provider.operationError || pending.session !== provider.sessionId || !provider.fresh || busy || !provider.pending.has(pending.sequence))) pending = null;
    const reason = pending ? 'Starting recorded journey…' : comparisonStartBlocked(provider);
    for (const id of ['ruleDrivingBtn','modelDrivingBtn']) {
      document.getElementById(id).disabled = !!reason;
      document.getElementById(id).title = reason;
    }
    document.getElementById('modelDrivingBtn').disabled ||= !state?.model_available;
    if (!state?.model_available) document.getElementById('modelDrivingBtn').title = state?.budget?.scope==='NATIVE_RULE_VALIDATION' ? 'This separately authorized validation session permits RULE only. MODEL remains experimental.' : 'Experimental model weights are unavailable.';
    document.getElementById('comparisonV2StopBtn').disabled = !(busy || pending) || !provider.controller || !provider.fresh || provider.restarting;
    const pair = state?.pair_id ? ` · saved pair ${state.pair_id.slice(0,8)} · seed ${state.seed}` : '';
    const validation = state?.budget?.scope==='NATIVE_RULE_VALIDATION' ? ` Separate RULE validation · ${Math.ceil(state.budget.remaining_s)} s remain.` : '';
    document.getElementById('comparisonV2Status').textContent = provider.operationError || state?.error || reason || `RULE is the default. MODEL is experimental.${pair}${validation}`;
    const latest = state?.latest_attempt;
    document.getElementById('comparisonV2Results').textContent = busy ? `${state.side || 'Journey'} · ${state.phase}${pair} · automatic recording` : latest ? `Latest attempt · ${latest.side} · ${latest.status}${latest.reason ? ' · '+latest.reason : ''}. Saved measurements are in Results.` : 'RULE uses measured-motion prediction. Each journey records automatically. MODEL acceptance remains unproven.';
    const results = state || provider.recordedComparisonV2;
    document.getElementById('journeyResultsBtn').disabled = !Object.keys(results?.results || {}).length && !results?.latest_attempt;
    if (busy || pending) for (const id of ['demoWithoutBtn','demoWithBtn','demoStopBtn','startDrivingBtn','startJourneyBtn','phoneJourneyBtn','driveJourneyBtn','journeySpeed','safetyEnabled','safetyController','prepareTrafficBtn']) {
      const element = document.getElementById(id); if (element) {element.disabled = true; element.title = 'Stop the recorded journey first.';}
    }
  }
  return {update};
}
