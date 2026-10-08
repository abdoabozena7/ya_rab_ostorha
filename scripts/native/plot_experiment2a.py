"""Scientific figure from existing validation replay; no model or simulator."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT=Path(__file__).resolve().parents[2]/'docs/evidence/experiment2a'


def main():
    with (ROOT/'prediction-replay.jsonl').open() as stream:
        rows=[r for line in stream if (r:=json.loads(line))['group']=='VALIDATION_FROZEN_SAC' and r['seed']==1042]
    t=[r['elapsed_s'] for r in rows]
    fig,axes=plt.subplots(3,1,figsize=(10,8),sharex=True,layout='constrained')
    for name,color,label in [('before','#bd6b26','Original nearest return'),('after','#16767a','Screened foreground')]:
        axes[0].plot(t,[r[name+'_return'][0] for r in rows],color=color,label=label,lw=2)
        axes[1].plot(t,[r[name+'_return'][3] for r in rows],color=color,lw=2)
        axes[2].plot(t,[r[name+'_prediction'][0] for r in rows],color=color,lw=2)
    axes[0].set_ylabel('Selected range (m)');axes[0].legend(loc='upper right')
    axes[1].set_ylabel('Radial velocity (m/s)')
    axes[2].set_ylabel('Frozen SAC gate');axes[2].axhline(0,color='#a42e2e',ls=':',label='Intervention threshold')
    axes[2].set_ylim(-.6,.08);axes[2].legend(loc='lower left')
    for ax in axes:
        ax.axvline(2.,color='#666666',ls='--',lw=1)
        ax.axvline(3.4,color='#a42e2e',ls='--',lw=1)
        ax.grid(alpha=.18);ax.set_xlim(0,3.5)
    axes[0].text(2.04,14,'Lead brake trigger',fontsize=9,color='#555555')
    axes[0].text(3.35,14,'Recorded collision',fontsize=9,color='#a42e2e',ha='right')
    axes[2].set_xlabel('Elapsed simulation time (s)')
    fig.suptitle('Experiment 2A — VALIDATION seed 1042\nCorrected radar features, unchanged model and gate',fontsize=14)
    fig.text(.5,-.015,'Offline counterfactual predictions on recorded controls; no new driving outcome measured.',ha='center',fontsize=9)
    fig.savefig(ROOT/'radar-replay.png',dpi=160,bbox_inches='tight');plt.close(fig)


if __name__=='__main__':main()
