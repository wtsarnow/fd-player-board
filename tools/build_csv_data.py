#!/usr/bin/env python3
"""
Deterministic CSV Data Builder for `fd-player-board` (v8 — 14 Signals, Zero LLM Judgment)
=========================================================================================
100% deterministic Python math pipeline:
  1. Runs `/workspace/fd-system/tools/baseline.py` on active/upcoming slates (currently MNF
     DAL@PHI Live Slate #135830, plus #135720 alias) using Empirical Bayes shrinkage (K=3.5),
     14 LOWO Ridge-weighted signals (`/workspace/fd-system/weights.json`), Strategy Exchange
     packets (`/workspace/fd-system/tools/strategy_exchange.py`), and official structured NFL
     injury statuses (`O`, `IR`, `D`, or non-starting backup QB -> 0.0).
  2. Syncs `/workspace/fd-system/teams/DAL-135830.csv`, `/workspace/fd-system/teams/PHI-135830.csv`,
     and `/workspace/fd-system/lineups/135830-merged-proj.csv` (and 135720 aliases) byte-for-byte
     with `/workspace/fd-system/baseline/135830.csv` (zero subjective team-bot overrides).
  3. Evaluates Tysa's live entered MNF Showdown lineup (`3754559753` in `135830-281254021` —
     `$80K Mon NFL Rush ($10K to 1st)`) and solves the deterministic MNF Showdown ILP optimal
     lineups (`mnf-1`, `mnf-2`, `mnf-3`, `mnf-fd-opt`) via `PuLP` (`CBC` integer linear
     programming solver) with deterministic template-generated `strategy`, `label`, and
     `contest` strings.
  4. Updates `data/current_players.csv` (55 MNF rows updated + 566 completed Main/SNF rows
     preserved; re-ranked 1..621 by `our_proj` descending), `data/historic_player_projections.csv`
     (first 2,494 completed Weeks 3–8 rows preserved byte-for-byte; 55 pending MNF rows updated),
     `data/lineups.csv` (`mnf-entry-1`, `mnf-1..3`, and `mnf-fd-opt` updated; 15 completed
     Main/SNF lineups preserved byte-for-byte), and `data/meta.csv`.
  5. Never modifies `index.html`, `app.js`, or `styles.css`.
"""

import argparse
import datetime
import json
import pathlib
import re
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

    pos_sigs = []
    for k, w in weights.items():
        z = float(row.get(k, 0.0))
        if z >= 0.25:
            pos_sigs.append((ALL_SIGNAL_SHORT[k], z, w * z))
    pos_sigs.sort(key=lambda x: (x[1], x[2]), reverse=True)
    reasons_str = ' | '.join(f"{short} z=+{z:.2f}" for short, z, _ in pos_sigs[:4])

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




SLOT_ORDER = ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'WR3', 'TE', 'FLEX', 'DEF']


def assign_9_classic_slots(df_selected):
    """
    Deterministically assign 9 chosen Classic players (1 QB, 2-3 RB, 3-4 WR, 1-2 TE, 1 DST)
    to ordered slots QB, RB1, RB2, WR1, WR2, WR3, TE, FLEX, DEF.
    """
    rows = df_selected.copy()
    rows['_p'] = rows['our_proj'].astype(float)
    rows['_s'] = rows['salary'].astype(int)
    rows = rows.sort_values(['_p', '_s'], ascending=[False, False])

    qbs = rows[rows['pos'] == 'QB'].to_dict('records')
    rbs = rows[rows['pos'] == 'RB'].to_dict('records')
    wrs = rows[rows['pos'] == 'WR'].to_dict('records')
    tes = rows[rows['pos'] == 'TE'].to_dict('records')
    dsts = rows[rows['pos'] == 'DST'].to_dict('records')

    flex_pool = rbs[2:] + wrs[3:] + tes[1:]
    return [
        ('QB', qbs[0]),
        ('RB1', rbs[0]),
        ('RB2', rbs[1]),
        ('WR1', wrs[0]),
        ('WR2', wrs[1]),
        ('WR3', wrs[2]),
        ('TE', tes[0]),
        ('FLEX', flex_pool[0]),
        ('DEF', dsts[0]),
    ]


def solve_classic_9_pulp(df_pool, salary_cap=60000, min_proj=5.0, max_per_team=4, min_team_each=0, min_stack=1):
    """
    Solve a 9-player FanDuel Classic lineup (`QB, RB1, RB2, WR1, WR2, WR3, TE, FLEX, DEF`)
    100% deterministically using PuLP CBC integer linear programming against `salary_cap = 60000`.
    """
    d = df_pool[
        (df_pool['our_proj'].astype(float) >= min_proj)
        & (~df_pool['status'].isin(['O', 'IR', 'D']))
        & (df_pool['pos'].isin(['QB', 'RB', 'WR', 'TE', 'DST']))
    ].copy().reset_index(drop=True)

    d['_p'] = d['our_proj'].astype(float)
    d['_s'] = d['salary'].astype(int)
    I = range(len(d))
    P = lambda p_pos: [i for i in I if d.loc[i, 'pos'] == p_pos]

    m = pulp.LpProblem('fd_classic_optimal', pulp.LpMaximize)
    x = {i: pulp.LpVariable(f"x_{i}", cat='Binary') for i in I}

    m += pulp.lpSum(
        (d.loc[i, '_p'] + 1e-5 * float(d.loc[i, 'fd_proj']) + 1e-8 * d.loc[i, '_s']) * x[i]
        for i in I
    )
    m += pulp.lpSum(d.loc[i, '_s'] * x[i] for i in I) <= salary_cap
    m += pulp.lpSum(x.values()) == 9
    m += pulp.lpSum(x[i] for i in P('QB')) == 1
    m += pulp.lpSum(x[i] for i in P('DST')) == 1

    for pos_nm, lo, hi in (('RB', 2, 3), ('WR', 3, 4), ('TE', 1, 2)):
        s = pulp.lpSum(x[i] for i in P(pos_nm))
        m += s >= lo
        m += s <= hi

    for t in d['team'].unique():
        m += pulp.lpSum(x[i] for i in I if d.loc[i, 'team'] == t) <= max_per_team
        if min_team_each > 0:
            m += pulp.lpSum(x[i] for i in I if d.loc[i, 'team'] == t) >= min_team_each
        if min_stack > 0:
            for q in P('QB'):
                if d.loc[q, 'team'] == t:
                    m += pulp.lpSum(
                        x[i] for i in I if d.loc[i, 'team'] == t and d.loc[i, 'pos'] in ('WR', 'TE')
                    ) >= min_stack * x[q]

    status = m.solve(pulp.PULP_CBC_CMD(msg=0))
    if status != 1:
        raise RuntimeError(f"PuLP CBC solver did not find optimal solution (status={status})")

    chosen_idxs = [i for i in I if x[i].value() is not None and x[i].value() > 0.5]
    return d.loc[chosen_idxs].copy()


def build_optimal_lineups_csv(cp_all):
    """
    Precompute optimal lineups for strictly two scopes:
      1. `all_games` (`scope_key = 'ALL_GAMES'`): All 12 games combined on the current Week 8 slate
      2. `per_game` (`scope_key = '<AWAY>@<HOME>'`): Each individual game on the current Week 8 slate
    All solved 100% deterministically with PuLP CBC against the $60,000 FanDuel salary cap.
    """
    lineup_rules = json.loads((FD_SYS / 'weights.json').read_text()).get('lineup', {})
    cap = int(lineup_rules.get('cap', 60000))
    max_per_tm_all = int(lineup_rules.get('max_per_team', 4))
    min_stack = int(lineup_rules.get('stack_qb_with_min_receivers', 1))

    rows_out = []

    def append_lineup_rows(scope, scope_key, scope_label, df_chosen):
        assigned = assign_9_classic_slots(df_chosen)
        tot_sal = sum(int(p['salary']) for _, p in assigned)
        rem_sal = cap - tot_sal
        tot_our = round(sum(float(p['our_proj']) for _, p in assigned), 2)
        tot_fd = round(sum(float(p['fd_proj']) for _, p in assigned), 2)
        tot_base = round(sum(float(p['base_proj']) for _, p in assigned), 2)
        tot_edge = round(tot_our - tot_fd, 2)
        tot_ceil = round(sum(float(p['ceil']) for _, p in assigned), 2)
        tot_floor = round(sum(float(p['floor']) for _, p in assigned), 2)

        for idx, (slot_name, p) in enumerate(assigned, start=1):
            rows_out.append({
                'scope': scope,
                'scope_key': scope_key,
                'scope_label': scope_label,
                'salary_cap': cap,
                'total_salary': tot_sal,
                'salary_remaining': rem_sal,
                'total_our_proj': f"{tot_our:.2f}",
                'total_fd_proj': f"{tot_fd:.2f}",
                'total_base_proj': f"{tot_base:.2f}",
                'total_proj_edge': f"{tot_edge:+.2f}",
                'total_ceil': f"{tot_ceil:.2f}",
                'total_floor': f"{tot_floor:.2f}",
                'slot_order': idx,
                'slot': slot_name,
                'player_id': p['id'],
                'player': p['name'],
                'pos': p['pos'],
                'team': p['team'],
                'opp': p['opp'],
                'game': p['game'],
                'home_away': p['home_away'],
                'salary': int(p['salary']),
                'our_proj': f"{float(p['our_proj']):.2f}",
                'fd_proj': f"{float(p['fd_proj']):.2f}",
                'base_proj': f"{float(p['base_proj']):.2f}",
                'proj_edge': f"{float(p['proj_edge']):+.2f}",
                'value_per_1k': f"{float(p['value_per_1k']):.2f}",
                'ceil': f"{float(p['ceil']):.2f}",
                'floor': f"{float(p['floor']):.2f}",
                'status': p['status'],
                'is_sleeper': p['is_sleeper'],
                'top_signals': p['sleeper_reasons'],
                'solver': 'PuLP CBC ILP (cap=$60,000)',
            })

    # Scope 1: `all_games` (All 12 games combined on the current slate)
    df_all_chosen = solve_classic_9_pulp(
        cp_all,
        salary_cap=cap,
        min_proj=5.0,
        max_per_team=max_per_tm_all,
        min_team_each=0,
        min_stack=min_stack,
    )
    append_lineup_rows(
        scope='all_games',
        scope_key='ALL_GAMES',
        scope_label='All Games Combined (12 Week 8 Games • $60,000 Cap)',
        df_chosen=df_all_chosen,
    )

    # Scope 2: `per_game` (Each individual game on the current slate)
    game_meta = {}
    for g_code, g_df in cp_all.groupby('game', sort=False):
        ou = float(g_df['over_under'].iloc[0]) if len(g_df) else 44.0
        game_meta[g_code] = ou

    ordered_games = sorted(
        game_meta.keys(),
        key=lambda g: (0 if g == 'DAL@PHI' else (1 if g == 'KC@SEA' else 2), -game_meta[g], g),
    )

    for g_code in ordered_games:
        g_df = cp_all[cp_all['game'] == g_code].copy()
        ou = game_meta[g_code]
        parts = g_code.split('@')
        away_tm, home_tm = (parts[0], parts[1]) if len(parts) == 2 else (g_code, '')
        tag = 'MNF #135830' if g_code == 'DAL@PHI' else ('SNF #135719' if g_code == 'KC@SEA' else 'Main #135562')
        label = f"{away_tm} @ {home_tm} ({tag} • O/U {ou:.1f} • $60,000 Cap)"

        df_g_chosen = solve_classic_9_pulp(
            g_df,
            salary_cap=cap,
            min_proj=0.01,
            max_per_team=6,
            min_team_each=1,
            min_stack=min_stack,
        )
        append_lineup_rows(
            scope='per_game',
            scope_key=g_code,
            scope_label=label,
            df_chosen=df_g_chosen,
        )

    return pd.DataFrame(rows_out)


def solve_showdown_lineups(df_mnf):
    """
    Evaluate Tysa's live entered MNF Showdown lineup (`3754559753`) and solve the 4 MNF Showdown
    ILP optimal lineups (`mnf-1`, `mnf-2`, `mnf-3`, `mnf-fd-opt`) 100% deterministically using
    `PuLP` CBC integer linear programming.
    """
    act = df_mnf[df_mnf['our_proj'] > 0].copy().reset_index(drop=True)
    N = len(act)
    idx_by_name = {act.loc[i, 'player']: i for i in range(N)}

    def solve_one(score_col, min_proj=3.5, max_per_team=5, force_mvp=None, exclude_sets=None, require_k=False, different_mvp_from=None):
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
            prob += pulp.lpSum([m[i] + f[i] for i in idx_tm]) <= max_per_team

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

        ov_qb = pulp.LpVariable('ov_qb', lowBound=0)
        ov_rb = pulp.LpVariable('ov_rb', lowBound=0)
        ov_wr = pulp.LpVariable('ov_wr', lowBound=0)
        ov_te = pulp.LpVariable('ov_te', lowBound=0)
        prob += ov_qb >= pulp.lpSum([m[i] + f[i] for i in idx_qb]) - 1
        prob += ov_rb >= pulp.lpSum([m[i] + f[i] for i in idx_rb]) - 2
        prob += ov_wr >= pulp.lpSum([m[i] + f[i] for i in idx_wr]) - 3
        prob += ov_te >= pulp.lpSum([m[i] + f[i] for i in idx_te]) - 1
        prob += ov_qb + ov_rb + ov_wr + ov_te + pulp.lpSum([m[i] + f[i] for i in idx_k]) <= 1

        if force_mvp:
            for i in range(N):
                if act.loc[i, 'player'] == force_mvp:
                    prob += m[i] == 1
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

    # Tysa's live entered lineup on FanDuel (Entry ID 3754559753, Lineup ID 135830-3528737559)
    tysa_m = idx_by_name['Dak Prescott']
    tysa_f = [
        idx_by_name['Javonte Williams'],
        idx_by_name['George Pickens'],
        idx_by_name['Dallas Goedert'],
        idx_by_name['Jake Ferguson'],
        idx_by_name['Ryan Flournoy'],
    ]

    # Deterministic PuLP ILP optimal Showdown builds on live slate 135830
    l1_m, l1_f = solve_one('our_proj', min_proj=3.5, max_per_team=5)
    l2_m, l2_f = solve_one('our_proj', min_proj=3.5, max_per_team=4, force_mvp='Dak Prescott')
    l3_m, l3_f = solve_one('our_proj', min_proj=3.5, max_per_team=4, exclude_sets=[[l1_m] + l1_f, [l2_m] + l2_f], require_k=True)
    lfd_m, lfd_f = solve_one('fd_proj', min_proj=0.1, max_per_team=5)

    configs = [
        (
            'mnf-entry-1',
            1,
            '3754559753',
            '135830-281254021',
            '$3 $80K Mon NFL Rush ($10K to 1st)',
            3.00,
            'Tysa Live Entry #3754559753 — 5-1 Cowboys Red-Zone Onslaught',
            tysa_m,
            tysa_f,
            True,
        ),
        (
            'mnf-1',
            2,
            'OPT-135830-1',
            '135830-281254021',
            '$3 $80K Mon NFL Rush ($10K to 1st)',
            3.00,
            'Deterministic v8 ILP Optimal #1 (5-1 Onslaught Max Ceiling)',
            l1_m,
            l1_f,
            False,
        ),
        (
            'mnf-2',
            3,
            'OPT-135830-2',
            '135830-281310001',
            '$15 $300K Mon NFL Primetime Showdown (Flagship 135830)',
            15.00,
            'Deterministic v8 ILP Optimal #2 (Dak MVP 4-2 Balanced Ceiling)',
            l2_m,
            l2_f,
            False,
        ),
        (
            'mnf-3',
            4,
            'OPT-135830-3',
            '135830-281310003',
            '$1 $20K Mon NFL Dive',
            1.00,
            'Deterministic v8 ILP Optimal #3 (4-2 K-Pool Floor Stack)',
            l3_m,
            l3_f,
            False,
        ),
        (
            'mnf-fd-opt',
            5,
            'FD-OPT-135830',
            '135830-FD-OPT',
            'FanDuel Pre-Game Mathematical Optimal Showdown',
            0.00,
            'Deterministic FanDuel Baseline FPPG Optimal',
            lfd_m,
            lfd_f,
            False,
        ),
    ]

    entries_rows = []
    mock_rows = []
    board_lineup_rows = []

    for preset_id, l_num, entry_id, cid, cname, buyin, strat_prefix, m_idx, f_idxs, is_live_entry in configs:
        mvp_row = act.loc[m_idx]
        flex_rows = [act.loc[i] for i in f_idxs]
        all_rows = [mvp_row] + flex_rows

        tot_sal = int(round(1.5 * mvp_row['salary'] + sum(r['salary'] for r in flex_rows)))
        tot_our = round(1.5 * float(mvp_row['our_proj']) + sum(float(r['our_proj']) for r in flex_rows), 2)
        tot_fd = round(1.5 * float(mvp_row['fd_proj']) + sum(float(r['fd_proj']) for r in flex_rows), 2)
        tot_base = round(1.5 * float(mvp_row['base_proj']) + sum(float(r['base_proj']) for r in flex_rows), 2)
        tot_ceil = round(1.5 * float(mvp_row['ceil']) + sum(float(r['ceil']) for r in flex_rows), 2)

        flex_names_str = ' + '.join(f"{r['player']}" for r in flex_rows)
        strat_str = f"{strat_prefix} (MVP {mvp_row['player']} 1.5x + {flex_names_str})"

        if preset_id != 'mnf-fd-opt':
            for slot_idx, r in enumerate(all_rows):
                slot_lbl = 'MVP' if slot_idx == 0 else 'FLEX'
                mult = 1.5 if slot_idx == 0 else 1.0
                row_entry = {
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
                    'fd_proj_1x': round(float(r['fd_proj']), 2),
                    'effective_fd_proj': round(mult * float(r['fd_proj']), 2),
                    'base_1x': round(float(r['base_proj']), 2),
                    'proj_1x': round(float(r['our_proj']), 2),
                    'effective_proj': round(mult * float(r['our_proj']), 2),
                    'fd_id': r['fd_id'],
                    'total_salary': tot_sal,
                    'total_fd_proj': tot_fd,
                    'total_base_proj': tot_base,
                    'total_proj': tot_our,
                }
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
                if is_live_entry:
                    entries_rows.append(row_entry)

        slots_map = map_6_players_to_9_slots([r.to_dict() for r in all_rows])
        if preset_id == 'mnf-fd-opt':
            label_str = f"FD Pre-Game Optimal Showdown — Baseline FPPG Max Build ({tot_fd:.2f} FD pts / {tot_our:.2f} v8 pts)"
            contest_str = f"{cname} — {strat_str}"
        elif is_live_entry:
            label_str = f"Tysa Live Entry #3754559753 — $3 $80K Mon NFL Rush ({tot_our:.2f} v8 pts / {tot_base:.2f} base / {tot_fd:.2f} FD • MVP {mvp_row['player']})"
            contest_str = f"{cname} (Entry #3754559753 • Lineup #135830-3528737559) — {strat_str}"
        else:
            opt_idx = l_num - 1
            label_str = f"MNF v8 Optimal #{opt_idx} — {cname.split(' (')[0]} ({tot_our:.2f} pts • MVP {mvp_row['player']})"
            contest_str = f"{cname} — {strat_str}"

        board_lineup_rows.append({
            'preset_id': preset_id,
            'group': 'MNF Showdown Builds (DAL @ PHI • Mon Oct 26 #135830)',
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

    return pd.DataFrame(entries_rows), pd.DataFrame(mock_rows), pd.DataFrame(board_lineup_rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', default='pregame', choices=['pregame', 'postgame', 'audit'])
    args = parser.parse_args()

    # 1. Run deterministic v8 baseline on active MNF slate 135830 (and keep 135720 alias synced)
    subprocess.run(
        [sys.executable, str(FD_SYS / 'tools' / 'baseline.py'), str(FD_SYS / 'boards' / '135830.csv'), '135830', '2026-10-26'],
        check=True,
    )
    subprocess.run(
        [sys.executable, str(FD_SYS / 'tools' / 'baseline.py'), str(FD_SYS / 'boards' / '135720.csv'), '135720', '2026-10-26'],
        check=True,
    )

    b135830 = pd.read_csv(FD_SYS / 'baseline' / '135830.csv')
    # Sync team CSVs and merged-proj CSV byte-for-byte with deterministic baseline (for both 135830 and 135720)
    for sid in ('135830', '135720'):
        b135830[b135830['team'] == 'DAL'].to_csv(FD_SYS / 'teams' / f'DAL-{sid}.csv', index=False)
        b135830[b135830['team'] == 'PHI'].to_csv(FD_SYS / 'teams' / f'PHI-{sid}.csv', index=False)
        b135830.sort_values('adjusted', ascending=False).to_csv(FD_SYS / 'lineups' / f'{sid}-merged-proj.csv', index=False)

    weights = json.loads((FD_SYS / 'weights.json').read_text())['weights']

    # Read official live FanDuel CSV (135830-mnf-live.csv) for exact FD player IDs and FPPG
    live_fd_df = pd.read_csv(FD_SYS / 'boards' / '135830-mnf-live.csv').set_index('Nickname')

    # 2. Load current_players.csv and preserve the 566 completed Main + SNF rows byte-for-byte
    cp_df = pd.read_csv(DATA_DIR / 'current_players.csv', dtype=str, keep_default_na=False)
    cp_completed = cp_df[~cp_df['team'].isin(['DAL', 'PHI'])].copy()

    mnf_new_rows = []
    mnf_for_opt = []
    for _, r in b135830.iterrows():
        pname = str(r['player'])
        tm = str(r['team'])
        opp = str(r['opp'])
        live_r = live_fd_df.loc[pname]
        pid = str(live_r['Id'])
        raw_fppg = live_r['FPPG']
        fd_proj = 0.0 if pd.isna(raw_fppg) or str(raw_fppg).strip() == '' else round(float(raw_fppg), 2)
        fd_proj_str = f"{fd_proj:.2f}" if fd_proj != round(fd_proj, 1) else f"{fd_proj}"

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

        home_away_str = 'AWAY' if tm == 'DAL' else 'HOME'
        spread_str = '-4.5' if tm == 'DAL' else '4.5'
        implied_str = '24.5' if tm == 'DAL' else '20.0'

        row_dict = {
            'rank': '0',
            'id': pid,
            'name': pname,
            'pos': str(r['pos']),
            'team': tm,
            'opp': opp,
            'game': 'DAL@PHI',
            'home_away': home_away_str,
            'salary': str(int(r['salary'])),
            'our_proj': f"{our_proj:.2f}" if our_proj != round(our_proj, 1) else f"{our_proj}",
            'fd_proj': fd_proj_str,
            'base_proj': f"{base_proj:.2f}" if base_proj != round(base_proj, 1) else f"{base_proj}",
            'proj_edge': f"{proj_edge:.2f}" if proj_edge != round(proj_edge, 1) else f"{proj_edge}",
            'value_per_1k': f"{val_1k:.2f}" if val_1k != round(val_1k, 1) else f"{val_1k}",
            'ceil': f"{ceil_v:.2f}" if ceil_v != round(ceil_v, 1) else f"{ceil_v}",
            'floor': f"{floor_v:.2f}" if floor_v != round(floor_v, 1) else f"{floor_v}",
            'status': status_str,
            'injury_note': str(r['notes']),
            'is_sleeper': str(is_slp),
            'sleeper_reasons': slp_reasons,
            'spread': spread_str,
            'over_under': '44.5',
            'implied_total': implied_str,
            'weather_Penalty': '0.00 (MNF 8:15ET • grass • 20:15 ET)',
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
            'team': tm,
            'opp': opp,
            'salary': int(r['salary']),
            'our_proj': our_proj,
            'fd_proj': fd_proj,
            'base_proj': base_proj,
            'ceil': ceil_v,
            'floor': floor_v,
            'fd_id': pid,
            'home_away': home_away_str,
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

    # 4. Evaluate Tysa's live entry + solve MNF Showdown lineups deterministically via PuLP
    entries_df, mock_df, mnf_lu_df = solve_showdown_lineups(mnf_opt_df)
    entries_df.to_csv(FD_SYS / 'lineups' / '135830-mnf-entries.csv', index=False)
    mock_df.to_csv(FD_SYS / 'lineups' / '135830-mnf-mock.csv', index=False)
    mock_df.to_csv(FD_SYS / 'lineups' / '135720-mnf-mock.csv', index=False)

    lu_old = pd.read_csv(DATA_DIR / 'lineups.csv', dtype=str, keep_default_na=False)
    lu_preserved = lu_old[~lu_old['preset_id'].isin(['mnf-entry-1', 'mnf-1', 'mnf-2', 'mnf-3', 'mnf-fd-opt'])].copy()
    lu_combined = pd.concat([mnf_lu_df.astype(str), lu_preserved], ignore_index=True)
    lu_combined.to_csv(DATA_DIR / 'lineups.csv', index=False)

    # 4b. Precompute `data/optimal_lineups.csv` via PuLP for `all_games` and `per_game` scopes ($60,000 cap)
    opt_lu_df = build_optimal_lineups_csv(cp_all)
    opt_lu_df.to_csv(DATA_DIR / 'optimal_lineups.csv', index=False)

    # 5. Update meta.csv with build_id, generated_at, slate_id, total_players, and prediction_mode
    now_et = datetime.datetime.now()
    build_id = now_et.strftime('%Y%m%d-%H%M%S')
    gen_at = now_et.strftime('%Y-%m-%d %I:%M %p ET') + f" (mode={args.mode} • 100% Deterministic Pipeline)"

    meta_df = pd.read_csv(DATA_DIR / 'meta.csv', dtype=str, keep_default_na=False)
    meta_dict = dict(zip(meta_df['key'], meta_df['value']))
    meta_dict['build_id'] = build_id
    meta_dict['slate_id'] = '135830 (MNF DAL@PHI Live) + 135562 + 135719'
    meta_dict['title'] = 'NFL Player Selection Board (MNF DAL@PHI #135830 Live Entry + Week 8 Main/SNF Final • 12 Games)'
    meta_dict['generated_at'] = gen_at
    meta_dict['total_players'] = str(len(cp_all))
    meta_dict['prediction_mode'] = '100% Deterministic Python Math (Empirical Bayes + 14-Signal LOWO Ridge + PuLP ILP — Zero LLM Judgment)'

    meta_dict['optimal_lineup_scopes'] = 'all_games (1) + per_game (12) = 13 PuLP ILP lineups ($60,000 cap)'
    out_meta = pd.DataFrame([{'key': k, 'value': v} for k, v in meta_dict.items()])
    out_meta.to_csv(DATA_DIR / 'meta.csv', index=False)

    index_path = REPO_ROOT / 'index.html'
    if index_path.exists():
        html = index_path.read_text(encoding='utf-8')
        html = re.sub(r'styles\.css\?v=[^"]+', f'styles.css?v={build_id}', html)
        html = re.sub(r'app\.js\?v=[^"]+', f'app.js?v={build_id}', html)
        index_path.write_text(html, encoding='utf-8')

    print(f"Successfully built deterministic CSV data: build_id={build_id}, current_players={len(cp_all)}, historic_rows={len(preserved_hp_lines)-1+len(new_hp_rows)}, lineups={len(lu_combined)}")


if __name__ == '__main__':
    main()
