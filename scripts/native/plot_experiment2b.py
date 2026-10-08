"""Standalone figure from frozen native evidence; no simulator interaction."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

from .experiment2b_common import ROOT


def main():
    destination = ROOT/'docs/evidence/experiment2b'
    native = json.loads((destination/'native.json').read_text())
    names = ('BASIC_AGENT', 'EXISTING_RULE', 'TEACHER')
    labels = ('BasicAgent\n4 collisions', 'Existing rule\n4 timeouts', 'Safety teacher\n4 successes')
    colors = ('#b54b3b', '#8993a2', '#24796b')
    fig, axes = plt.subplots(1, 2, figsize=(9.6, 4.8))
    fig.subplots_adjust(left=.075, right=.985, bottom=.25, top=.82, wspace=.27)
    for ax, field, title, units in zip(axes,
            ('forward_progress_m', 'average_speed_mps'),
            ('Forward progress', 'Average speed'), ('metres', 'metres / second')):
        for i, (controller, color) in enumerate(zip(names, colors)):
            values = [e['outcome']['metrics'][field] for e in native['episodes']
                      if e['split'] == 'TEST' and e['controller'] == controller]
            ax.bar(i, np.mean(values), color=color, alpha=.30, width=.62)
            ax.scatter(i + np.linspace(-.11, .11, 4), values, color=color, s=35, zorder=3)
        ax.set_xticks(range(3), labels)
        ax.set_title(title, loc='left', fontsize=12)
        ax.set_ylabel(units)
        ax.grid(axis='y', alpha=.15)
        ax.spines[['top', 'right']].set_visible(False)
        ax.set_axisbelow(True)
    fig.suptitle('YA RAB OSTORHA — Experiment 2B', fontsize=16, x=.015, ha='left')
    fig.text(.5, .025, 'Four matched fresh TEST conditions; dots are episodes, bars are means.\n'
             'Collision-free teacher progress is pilot evidence, not general reliability.',
             ha='center', fontsize=9, color='#46505a')
    fig.savefig(destination/'comparison.png', dpi=160, bbox_inches='tight')
    plt.close(fig)


if __name__ == '__main__':
    main()
