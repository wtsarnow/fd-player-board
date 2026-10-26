#!/usr/bin/env python3
"""
Deterministic CSV Data Builder for `fd-player-board` (v8 — 14 Signals, Zero LLM Judgment)
=========================================================================================
100% deterministic Python math pipeline:
  1. Runs `/workspace/fd-system/tools/baseline.py` on active/upcoming slates (currently MNF
     DAL@PHI Slate #135720) using Empirical Bayes shrinkage (K=3.5), 14 LOWO Ridge-weighted
     signals (`/workspace/fd-system/weights.json`), Strategy Exchange packets
     (`/workspace/fd-system/tools/strategy_exchange.py`), and official structured NFL injury
     statuses (`O`, `IR`, `D`, or non-starting backup QB -> 0.0).
  2. Syncs `/workspace/fd-system/teams/DAL-135720.csv`, `/workspace/fd-system/teams/PHI-135720.csv`,
     and `/workspace/fd-system/lineups/135720-merged-proj.csv` byte-for-byte with
     `/workspace/fd-system/baseline/135720.csv` (zero subjective team-bot overrides).
  3. Solves the 4 MNF Showdown lineups (`mnf-1`, `mnf-2`, `mnf-3`, `mnf-fd-opt`) 100%
     deterministically via `PuLP` (`CBC` integer linear programming solver) with deterministic
     template-generated `strategy`, `label`, and `contest` strings.
  4. Updates `data/current_players.csv` (38 MNF rows updated + 566 completed Main/SNF rows
     preserved; re-ranked 1..604 by `our_proj` descending), `data/historic_player_projections.csv`
     (first 2,494 completed Weeks 3–8 rows preserved byte-for-byte; 38 pending MNF rows updated),
     `data/lineups.csv` (`mnf-1..3` and `mnf-fd-opt` updated; 15 completed Main/SNF lineups
     preserved byte-for-byte), and `data/meta.csv` (including `prediction_mode`, `build_id`,
     `generated_at`, and `sleepers_count`).
  5. Never modifies `index.html`, `app.js`, or `styles.css`.
"""

import argparse
import csv
import datetime
import json
import pathlib
import subprocess
import sys
import numpy as np
import pandas as pd
import pulp

REPO_ROOT = pathlib.Path('/workspace/fd-player-board')
DATA_DIR = REPO_ROOT / 'data'
FD_SYS = pathlib.Path('/workspace/fd-system')

BOARD_SIGNAL_COLS = [
    ('first_downs_rate', 'First_Downs_Rate', '1stDowns'),
    ('td_regression', 'TD_Regression', 'TDReg'),
    ('opportunity_share', 'Opportunity_Share', 'OppShare'),
    ('injury_step_up', 'Injury_Step_Up', 'InjStepUp'),
    ('per_snap_breakout', 'Per_Snap_Breakout', 'SnapBrk'),
    ('opp_defender_matchup', 'Opp_Defender_Matchup', 'DefMatchup'),
    ('ngs_skill_breakout', 'NGS_Skill_Breakout', 'NGS+FTN'),
    ('pedigree_sleeper', 'Pedigree_Sleeper', 'Pedigree'),
    ('floor_consistency', 'Floor_Consistency', 'Floor25'),
    ('snap_momentum', 'Snap_Momentum', 'SnapMom'),
    ('social_media_buzz', 'Social_Media_Buzz', 'Buzz'),
]

ALL_SIGNAL_SHORT = {
    'floor_consistency': 'Floor25',
    'social_media_buzz': 'Buzz',
    'td_regression': 'TDReg',
    'ngs_skill_breakout': 'NGS+FTN',
    'opportunity_share': 'OppShare',
    'injury_step_up': 'InjStepUp',
    'opp_defender_matchup': 'DefMatchup',
    'first_downs_rate': '1stDowns',
    'pedigree_sleeper': 'Pedigree',
    'def_strategy_vs_off': 'DefStrategy',
    'ceiling_upside': 'Ceiling75',
    'snap_momentum': 'SnapMom',
    'per_snap_breakout': 'SnapBrk',
    'off_strategy_vs_def': 'OffStrategy',
}


def compute_sleeper_and_reasons(row, weights):
    """Deterministic threshold & formula math for `is_sleeper` and `sleeper_reasons`."""
    pos = str(row['pos'])
    sal = int(row['salary'])
    our_proj = float(row['adjusted'])
    status = str(row['injury_tag']).strip() if pd.notna(row['injury_tag']) else ''

    # Format top positive signals for `sleeper_reasons`
    pos_sigs = []
    for k, w in weights.items():
        z = float(row.get(k, 0.0))
        if z >= 0.25:
            pos_sigs.append((ALL_SIGNAL_SHORT[k], z, w * z))
    pos_sigs.sort(key=lambda x: (x[1], x[2]), reverse=True)
    reasons_str = ' | '.join(f"{short} z=+{z:.2f}" for short, z, _ in pos_sigs[:4])

    # Deterministic sleeper criteria: active/Q, non-DST/K, mid/value salary, strong signal boost
    if status in ('O', 'IR', 'D') or pos in ('DST', 'K') or our_proj < 5.5:
        return False, reasons_str

    sal_cap = 10000 if pos == 'QB' else (9000 if pos == 'RB' else (7500 if pos == 'WR' else 7200))
    if sal > sal_cap:
        return False, reasons_str

    breakout_mult = (
        0.12 * max(0.0, float(row.get('injury_step_up', 0.0)))
        + 0.14 * max(0.0, float(row.get('ngs_skill_breakout', 0.0)))
        + 0.12 * max(0.0, float(row.get('opportunity_share', 0.0)))
        + 0.14 * max(0.0, float(row.get('td_regression', 0.0)))
        + 0.06 * max(0.0, float(row.get('pedigree_sleeper', 0.0)))
        + 0.02 * max(0.0, float(row.get('off_strategy_vs_def', 0.0)))
    )
    val_1k = float(row.get('value_per_1k', 0.0))
    is_slp = bool((breakout_mult >= 0.06 and val_1k >= 0.90) or (val_1k >= 1.25 and sal <= 7500))
    return is_slp, reasons_str


def map_6_players_to_9_slots(players_list):
    """
    Deterministically map a 6-player Showdown lineup into the 9 Classic columns
    `QB,RB1,RB2,WR1,WR2,WR3,TE,FLEX,DEF` expected by `data/lineups.csv` and `app.js`.
    """
    slots = {k: '' for k in ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'WR3', 'TE', 'FLEX', 'DEF']}
    flex_overflow = []

    qbs = [p for p in players_list if p['pos'] == 'QB']
    rbs = [p for p in players_list if p['pos'] == 'RB']
    wrs = [p for p in players_list if p['pos'] == 'WR']
    tes = [p for p in players_list if p['pos'] == 'TE']
    ks = [p for p in players_list if p['pos'] == 'K']
    dsts = [p for p in players_list if p['pos'] == 'DST']

    if qbs:
        slots['QB'] = qbs[0]['player']
        flex_overflow.extend(qbs[1:])
    for idx, rb in enumerate(rbs):
        if idx == 0:
            slots['RB1'] = rb['player']
        elif idx == 1:
            slots['RB2'] = rb['player']
        else:
            flex_overflow.append(rb)
    for idx, wr in enumerate(wrs):
        if idx == 0:
            slots['WR1'] = wr['player']
        elif idx == 1:
            slots['WR2'] = wr['player']
        elif idx == 2:
            slots['WR3'] = wr['player']
        else:
            flex_overflow.append(wr)
    if tes:
        slots['TE'] = tes[0]['player']
        flex_overflow.extend(tes[1:])
    if dsts:
        slots['DEF'] = dsts[0]['player']
        flex_overflow.extend(dsts[1:])
    flex_overflow.extend(ks)

    if flex_overflow:
        slots['FLEX'] = flex_overflow[0]['player']
    return slots


def solve_showdown_lineups(df_mnf):
    """
    Solve the 4 MNF Showdown lineups (`mnf-1`, `mnf-2`, `mnf-3`, `mnf-fd-opt`) 100%
    deterministically using `PuLP` CBC integer linear programming.
    """
    act = df_mnf[df_mnf['our_proj'] > 0].copy().reset_index(drop=True)
    N = len(act)

    def solve_one(score_col, min_proj=3.5, exclude_sets=None, require_k=False, different_mvp_from=None):
        prob = pulp.LpProblem(f"sd_{score_col}", pulp.LpMaximize)
        m = [pulp.LpVariable(f"m_{i}", cat='Binary') for i in range(N)]
        f = [pulp.LpVariable(f"f_{i}", cat='Binary') for i in range(N)]

        prob += pulp.lpSum([1.5 * act.loc[i, score_col] * m[i] + 1.0 * act.loc[i, score_col] * f[i] for i in range(N)])
        prob += pulp.lpSum([1.5 * act.loc[i, 'salary'] * m[i] + 1.0 * act.loc[i, 'salary'] * f[i] for i in range(N)]) <= 60000
        prob += pulp.lpSum(m) == 1
        prob += pulp.lpSum(f) == 5

        for i in range(N):
            prob += m[i] + f[i] <= 1
            if float(act.loc[i, 'our_proj']) < min_proj:
                prob += m[i] + f[i] == 0

        for tm in ['DAL', 'PHI']:
            idx_tm = [i for i in range(N) if act.loc[i, 'team'] == tm]
            prob += pulp.lpSum([m[i] + f[i] for i in idx_tm]) >= 1
            prob += pulp.lpSum([m[i] + f[i] for i in idx_tm]) <= 4

        # Ensure 6-player set maps cleanly into 9-slot schema (at most 1 overflow into FLEX)
        idx_qb = [i for i in range(N) if act.loc[i, 'pos'] == 'QB']
        idx_rb = [i for i in range(N) if act.loc[i, 'pos'] == 'RB']
        idx_wr = [i for i in range(N) if act.loc[i, 'pos'] == 'WR']
        idx_te = [i for i in range(N) if act.loc[i, 'pos'] == 'TE']
        idx_k = [i for i in range(N) if act.loc[i, 'pos'] == 'K']
        idx_dst = [i for i in range(N) if act.loc[i, 'pos'] == 'DST']

        prob += pulp.lpSum([m[i] + f[i] for i in idx_qb]) <= 2
        prob += pulp.lpSum([m[i] + f[i] for i in idx_rb]) <= 3
        prob += pulp.lpSum([m[i] + f[i] for i in idx_wr]) <= 4
        prob += pulp.lpSum([m[i] + f[i] for i in idx_te]) <= 2
        prob += pulp.lpSum([m[i] + f[i] for i in idx_k]) <= 1
        prob += pulp.lpSum([m[i] + f[i] for i in idx_dst]) <= 1

        # At most 1 player can need the single FLEX slot across (2nd QB, 3rd RB, 4th WR, 2nd TE, 1st K)
        ov_qb = pulp.LpVariable('ov_qb', lowBound=0)
        ov_rb = pulp.LpVariable('ov_rb', lowBound=0)
        ov_wr = pulp.LpVariable('ov_wr', lowBound=0)
        ov_te = pulp.LpVariable('ov_te', lowBound=0)
        prob += ov_qb >= pulp.lpSum([m[i] + f[i] for i in idx_qb]) - 1
        prob += ov_rb >= pulp.lpSum([m[i] + f[i] for i in idx_rb]) - 2
        prob += ov_wr >= pulp.lpSum([m[i] + f[i] for i in idx_wr]) - 3
        prob += ov_te >= pulp.lpSum([m[i] + f[i] for i in idx_te]) - 1
        prob += ov_qb + ov_rb + ov_wr + ov_te + pulp.lpSum([m[i] + f[i] for i in idx_k]) <= 1

        if require_k:
            prob += pulp.lpSum([m[i] + f[i] for i in idx_k]) == 1
        if different_mvp_from:
            for mvp_nm in different_mvp_from:
                for i in range(N):
                    if act.loc[i, 'player'] == mvp_nm:
                        prob += m[i] == 0
        if exclude_sets:
            for prev_all in exclude_sets:
                prob += pulp.lpSum([m[i] + f[i] for i in prev_all]) <= 4

        prob.solve(pulp.PULP_CBC_CMD(msg=False))
        mvp_idx = [i for i in range(N) if pulp.value(m[i]) > 0.5][0]
        flex_idxs = [i for i in range(N) if pulp.value(f[i]) > 0.5]
        flex_idxs.sort(key=lambda i: (float(act.loc[i, 'our_proj']), int(act.loc[i, 'salary'])), reverse=True)
        return mvp_idx, flex_idxs

    l1_m, l1_f = solve_one('our_proj', min_proj=3.5)
    l2_m, l2_f = solve_one('our_proj', min_proj=3.5, exclude_sets=[[l1_m] + l1_f], different_mvp_from=[act.loc[l1_m, 'player']])
    l3_m, l3_f = solve_one('our_proj', min_proj=3.5, exclude_sets=[[l1_m] + l1_f, [l2_m] + l2_f], require_k=True)
    lfd_m, lfd_f = solve_one('fd_proj', min_proj=0.1)

    configs = [
        ('mnf-1', 1, 'MOCK-135720-1', '135720-281310001', '$15 $300K Mon NFL Primetime Showdown (Flagship 135720)', 15.00, 'Deterministic v8 ILP Optimal #1 (No-Punt Ceiling)', l1_m, l1_f),
        ('mnf-2', 2, 'MOCK-135720-2', '135720-281310002', '$3 $100K Mon NFL Rush', 3.00, 'Deterministic v8 ILP Optimal #2 (Alternate MVP Leverage)', l2_m, l2_f),
        ('mnf-3', 3, 'MOCK-135720-3', '135720-281310003', '$1 $20K Mon NFL Dive', 1.00, 'Deterministic v8 ILP Optimal #3 (K-Pool Floor Stack)', l3_m, l3_f),
        ('mnf-fd-opt', 4, 'FD-OPT-135720', '135720-FD-OPT', 'FanDuel Pre-Game Mathematical Optimal Showdown', 0.00, 'Deterministic FanDuel Baseline FPPG Optimal', lfd_m, lfd_f),
    ]

    mock_rows = []
    board_lineup_rows = []

    for preset_id, l_num, entry_id, cid, cname, buyin, strat_prefix, m_idx, f_idxs in configs:
        mvp_row = act.loc[m_idx]
        flex_rows = [act.loc[i] for i in f_idxs]
        all_rows = [mvp_row] + flex_rows

        tot_sal = int(round(1.5 * mvp_row['salary'] + sum(r['salary'] for r in flex_rows)))
        tot_our = round(1.5 * float(mvp_row['our_proj']) + sum(float(r['our_proj']) for r in flex_rows), 2)
        tot_fd = round(1.5 * float(mvp_row['fd_proj']) + sum(float(r['fd_proj']) for r in flex_rows), 2)
        tot_ceil = round(1.5 * float(mvp_row['ceil']) + sum(float(r['ceil']) for r in flex_rows), 2)

        flex_names_str = ' + '.join(f"{r['player']}" for r in flex_rows)
        strat_str = f"{strat_prefix} (MVP {mvp_row['player']} 1.5x + {flex_names_str})"

        if preset_id != 'mnf-fd-opt':
            for slot_idx, r in enumerate(all_rows):
                slot_lbl = 'MVP' if slot_idx == 0 else 'FLEX'
                mult = 1.5 if slot_idx == 0 else 1.0
                mock_rows.append({
                    'lineup': l_num,
                    'entry_id': entry_id,
                    'contest_id': cid,
                    'contest_name': cname,
                    'strategy': strat_str,
                    'slot': slot_lbl,
                    'player': r['player'],
                    'pos': r['pos'],
                    'team': r['team'],
                    'opp': r['opp'],
                    'salary_1x': int(r['salary']),
                    'effective_salary': int(round(mult * r['salary'])),
                    'proj_1x': round(float(r['our_proj']), 2),
                    'effective_proj': round(mult * float(r['our_proj']), 2),
                    'fd_id': r['fd_id'],
                    'total_salary': tot_sal,
                    'total_proj': tot_our,
                })

        slots_map = map_6_players_to_9_slots([r.to_dict() for r in all_rows])
        if preset_id == 'mnf-fd-opt':
            label_str = f"FD Pre-Game Optimal Showdown — Baseline FPPG Max Build ({tot_fd:.2f} FD pts / {tot_our:.2f} v8 pts)"
            contest_str = f"{cname} — {strat_str}"
        else:
            label_str = f"MNF Showdown #{l_num} — {cname.split(' (')[0]} ({tot_our:.2f} pts • MVP {mvp_row['player']})"
            contest_str = f"{cname} — {strat_str}"

        board_lineup_rows.append({
            'preset_id': preset_id,
            'group': 'MNF Showdown Builds (DAL @ PHI • Mon Oct 26 #135720)',
            'label': label_str,
            'contest': contest_str,
            'entry_id': entry_id,
            'buyin': f"{buyin:.2f}",
            'salary': tot_sal,
            'our_proj': tot_our,
            'fd_proj': tot_fd,
            'ceil': tot_ceil,
            **slots_map,
        })

    return pd.DataFrame(mock_rows), pd.DataFrame(board_lineup_rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', default='pregame', choices=['pregame', 'postgame', 'audit'])
    args = parser.parse_args()

    # 1. Run deterministic v8 baseline on active MNF slate 135720
    subprocess.run(
        [sys.executable, str(FD_SYS / 'tools' / 'baseline.py'), str(FD_SYS / 'boards' / '135720.csv'), '135720', '2026-10-26'],
        check=True,
    )

    b135720 = pd.read_csv(FD_SYS / 'baseline' / '135720.csv')
    # Sync team CSVs and merged-proj CSV byte-for-byte with deterministic baseline
    b135720[b135720['team'] == 'DAL'].to_csv(FD_SYS / 'teams' / 'DAL-135720.csv', index=False)
    b135720[b135720['team'] == 'PHI'].to_csv(FD_SYS / 'teams' / 'PHI-135720.csv', index=False)
    b135720.sort_values('adjusted', ascending=False).to_csv(FD_SYS / 'lineups' / '135720-merged-proj.csv', index=False)

    weights = json.loads((FD_SYS / 'weights.json').read_text())['weights']

    # 2. Load current_players.csv and preserve the 566 completed Main + SNF rows byte-for-byte
    cp_df = pd.read_csv(DATA_DIR / 'current_players.csv', dtype=str, keep_default_na=False)
    cp_completed = cp_df[~cp_df['team'].isin(['DAL', 'PHI'])].copy()
    cp_mnf_old = cp_df[cp_df['team'].isin(['DAL', 'PHI'])].set_index('name')

    mnf_new_rows = []
    mnf_for_opt = []
    for _, r in b135720.iterrows():
        pname = str(r['player'])
        old_r = cp_mnf_old.loc[pname]
        pid = str(old_r['id'])
        fd_proj = float(old_r['fd_proj'])
        base_proj = float(r['base'])
        our_proj = float(r['adjusted'])
        proj_edge = round(our_proj - fd_proj, 2)
        val_1k = float(r['value_per_1k'])

        if our_proj > 0:
            ceil_v = round(our_proj * (1.35 + 0.12 * max(0.0, float(r['ceiling_upside']))), 2)
            floor_v = round(our_proj * (0.58 + 0.08 * max(0.0, float(r['floor_consistency']))), 2)
        else:
            ceil_v = 0.0
            floor_v = 0.0

        inj_t = str(r['injury_tag']).strip() if pd.notna(r['injury_tag']) else ''
        status_str = inj_t if inj_t in ('O', 'IR', 'D', 'Q') else 'ACTIVE'
        is_slp, slp_reasons = compute_sleeper_and_reasons(r, weights)

        row_dict = {
            'rank': '0',
            'id': pid,
            'name': pname,
            'pos': str(r['pos']),
            'team': str(r['team']),
            'opp': str(r['opp']),
            'game': str(old_r['game']),
            'home_away': str(old_r['home_away']),
            'salary': str(int(r['salary'])),
            'our_proj': f"{our_proj:.2f}" if our_proj != round(our_proj, 1) else f"{our_proj}",
            'fd_proj': str(old_r['fd_proj']),
            'base_proj': f"{base_proj:.2f}" if base_proj != round(base_proj, 1) else f"{base_proj}",
            'proj_edge': f"{proj_edge:.2f}" if proj_edge != round(proj_edge, 1) else f"{proj_edge}",
            'value_per_1k': f"{val_1k:.2f}" if val_1k != round(val_1k, 1) else f"{val_1k}",
            'ceil': f"{ceil_v:.2f}" if ceil_v != round(ceil_v, 1) else f"{ceil_v}",
            'floor': f"{floor_v:.2f}" if floor_v != round(floor_v, 1) else f"{floor_v}",
            'status': status_str,
            'injury_note': str(r['notes']),
            'is_sleeper': str(is_slp),
            'sleeper_reasons': slp_reasons,
            'spread': str(old_r['spread']),
            'over_under': str(old_r['over_under']),
            'implied_total': str(old_r['implied_total']),
            'weather_Penalty': str(old_r['weather_Penalty']),
        }

        for sig_key, col_prefix, _ in BOARD_SIGNAL_COLS:
            zv = round(float(r[sig_key]), 3)
            ptv = round(base_proj * float(weights[sig_key]) * zv, 2) if our_proj > 0 else 0.0
            row_dict[f"{col_prefix}_z"] = f"{zv}"
            row_dict[f"{col_prefix}_pts"] = f"{ptv}"

        mnf_new_rows.append(row_dict)
        mnf_for_opt.append({
            'player': pname,
            'pos': str(r['pos']),
            'team': str(r['team']),
            'opp': str(r['opp']),
            'salary': int(r['salary']),
            'our_proj': our_proj,
            'fd_proj': fd_proj,
            'base_proj': base_proj,
            'ceil': ceil_v,
            'floor': floor_v,
            'fd_id': pid,
            'home_away': str(old_r['home_away']),
            'is_sleeper': is_slp,
        })

    cp_all = pd.concat([cp_completed, pd.DataFrame(mnf_new_rows)], ignore_index=True)
    cp_all['_sort_proj'] = cp_all['our_proj'].astype(float)
    cp_all['_sort_sal'] = cp_all['salary'].astype(int)
    cp_all = cp_all.sort_values(['_sort_proj', '_sort_sal'], ascending=[False, False]).reset_index(drop=True)
    cp_all['rank'] = [str(i + 1) for i in range(len(cp_all))]
    cp_all = cp_all.drop(columns=['_sort_proj', '_sort_sal'])
    cp_all.to_csv(DATA_DIR / 'current_players.csv', index=False)

    # 3. Update historic_player_projections.csv while preserving first 2,494 completed rows byte-for-byte
    hp_path = DATA_DIR / 'historic_player_projections.csv'
    with open(hp_path, 'r', encoding='utf-8') as f:
        hp_lines = f.readlines()
    # Header + 2,494 completed rows = first 2,495 lines preserved byte-for-byte
    preserved_hp_lines = hp_lines[:2495]

    mnf_opt_df = pd.DataFrame(mnf_for_opt).sort_values(['our_proj', 'salary'], ascending=[False, False]).reset_index(drop=True)
    new_hp_rows = []
    for _, mr in mnf_opt_df.iterrows():
        diff_fd = round(float(mr['our_proj']) - float(mr['fd_proj']), 2)
        val_pre = round(float(mr['our_proj']) / (int(mr['salary']) / 1000.0), 2)
        new_hp_rows.append(
            f"8,Wk 8 (MNF DAL@PHI),Mon 20:15 ET,{mr['fd_id']},{mr['player']},{mr['pos']},{mr['team']},{mr['opp']},"
            f"{mr['home_away']},{int(mr['salary'])},{mr['our_proj']:.2f},{mr['fd_proj']:.2f},{mr['base_proj']:.2f},,"
            f"{diff_fd:.2f},,,,,PENDING,{val_pre:.2f},,{mr['is_sleeper']}\n"
        )
    with open(hp_path, 'w', encoding='utf-8') as f:
        f.writelines(preserved_hp_lines + new_hp_rows)

    # 4. Solve MNF Showdown lineups deterministically via PuLP and update lineups.csv
    mock_df, mnf_lu_df = solve_showdown_lineups(mnf_opt_df)
    mock_df.to_csv(FD_SYS / 'lineups' / '135720-mnf-mock.csv', index=False)

    lu_old = pd.read_csv(DATA_DIR / 'lineups.csv', dtype=str, keep_default_na=False)
    lu_preserved = lu_old[~lu_old['preset_id'].isin(['mnf-1', 'mnf-2', 'mnf-3', 'mnf-fd-opt'])].copy()
    lu_combined = pd.concat([mnf_lu_df.astype(str), lu_preserved], ignore_index=True)
    lu_combined.to_csv(DATA_DIR / 'lineups.csv', index=False)

    # 5. Update meta.csv with build_id, generated_at, and prediction_mode
    now_et = datetime.datetime.now()
    build_id = now_et.strftime('%Y%m%d-%H%M%S')
    gen_at = now_et.strftime('%Y-%m-%d %I:%M %p ET') + f" (mode={args.mode} • 100% Deterministic Pipeline)"

    meta_df = pd.read_csv(DATA_DIR / 'meta.csv', dtype=str, keep_default_na=False)
    meta_dict = dict(zip(meta_df['key'], meta_df['value']))
    meta_dict['build_id'] = build_id
    meta_dict['generated_at'] = gen_at
    meta_dict['prediction_mode'] = '100% Deterministic Python Math (Empirical Bayes + 14-Signal LOWO Ridge + PuLP ILP — Zero LLM Judgment)'

    out_meta = pd.DataFrame([{'key': k, 'value': v} for k, v in meta_dict.items()])
    out_meta.to_csv(DATA_DIR / 'meta.csv', index=False)

    print(f"Successfully built deterministic CSV data: build_id={build_id}, current_players={len(cp_all)}, historic_rows={len(preserved_hp_lines)-1+len(new_hp_rows)}, lineups={len(lu_combined)}")


if __name__ == '__main__':
    main()
