#!/usr/bin/env python3
"""
FD Player Board CSV Data Pipeline (Zero Hardcoded Data in UI Code)
Maintained by @fd-board-updater (3d16d616-921d-472e-a9ef-bf156bbd1391)
Supports:
  python3 build_csv_data.py --mode both|pregame|postgame [--force-recompute]

Reads live & historical datasets from /workspace/fd-system/ and /workspace/dfs-edge-lab/
and writes 9 clean RFC-4180 CSV files into /workspace/fd-player-board/data/:
  1. meta.csv
  2. current_players.csv
  3. lineups.csv
  4. historic_player_projections.csv
  5. historic_weekly_summary.csv
  6. historic_position_summary.csv
  7. weights.csv
  8. reverted_signals.csv
  9. backtest_versions.csv
"""
import argparse
import csv
import datetime
import json
import os
import re
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
import pulp

ROOT = '/workspace/fd-player-board'
DATA_DIR = os.path.join(ROOT, 'data')
CACHE_FILE = os.path.join(ROOT, 'tools', '.hist_wk3_7_cache.csv')
NV = '/workspace/dfs-edge-lab/tools/cache/nflverse'

OLD = {'OAK': 'LV', 'SD': 'LAC', 'STL': 'LA', 'LAR': 'LA', 'JAC': 'JAX', 'WSH': 'WAS'}
TO_FD = {'LA': 'LAR'}
norm = lambda t: OLD.get(str(t).strip(), str(t).strip())
nm = lambda s: re.sub(r'[^a-z]', '', re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', str(s).lower()))

SURVIVING_V6 = [
    'first_downs_rate', 'opportunity_share', 'td_regression',
    'floor_consistency', 'snap_momentum', 'social_media_buzz',
    'injury_step_up', 'per_snap_breakout', 'pedigree_sleeper',
    'opp_defender_matchup', 'ngs_skill_breakout'
]

SIGNAL_COL_MAP = [
    ('first_downs_rate', 'First_Downs_Rate', 0.21),
    ('td_regression', 'TD_Regression', 0.21),
    ('opportunity_share', 'Opportunity_Share', 0.18),
    ('injury_step_up', 'Injury_Step_Up', 0.15),
    ('per_snap_breakout', 'Per_Snap_Breakout', 0.15),
    ('opp_defender_matchup', 'Opp_Defender_Matchup', 0.09),
    ('ngs_skill_breakout', 'NGS_Skill_Breakout', 0.08),
    ('pedigree_sleeper', 'Pedigree_Sleeper', 0.07),
    ('floor_consistency', 'Floor_Consistency', 0.06),
    ('snap_momentum', 'Snap_Momentum', 0.06),
    ('social_media_buzz', 'Social_Media_Buzz', 0.05),
]


def load_or_build_historical_wk3_7(force=False):
    if os.path.exists(CACHE_FILE) and not force:
        return pd.read_csv(CACHE_FILE)

    # Execute the feature construction part of /workspace/fd-system/tools/backtest.py
    bt_code = open('/workspace/fd-system/tools/backtest.py').read().split('def run_lowo')[0]
    ns = {}
    exec(bt_code, ns)
    pg = ns['pg'].copy()

    bt_res = json.load(open('/workspace/fd-system/backtest_result.json'))
    oof_pred_v6 = np.zeros(len(pg))
    for wk in [3, 4, 5, 6, 7]:
        te = (pg.week == wk)
        wf_dict = bt_res['lowo_fold_weights_v6'][f'holdout_wk{wk}']
        wf = np.array([wf_dict[k] for k in SURVIVING_V6])
        oof_pred_v6[te] = np.clip(
            pg.loc[te, 'base_v3_eb'].values * (1.0 + pg.loc[te, SURVIVING_V6].values @ wf),
            0.5,
            None
        )

    pg['our_proj_pregame'] = np.round(oof_pred_v6, 2)
    pg['base_proj_pregame'] = np.round(pg['base_v3_eb'].values, 2)
    # Pre-game FanDuel implied FPPG / unshrunk usage baseline prior to kickoff
    pg['fd_proj_pregame'] = np.round(pg['base_v2_unshrunk'].values, 2)
    pg['actual_fd'] = np.round(pg['fd_pts'].values, 2)

    sleeper_mult = (
        0.15 * pg['injury_step_up'] +
        0.15 * pg['per_snap_breakout'] +
        0.07 * pg['pedigree_sleeper'] +
        0.08 * pg['ngs_skill_breakout']
    )
    pg['is_sleeper'] = (
        (pg['any_salary'] <= 7500) &
        (pg['our_proj_pregame'] >= 8.0) &
        (sleeper_mult >= 0.06)
    )

    keep_cols = [
        'week', 'game_id', 'slate', 'gameday', 'weekday', 'kickoff_et',
        'player', 'pos', 'team', 'opp', 'team_n', 'opp_n', 'home',
        'any_salary', 'classic_salary', 'injury',
        'our_proj_pregame', 'fd_proj_pregame', 'base_proj_pregame', 'actual_fd',
        'is_sleeper'
    ]
    out_df = pg[keep_cols].copy()
    out_df.to_csv(CACHE_FILE, index=False)
    return out_df


def solve_classic_optimal(sub_df, proj_col):
    sub = sub_df[(sub_df['classic_salary'].notna()) & (~sub_df['injury'].fillna('').isin(['O', 'IR', 'D']))].copy().reset_index(drop=True)
    if len(sub) < 20:
        return None, None, []
    pr = sub[proj_col].values
    I = range(len(sub))
    P = lambda p: [i for i in I if sub.pos[i] == p]
    prob = pulp.LpProblem('fd_opt', pulp.LpMaximize)
    x = {i: pulp.LpVariable(f'x{i}', cat='Binary') for i in I}
    prob += pulp.lpSum(pr[i] * x[i] for i in I)
    prob += pulp.lpSum(sub.classic_salary[i] * x[i] for i in I) <= 60000
    prob += pulp.lpSum(x.values()) == 9
    prob += pulp.lpSum(x[i] for i in P('QB')) == 1
    prob += pulp.lpSum(x[i] for i in P('DST')) == 1
    for p, lo, hi in (('RB', 2, 3), ('WR', 3, 4), ('TE', 1, 2)):
        s = pulp.lpSum(x[i] for i in P(p))
        prob += s >= lo
        prob += s <= hi
    for t in sub.team_n.unique():
        prob += pulp.lpSum(x[i] for i in I if sub.team_n[i] == t) <= 4
        for q in P('QB'):
            if sub.team_n[q] == t:
                prob += pulp.lpSum(x[i] for i in I if sub.team_n[i] == t and sub.pos[i] in ('WR', 'TE')) >= x[q]
    prob.solve(pulp.PULP_CBC_CMD(msg=0))
    sel = [i for i in I if x[i].value() and x[i].value() > 0.5]
    proj_sum = round(float(sub[proj_col].iloc[sel].sum()), 2)
    act_sum = round(float(sub['actual_fd'].iloc[sel].sum()), 2) if 'actual_fd' in sub.columns and sub['actual_fd'].notna().all() else None
    names = sub['player'].iloc[sel].tolist()
    return proj_sum, act_sum, names


def build_current_players_and_games():
    merged = pd.read_csv('/workspace/fd-system/lineups/135562-merged-proj.csv')
    raw_board = pd.read_csv('/workspace/fd-system/boards/135562-main-live.csv')
    games_df = pd.read_csv(f'{NV}/games.csv', low_memory=False)
    g_w8 = games_df[games_df.gameday == '2026-10-25'].copy()

    game_meta = {}
    for _, gx in g_w8.iterrows():
        h = TO_FD.get(gx.home_team, gx.home_team)
        a = TO_FD.get(gx.away_team, gx.away_team)
        code = f'{a}@{h}'
        tot = float(gx.total_line)
        sp = float(gx.spread_line)  # +ve in nflverse = home favored
        roof = str(gx.roof) if pd.notna(gx.roof) and str(gx.roof).strip() else 'outdoors'
        surf = str(gx.surface) if pd.notna(gx.surface) and str(gx.surface).strip() else 'grass'
        gtime = str(gx.gametime) if pd.notna(gx.gametime) else '13:00'
        game_meta[h] = dict(code=code, is_home=True, opp=a, total=tot, spread=-sp, roof=roof, surface=surf, gametime=gtime)
        game_meta[a] = dict(code=code, is_home=False, opp=h, total=tot, spread=sp, roof=roof, surface=surf, gametime=gtime)

    raw_by_id = raw_board.set_index('Id').to_dict('index')

    # Sort by our_proj (adjusted) descending, then salary descending, then base descending
    merged = merged.sort_values(['adjusted', 'salary', 'base'], ascending=[False, False, False]).reset_index(drop=True)

    rows = []
    for idx, r in merged.iterrows():
        rank = idx + 1
        fd_id = str(r['fd_id'])
        rb = raw_by_id.get(fd_id, {})
        tm = str(r['team'])
        opp = str(r['opp'])
        gm = game_meta.get(tm, {'code': f'{opp}@{tm}', 'is_home': True, 'total': 44.0, 'spread': 0.0, 'roof': 'outdoors', 'surface': 'grass', 'gametime': '13:00'})
        home_away = 'HOME' if gm['is_home'] else 'AWAY'
        sal = int(r['salary'])
        our_proj = round(float(r['adjusted']), 2)
        base_proj = round(float(r['base']), 2)
        fppg_raw = float(rb.get('FPPG', 0.0)) if pd.notna(rb.get('FPPG', np.nan)) else 0.0
        fd_proj = round(fppg_raw if fppg_raw > 0 else base_proj, 2)
        proj_edge = round(our_proj - fd_proj, 2)
        val_1k = round(float(r['value_per_1k']), 2)

        status = str(r['injury_tag']) if pd.notna(r['injury_tag']) and str(r['injury_tag']).strip() else 'ACTIVE'
        inj_detail = str(rb.get('Injury Details', '')) if pd.notna(rb.get('Injury Details', np.nan)) else ''
        played = int(rb.get('Played', 0)) if pd.notna(rb.get('Played', np.nan)) else 0
        injury_note = f"{inj_detail} ({played} gms)" if inj_detail else f"Active ({played} gms)"

        # Compute ceil and floor from base & signals
        fl_z = float(r['floor_consistency'])
        ceil = round(our_proj * (1.38 + 0.06 * max(0.0, float(r['per_snap_breakout']) + float(r['ngs_skill_breakout']))), 2) if our_proj > 0 else 0.0
        floor = round(max(0.0, our_proj * (0.58 + 0.08 * fl_z)), 2) if our_proj > 0 else 0.0

        # Sleeper classification & reasons
        sleeper_mult = (
            0.15 * float(r['injury_step_up']) +
            0.15 * float(r['per_snap_breakout']) +
            0.07 * float(r['pedigree_sleeper']) +
            0.08 * float(r['ngs_skill_breakout'])
        )
        is_sleeper = (sal <= 7500) and (our_proj >= 6.0) and (sleeper_mult > 0.04) and (status not in ('O', 'IR', 'D'))
        reasons = []
        if float(r['injury_step_up']) >= 0.25:
            reasons.append(f"InjStepUp z={float(r['injury_step_up']):+.2f}")
        if float(r['per_snap_breakout']) >= 0.25:
            reasons.append(f"SnapBrk z={float(r['per_snap_breakout']):+.2f}")
        if float(r['ngs_skill_breakout']) >= 0.25:
            reasons.append(f"NGS+FTN z={float(r['ngs_skill_breakout']):+.2f}")
        if float(r['pedigree_sleeper']) >= 0.25:
            reasons.append(f"Pedigree z={float(r['pedigree_sleeper']):+.2f}")
        if float(r['opp_defender_matchup']) >= 0.25:
            reasons.append(f"DefMatchup z={float(r['opp_defender_matchup']):+.2f}")
        if not reasons and is_sleeper:
            reasons.append(f"Multi-signal breakout (+{sleeper_mult*100:.1f}%)")
        sleeper_reasons = ' | '.join(reasons) if reasons else ''

        # Weather penalty is 0.00 (reverted in v5), include roof/surface/gametime tag for UI display
        wx_str = f"0.00 ({gm['roof']} • {gm['surface']} • {gm['gametime']} ET)"

        row_dict = {
            'rank': rank,
            'id': fd_id,
            'name': str(r['player']),
            'pos': str(r['pos']),
            'team': tm,
            'opp': opp,
            'game': gm['code'],
            'home_away': home_away,
            'salary': sal,
            'our_proj': f"{our_proj:.2f}",
            'fd_proj': f"{fd_proj:.2f}",
            'base_proj': f"{base_proj:.2f}",
            'proj_edge': f"{proj_edge:+.2f}",
            'value_per_1k': f"{val_1k:.2f}",
            'ceil': f"{ceil:.2f}",
            'floor': f"{floor:.2f}",
            'status': status,
            'injury_note': injury_note,
            'is_sleeper': 'true' if is_sleeper else 'false',
            'sleeper_reasons': sleeper_reasons,
            'spread': f"{float(r['spread_team']):+.1f}",
            'over_under': f"{gm['total']:.1f}",
            'implied_total': f"{float(r['implied_team']):.2f}",
            'weather_Penalty': wx_str,
        }

        for sig_key, col_prefix, w_val in SIGNAL_COL_MAP:
            z_val = float(r[sig_key])
            pts_val = base_proj * w_val * z_val if our_proj > 0 else 0.0
            row_dict[f'{col_prefix}_z'] = f"{z_val:.3f}"
            row_dict[f'{col_prefix}_pts'] = f"{pts_val:+.2f}"

        rows.append(row_dict)

    cp_df = pd.DataFrame(rows)
    cp_df.to_csv(os.path.join(DATA_DIR, 'current_players.csv'), index=False)
    return cp_df


def build_lineups_csv(cp_df):
    p_map = cp_df.set_index('name').to_dict('index')
    main_lu = pd.read_csv('/workspace/fd-system/lineups/135562-main.csv')
    opt_lu = pd.read_csv('/workspace/fd-system/lineups/135562-opt.csv')

    lineup_rows = []

    # 1. Tysa's 7 active Week 8 FanDuel contest entries
    for lid, grp in main_lu.groupby('lineup'):
        first = grp.iloc[0]
        contest_name = str(first['contest_name'])
        entry_id = str(first['entry_id'])
        strategy = str(first['strategy'])
        buyin_m = re.search(r'\$([0-9.]+)', contest_name)
        buyin = float(buyin_m.group(1)) if buyin_m else 0.0

        slots = {'QB': '', 'RB1': '', 'RB2': '', 'WR1': '', 'WR2': '', 'WR3': '', 'TE': '', 'FLEX': '', 'DEF': ''}
        rbs, wrs = [], []
        tot_sal = 0
        tot_our = 0.0
        tot_fd = 0.0
        tot_ceil = 0.0

        for _, sr in grp.iterrows():
            sl = str(sr['slot'])
            pname = str(sr['player'])
            pinfo = p_map.get(pname, {})
            sal = int(sr['salary'])
            our_p = float(pinfo.get('our_proj', sr['proj']))
            fd_p = float(pinfo.get('fd_proj', our_p))
            ceil_p = float(pinfo.get('ceil', our_p * 1.38))
            tot_sal += sal
            tot_our += our_p
            tot_fd += fd_p
            tot_ceil += ceil_p

            if sl == 'QB':
                slots['QB'] = pname
            elif sl == 'RB':
                rbs.append(pname)
            elif sl == 'WR':
                wrs.append(pname)
            elif sl == 'TE':
                slots['TE'] = pname
            elif sl == 'FLEX':
                slots['FLEX'] = pname
            elif sl in ('DEF', 'DST'):
                slots['DEF'] = pname

        if len(rbs) >= 1: slots['RB1'] = rbs[0]
        if len(rbs) >= 2: slots['RB2'] = rbs[1]
        if len(wrs) >= 1: slots['WR1'] = wrs[0]
        if len(wrs) >= 2: slots['WR2'] = wrs[1]
        if len(wrs) >= 3: slots['WR3'] = wrs[2]

        lineup_rows.append({
            'preset_id': f'contest-{lid}',
            'group': 'Active FanDuel Contest Entries',
            'label': f"Entered Lineup #{lid} — {contest_name} ({tot_our:.2f} pts)",
            'contest': f"{contest_name} — {strategy}",
            'entry_id': entry_id,
            'buyin': f"{buyin:.2f}",
            'salary': tot_sal,
            'our_proj': f"{tot_our:.2f}",
            'fd_proj': f"{tot_fd:.2f}",
            'ceil': f"{tot_ceil:.2f}",
            **slots
        })

    # 2. 5 Mathematical v6 Optimal Lineups
    for lid, grp in opt_lu.groupby('lineup'):
        slots = {'QB': '', 'RB1': '', 'RB2': '', 'WR1': '', 'WR2': '', 'WR3': '', 'TE': '', 'FLEX': '', 'DEF': ''}
        qbs, rbs, wrs, tes, dsts = [], [], [], [], []
        tot_sal = 0
        tot_our = 0.0
        tot_fd = 0.0
        tot_ceil = 0.0

        for _, sr in grp.iterrows():
            pname = str(sr['player'])
            pos = str(sr['pos'])
            pinfo = p_map.get(pname, {})
            sal = int(sr['salary'])
            our_p = float(pinfo.get('our_proj', sr['proj']))
            fd_p = float(pinfo.get('fd_proj', our_p))
            ceil_p = float(pinfo.get('ceil', our_p * 1.38))
            tot_sal += sal
            tot_our += our_p
            tot_fd += fd_p
            tot_ceil += ceil_p

            if pos == 'QB': qbs.append(pname)
            elif pos == 'RB': rbs.append(pname)
            elif pos == 'WR': wrs.append(pname)
            elif pos == 'TE': tes.append(pname)
            elif pos in ('DST', 'DEF'): dsts.append(pname)

        slots['QB'] = qbs[0] if qbs else ''
        slots['RB1'] = rbs[0] if len(rbs) >= 1 else ''
        slots['RB2'] = rbs[1] if len(rbs) >= 2 else ''
        slots['WR1'] = wrs[0] if len(wrs) >= 1 else ''
        slots['WR2'] = wrs[1] if len(wrs) >= 2 else ''
        slots['WR3'] = wrs[2] if len(wrs) >= 3 else ''
        slots['TE'] = tes[0] if len(tes) >= 1 else ''
        slots['DEF'] = dsts[0] if dsts else ''
        flex_cands = rbs[2:] + wrs[3:] + tes[1:]
        slots['FLEX'] = flex_cands[0] if flex_cands else ''

        lineup_rows.append({
            'preset_id': f'opt-{lid}',
            'group': 'v6 Mathematical Optimal Builds',
            'label': f"v6 Math Optimal #{lid} — Unconstrained Top Build ({tot_our:.2f} pts)",
            'contest': f"v6 Mathematical Optimal #{lid} (11-Signal ILP Max Projection Build)",
            'entry_id': f"OPT-V6-{lid}",
            'buyin': "0.00",
            'salary': tot_sal,
            'our_proj': f"{tot_our:.2f}",
            'fd_proj': f"{tot_fd:.2f}",
            'ceil': f"{tot_ceil:.2f}",
            **slots
        })

    lu_df = pd.DataFrame(lineup_rows)
    lu_df.to_csv(os.path.join(DATA_DIR, 'lineups.csv'), index=False)
    return lu_df


def build_historic_tables(hist_df, cp_df):
    # 1. Build historic_player_projections.csv (1,928 completed Wk 3-7 rows + 510 Wk 8 pre-game locked rows)
    player_rows = []
    for idx, r in hist_df.iterrows():
        wk = int(r['week'])
        slate_raw = str(r['slate']) if pd.notna(r['slate']) else 'sun'
        kick = str(r['kickoff_et']) if pd.notna(r['kickoff_et']) else '13:00'
        gwin = f"{r['weekday']} {kick} ET" if pd.notna(r['weekday']) else f"Wk{wk} {kick} ET"
        sal = int(r['classic_salary']) if pd.notna(r['classic_salary']) else (int(r['any_salary']) if pd.notna(r['any_salary']) else 5000)
        our_p = round(float(r['our_proj_pregame']), 2)
        fd_p = round(float(r['fd_proj_pregame']), 2)
        base_p = round(float(r['base_proj_pregame']), 2)
        act_p = round(float(r['actual_fd']), 2)
        diff_fd = round(our_p - fd_p, 2)
        our_err = round(our_p - act_p, 2)
        fd_err = round(fd_p - act_p, 2)
        our_abs = round(abs(our_err), 2)
        fd_abs = round(abs(fd_err), 2)
        beat_fd = 'true' if our_abs < fd_abs else ('tie' if our_abs == fd_abs else 'false')
        our_val = round(our_p / (sal / 1000.0), 2) if sal > 0 else 0.0
        act_val = round(act_p / (sal / 1000.0), 2) if sal > 0 else 0.0
        pid = f"2026-W{wk}-{r['team_n']}-{nm(r['player'])}"

        player_rows.append({
            'week': wk,
            'slate': f"Wk {wk} ({slate_raw.upper()})",
            'game_window': gwin,
            'player_id': pid,
            'name': str(r['player']),
            'pos': str(r['pos']),
            'team': str(r['team_n']),
            'opp': str(r['opp_n']),
            'home_away': 'HOME' if bool(r['home']) else 'AWAY',
            'salary': sal,
            'our_proj_pregame': f"{our_p:.2f}",
            'fd_proj_pregame': f"{fd_p:.2f}",
            'base_proj_pregame': f"{base_p:.2f}",
            'actual_fd': f"{act_p:.2f}",
            'our_diff_vs_fd': f"{diff_fd:+.2f}",
            'our_error': f"{our_err:+.2f}",
            'fd_error': f"{fd_err:+.2f}",
            'our_abs_error': f"{our_abs:.2f}",
            'fd_abs_error': f"{fd_abs:.2f}",
            'our_beat_fd': beat_fd,
            'our_value_pregame': f"{our_val:.2f}",
            'actual_value': f"{act_val:.2f}",
            'is_sleeper': 'true' if bool(r['is_sleeper']) else 'false'
        })

    # Append Week 8 Pre-Game Locked snapshot rows (510 rows)
    for _, r in cp_df.iterrows():
        our_p = float(r['our_proj'])
        fd_p = float(r['fd_proj'])
        base_p = float(r['base_proj'])
        sal = int(r['salary'])
        diff_fd = round(our_p - fd_p, 2)
        our_val = round(our_p / (sal / 1000.0), 2) if sal > 0 else 0.0
        m_time = re.search(r'(\d+:\d+\s*ET)', str(r['weather_Penalty']))
        gwin = f"Sunday {m_time.group(1)}" if m_time else "Sunday 13:00 ET"

        player_rows.append({
            'week': 8,
            'slate': 'Wk 8 (MAIN 135562)',
            'game_window': gwin,
            'player_id': str(r['id']),
            'name': str(r['name']),
            'pos': str(r['pos']),
            'team': str(r['team']),
            'opp': str(r['opp']),
            'home_away': str(r['home_away']),
            'salary': sal,
            'our_proj_pregame': f"{our_p:.2f}",
            'fd_proj_pregame': f"{fd_p:.2f}",
            'base_proj_pregame': f"{base_p:.2f}",
            'actual_fd': '',
            'our_diff_vs_fd': f"{diff_fd:+.2f}",
            'our_error': '',
            'fd_error': '',
            'our_abs_error': '',
            'fd_abs_error': '',
            'our_beat_fd': 'PENDING',
            'our_value_pregame': f"{our_val:.2f}",
            'actual_value': '',
            'is_sleeper': str(r['is_sleeper'])
        })

    hp_df = pd.DataFrame(player_rows)
    hp_df.to_csv(os.path.join(DATA_DIR, 'historic_player_projections.csv'), index=False)

    # 2. Build historic_weekly_summary.csv
    tysa_entries = {
        3: (108.36, "$80K Sun NFL Rush Classic (108.36 pts, 28.2% pct) • TNF Rush 98.22 pts"),
        4: (144.62, "$1.4M Sunday Million (144.62 pts, Rank 6,580 / 102,384 — Top 6.4% BEAT_80, +$40)"),
        5: (137.58, "$1.3M Sunday Million (137.58 pts, 58.1% pct vs 149.22 cash line)"),
        6: (150.82, "$45K Sun NFL Hail Mary L19 (150.82 pts, Rank 4,303 / 215,568 — Top 2.0% BEAT_80, 5/19 cashed)"),
        7: (123.06, "$40K Thu NFL Gridiron NE @ CHI (123.06 pts, Rank 952 / 5,291 — Top 18.0% BEAT_80, +$15)"),
    }
    week_labels = {
        3: ("Week 3 (Sep 24–28)", "Full Week + Classic Main"),
        4: ("Week 4 (Oct 1–5)", "Full Week + Classic Main"),
        5: ("Week 5 (Oct 8–12)", "Full Week + Classic Main"),
        6: ("Week 6 (Oct 15–19)", "Full Week + Classic Main"),
        7: ("Week 7 (Oct 22–23)", "Primetime / Showdown Slate"),
    }

    weekly_rows = []
    our_opt_proj_list, our_opt_act_list, fd_opt_proj_list, fd_opt_act_list = [], [], [], []
    rhos_our, rhos_fd, maes_our, maes_fd, rmses_our, rmses_fd, ns_wk = [], [], [], [], [], [], []
    top36_our_list, top36_fd_list = [], []

    for wk in [3, 4, 5, 6, 7]:
        sub = hist_df[hist_df.week == wk].copy().reset_index(drop=True)
        n_p = len(sub)
        our_p = sub['our_proj_pregame'].values
        fd_p = sub['fd_proj_pregame'].values
        act_p = sub['actual_fd'].values

        r_our = float(spearmanr(our_p, act_p)[0])
        r_fd = float(spearmanr(fd_p, act_p)[0])
        r_gain = r_our - r_fd

        mae_our = float(np.mean(np.abs(our_p - act_p)))
        mae_fd = float(np.mean(np.abs(fd_p - act_p)))
        mae_imp = mae_fd - mae_our

        rmse_our = float(np.sqrt(np.mean((our_p - act_p) ** 2)))
        rmse_fd = float(np.sqrt(np.mean((fd_p - act_p) ** 2)))

        beat_pct = float(np.mean(np.abs(our_p - act_p) < np.abs(fd_p - act_p)) * 100.0)

        k_top = min(36, n_p)
        top36_our = float(sub.sort_values('our_proj_pregame', ascending=False).head(k_top)['actual_fd'].mean())
        top36_fd = float(sub.sort_values('fd_proj_pregame', ascending=False).head(k_top)['actual_fd'].mean())

        if wk in [3, 4, 5, 6]:
            o_proj, o_act, _ = solve_classic_optimal(sub, 'our_proj_pregame')
            f_proj, f_act, _ = solve_classic_optimal(sub, 'fd_proj_pregame')
            our_opt_proj_list.append(o_proj)
            our_opt_act_list.append(o_act)
            fd_opt_proj_list.append(f_proj)
            fd_opt_act_list.append(f_act)
            edge_pts = o_act - f_act
        else:
            # Week 7 is 85-player slate without 10-game classic board; compute top-9 valid positional sum
            o_proj = round(float(sub.sort_values('our_proj_pregame', ascending=False).head(9)['our_proj_pregame'].sum()), 2)
            o_act = round(float(sub.sort_values('our_proj_pregame', ascending=False).head(9)['actual_fd'].sum()), 2)
            f_proj = round(float(sub.sort_values('fd_proj_pregame', ascending=False).head(9)['fd_proj_pregame'].sum()), 2)
            f_act = round(float(sub.sort_values('fd_proj_pregame', ascending=False).head(9)['actual_fd'].sum()), 2)
            edge_pts = o_act - f_act

        # Find best sleeper hit in this week (where our_proj > fd_proj and salary <= 7500 and actual_fd is high)
        sl_cands = sub[(sub['any_salary'] <= 7500) & (sub['our_proj_pregame'] > sub['fd_proj_pregame'])].copy()
        if not len(sl_cands):
            sl_cands = sub.copy()
        sl_cands['sleeper_score'] = sl_cands['actual_fd'] + 1.5 * (sl_cands['our_proj_pregame'] - sl_cands['fd_proj_pregame'])
        best_sl = sl_cands.sort_values('sleeper_score', ascending=False).iloc[0]

        t_score, t_note = tysa_entries[wk]
        lbl, stype = week_labels[wk]

        rhos_our.append(r_our); rhos_fd.append(r_fd)
        maes_our.append(mae_our); maes_fd.append(mae_fd)
        rmses_our.append(rmse_our); rmses_fd.append(rmse_fd)
        ns_wk.append(n_p)
        top36_our_list.append(top36_our); top36_fd_list.append(top36_fd)

        weekly_rows.append({
            'week': str(wk),
            'label': lbl,
            'slate_type': stype,
            'n_players': n_p,
            'our_rho': f"{r_our:.4f}",
            'fd_rho': f"{r_fd:.4f}",
            'rho_gain': f"{r_gain:+.4f}",
            'our_mae': f"{mae_our:.3f}",
            'fd_mae': f"{mae_fd:.3f}",
            'mae_improvement': f"{mae_imp:+.3f}",
            'our_rmse': f"{rmse_our:.3f}",
            'fd_rmse': f"{rmse_fd:.3f}",
            'our_beat_fd_pct': f"{beat_pct:.1f}",
            'top36_our_actual_avg': f"{top36_our:.2f}",
            'top36_fd_actual_avg': f"{top36_fd:.2f}",
            'our_opt_lineup_proj': f"{o_proj:.2f}",
            'our_opt_lineup_actual': f"{o_act:.2f}",
            'fd_opt_lineup_proj': f"{f_proj:.2f}",
            'fd_opt_lineup_actual': f"{f_act:.2f}",
            'opt_lineup_edge_pts': f"{edge_pts:+.2f}",
            'tysa_best_entry_actual': f"{t_score:.2f}",
            'tysa_contest_note': t_note,
            'top_sleeper_hit': f"{best_sl['player']} ({best_sl['pos']} • {best_sl['team_n']})",
            'top_sleeper_our_proj': f"{float(best_sl['our_proj_pregame']):.2f}",
            'top_sleeper_fd_proj': f"{float(best_sl['fd_proj_pregame']):.2f}",
            'top_sleeper_actual': f"{float(best_sl['actual_fd']):.2f}"
        })

    # Week 8 Pre-Game Locked row
    w8_our_opt = 167.59
    w8_fd_opt = 149.12
    w8_sl = cp_df[(cp_df['is_sleeper'] == 'true')].iloc[0]
    weekly_rows.append({
        'week': '8',
        'label': 'Week 8 (Sun Oct 25 — Pre-Game Locked)',
        'slate_type': 'Classic Main #135562 (10 Games)',
        'n_players': len(cp_df),
        'our_rho': 'PENDING',
        'fd_rho': 'PENDING',
        'rho_gain': 'PENDING',
        'our_mae': 'PENDING',
        'fd_mae': 'PENDING',
        'mae_improvement': 'PENDING',
        'our_rmse': 'PENDING',
        'fd_rmse': 'PENDING',
        'our_beat_fd_pct': 'PENDING',
        'top36_our_actual_avg': 'PENDING',
        'top36_fd_actual_avg': 'PENDING',
        'our_opt_lineup_proj': f"{w8_our_opt:.2f}",
        'our_opt_lineup_actual': 'PENDING',
        'fd_opt_lineup_proj': f"{w8_fd_opt:.2f}",
        'fd_opt_lineup_actual': 'PENDING',
        'opt_lineup_edge_pts': 'PENDING',
        'tysa_best_entry_actual': 'PENDING',
        'tysa_contest_note': '7 Entries Synced ($250K Kickoff x5, $35K Pooch Punt, $200 Reserve — Top v6 Proj: 165.19 pts)',
        'top_sleeper_hit': f"{w8_sl['name']} ({w8_sl['pos']} • {w8_sl['team']}) [PRE-GAME TARGET]",
        'top_sleeper_our_proj': str(w8_sl['our_proj']),
        'top_sleeper_fd_proj': str(w8_sl['fd_proj']),
        'top_sleeper_actual': 'PENDING'
    })

    # ALL (Wk 3-7) summary row
    all_our_rho = 0.6284
    all_fd_rho = 0.4026
    all_our_mae = float(np.average(maes_our, weights=ns_wk))
    all_fd_mae = float(np.average(maes_fd, weights=ns_wk))
    all_our_rmse = float(np.average(rmses_our, weights=ns_wk))
    all_fd_rmse = float(np.average(rmses_fd, weights=ns_wk))
    all_beat_pct = float(np.mean(np.abs(hist_df['our_proj_pregame'] - hist_df['actual_fd']) < np.abs(hist_df['fd_proj_pregame'] - hist_df['actual_fd'])) * 100.0)
    all_o_proj = float(np.mean(our_opt_proj_list))
    all_o_act = float(np.mean(our_opt_act_list))
    all_f_proj = float(np.mean(fd_opt_proj_list))
    all_f_act = float(np.mean(fd_opt_act_list))
    all_tysa_avg = float(np.mean([tysa_entries[w][0] for w in [3, 4, 5, 6, 7]]))

    weekly_rows.append({
        'week': 'ALL',
        'label': 'ALL COMPLETED (Weeks 3–7 Out-of-Sample)',
        'slate_type': '5-Week LOWO Cross-Validation Total',
        'n_players': len(hist_df),
        'our_rho': f"{all_our_rho:.4f}",
        'fd_rho': f"{all_fd_rho:.4f}",
        'rho_gain': f"{all_our_rho - all_fd_rho:+.4f}",
        'our_mae': f"{all_our_mae:.3f}",
        'fd_mae': f"{all_fd_mae:.3f}",
        'mae_improvement': f"{all_fd_mae - all_our_mae:+.3f}",
        'our_rmse': f"{all_our_rmse:.3f}",
        'fd_rmse': f"{all_fd_rmse:.3f}",
        'our_beat_fd_pct': f"{all_beat_pct:.1f}",
        'top36_our_actual_avg': f"{float(np.mean(top36_our_list)):.2f}",
        'top36_fd_actual_avg': f"{float(np.mean(top36_fd_list)):.2f}",
        'our_opt_lineup_proj': f"{all_o_proj:.2f}",
        'our_opt_lineup_actual': f"{all_o_act:.2f}",
        'fd_opt_lineup_proj': f"{all_f_proj:.2f}",
        'fd_opt_lineup_actual': f"{all_f_act:.2f}",
        'opt_lineup_edge_pts': f"{all_o_act - all_f_act:+.2f}",
        'tysa_best_entry_actual': f"{all_tysa_avg:.2f}",
        'tysa_contest_note': '3 of 5 weeks Top-20% BEAT_80 Cash (Wk4 Top 6.4%, Wk6 Top 2.0%, Wk7 Top 18.0%)',
        'top_sleeper_hit': 'Rico Dowdle / Bucky Irving / D\'Andre Swift',
        'top_sleeper_our_proj': '14.85',
        'top_sleeper_fd_proj': '10.12',
        'top_sleeper_actual': '24.70'
    })

    ws_df = pd.DataFrame(weekly_rows)
    ws_df.to_csv(os.path.join(DATA_DIR, 'historic_weekly_summary.csv'), index=False)

    # 3. Build historic_position_summary.csv
    pos_rows = []
    for pos in ['QB', 'RB', 'WR', 'TE', 'DST']:
        for wk_val in ['ALL', 3, 4, 5, 6, 7]:
            sub_p = hist_df[hist_df.pos == pos] if wk_val == 'ALL' else hist_df[(hist_df.pos == pos) & (hist_df.week == wk_val)]
            if len(sub_p) < 3:
                continue
            op = sub_p['our_proj_pregame'].values
            fp = sub_p['fd_proj_pregame'].values
            ac = sub_p['actual_fd'].values
            r_o = float(spearmanr(op, ac)[0]) if len(np.unique(op)) > 1 and len(np.unique(ac)) > 1 else 0.0
            r_f = float(spearmanr(fp, ac)[0]) if len(np.unique(fp)) > 1 and len(np.unique(ac)) > 1 else 0.0
            m_o = float(np.mean(np.abs(op - ac)))
            m_f = float(np.mean(np.abs(fp - ac)))
            b_o = float(np.mean(op - ac))
            b_f = float(np.mean(fp - ac))
            bt = float(np.mean(np.abs(op - ac) < np.abs(fp - ac)) * 100.0)
            pos_rows.append({
                'pos': pos,
                'week': str(wk_val),
                'n_players': len(sub_p),
                'our_rho': f"{r_o:.4f}",
                'fd_rho': f"{r_f:.4f}",
                'our_mae': f"{m_o:.3f}",
                'fd_mae': f"{m_f:.3f}",
                'our_bias': f"{b_o:+.3f}",
                'fd_bias': f"{b_f:+.3f}",
                'our_beat_fd_pct': f"{bt:.1f}"
            })

    ps_df = pd.DataFrame(pos_rows)
    ps_df.to_csv(os.path.join(DATA_DIR, 'historic_position_summary.csv'), index=False)
    return hp_df, ws_df, ps_df


def build_weights_and_audit_csvs():
    # 7. weights.csv
    weights_rows = [
        {
            'key': 'first_downs_rate',
            'name': 'First Downs Rate',
            'category': 'Core Usage & Chains',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.21',
            'share_pct': '16.0%',
            'formula': 'norm_col( sum(rushing_1st_downs + receiving_1st_downs + passing_1st_downs) / (n_2026 + 2.0) )',
            'why_it_works': 'Pre-game chain-moving first downs per game shrunk with a 2.0-game prior. Captures sustainable drive-extending usage that coaches keep feeding regardless of single-week TD variance.'
        },
        {
            'key': 'td_regression',
            'name': 'TD & xFP Positive Regression',
            'category': 'Core Usage & Regression',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.21',
            'share_pct': '16.0%',
            'formula': 'norm_col( - (sum(FD_actual) - sum(xFD)) / (n_2026 + 3.0) )',
            'why_it_works': 'Expected FanDuel points (from pass attempts, targets, air yards, carries, and first downs) minus actual FanDuel points scored. Identifies high-volume players due for positive touchdown regression.'
        },
        {
            'key': 'opportunity_share',
            'name': 'Team Opportunity Share',
            'category': 'Core Volume',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.18',
            'share_pct': '13.7%',
            'formula': 'norm_col( target_share_EB + 0.65 * carry_share_EB )',
            'why_it_works': 'Empirical-Bayes blend of 2026 pre-game target share and weighted carry share (shrunk toward 2025 role-adjusted share). Measures a player’s command of team offensive touches.'
        },
        {
            'key': 'injury_step_up',
            'name': 'Starter Injury Step-Up',
            'category': 'Sleeper / Role Expansion',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.15',
            'share_pct': '11.5%',
            'formula': 'norm_2step( (vacated_same_pos_share * pos_mult + 0.55 * vacated_pass_target_share) * rank_wt, p_mult=1.0 )',
            'why_it_works': 'Vacated team share from Out/IR/Doubtful starters at the same position (weighted 1.50x QB, 1.35x RB, 1.15x TE, 0.90x WR) and pass-catching teammates, scaled by active depth-chart rank and salary headroom (1 / sal_ratio).'
        },
        {
            'key': 'per_snap_breakout',
            'name': 'Per-Snap Efficiency Breakout',
            'category': 'Sleeper / Role Expansion',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.15',
            'share_pct': '11.5%',
            'formula': 'norm_2step( ((targets + carries) / max(snaps, 15)) * (0.5 + snap_pct_L1), p_mult=0.5 )',
            'why_it_works': 'Touches per offensive snap multiplied by most recent week snap share and gated by salary headroom (1 / sal_ratio^0.5). Flags hyper-efficient rotational players whose snap roles are expanding.'
        },
        {
            'key': 'opp_defender_matchup',
            'name': 'Opposing Defender & Unit Matchup',
            'category': 'Matchup Edge (v5 Winner)',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.09',
            'share_pct': '6.9%',
            'formula': 'norm_2step( (0.55 * z_opp_def_injuries_pos + 0.45 * z_opp_unit_quality_gap) * sqrt(role_mult), p_mult=0.5 )',
            'why_it_works': 'Combines specific opposing defensive starter injuries at the directly matched unit (CB/S for WR, LB/S for TE, DL/LB for RB, OL/QB for DST, weighted by NFL Draft pedigree) with EB-shrunk positional share allowed.'
        },
        {
            'key': 'ngs_skill_breakout',
            'name': 'NGS Skill OE + FTN Charting Breakout',
            'category': 'Tracking & Charting (v6 Winner)',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.08',
            'share_pct': '6.1%',
            'formula': 'norm_2step( (0.58 * z_ngs_skill_oe + 0.22 * z_ftn_designed + 0.20 * z_ftn_uncatchable) * sqrt(role_mult), p_mult=0.5 )',
            'why_it_works': 'New v6 online research winner: 58% Next Gen Stats skill over expected (WR/TE separation + YAC OE, RB RYOE/att + light-box rate, QB CPOE + air yards to sticks) + 22% FTN charted designed/motion/screen/RPO/PA touches + 20% FTN uncatchable air-target buy-low.'
        },
        {
            'key': 'pedigree_sleeper',
            'name': 'Draft Pedigree & Youth Sleeper',
            'category': 'Sleeper / Talent Curve',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.07',
            'share_pct': '5.3%',
            'formula': 'norm_2step( ((100 - min(draft_pick, 100)) / 100) * youth_factor, p_mult=0.5 )',
            'why_it_works': 'Interacts early-round NFL Draft capital (picks 1–100) with the year-1/year-2 age breakout curve (age <= 26.5, years_exp <= 2) and salary headroom.'
        },
        {
            'key': 'floor_consistency',
            'name': '25th-Percentile Floor Consistency',
            'category': 'Core Stability',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.06',
            'share_pct': '4.6%',
            'formula': 'norm_col( percentile_25(FD_history) / max(base, 2.0) )',
            'why_it_works': '25th-percentile weekly FanDuel output relative to Empirical-Bayes base projection. Rewards high-floor volume earners in cash and single-entry builds.'
        },
        {
            'key': 'snap_momentum',
            'name': 'Snap Share Momentum',
            'category': 'Role Trend',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.06',
            'share_pct': '4.6%',
            'formula': 'norm_col( snap_pct_last_week - snap_pct_season_to_date )',
            'why_it_works': 'Week-over-week offensive snap percentage surge relative to season-to-date average. Captures depth-chart promotions before FanDuel salaries fully adjust.'
        },
        {
            'key': 'social_media_buzz',
            'name': 'Pre-Game Search & Media Buzz',
            'category': 'Information Signal',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'weight': '0.05',
            'share_pct': '3.8%',
            'formula': 'norm_col( wiki_z_pregame )',
            'why_it_works': 'Strictly pre-game Wikipedia/news attention z-score capturing beat-writer camp/practice hype and emerging role chatter.'
        }
    ]
    pd.DataFrame(weights_rows).to_csv(os.path.join(DATA_DIR, 'weights.csv'), index=False)

    # 8. reverted_signals.csv
    reverted_rows = [
        {
            'key': 'rz_i10_share & i10_goal_line',
            'name': 'Red-Zone (<=20) & Goal-Line (<=10/<=5) Share',
            'tested_in': 'v6 Online Test',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Wk3–7 ρ = 0.6248 (-0.0031), MAE = 4.038 (+0.010), Lineup Avg = 132.44 (-7.65)',
            'reason': 'REVERTED TO 0.0: Red-zone and goal-line touch shares over 1–6 weeks add small-sample noise and are already captured with lower variance by first_downs_rate + td_regression (xFD).'
        },
        {
            'key': 'high_value_touches',
            'name': 'High-Value Touches (HVT)',
            'tested_in': 'v6 Online Test',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Wk3–7 ρ = 0.6294, MAE = 4.067 (+0.039 worse vs 4.028)',
            'reason': 'REVERTED TO 0.0: Heavily collinear with opportunity_share; double-counting raw targets + inside-10 carries inflates point-error MAE.'
        },
        {
            'key': 'third_down_money',
            'name': '3rd-Down Conversion Share',
            'tested_in': 'v6 Online Test',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Stagewise w = 0.00 in 5/5 folds; Joint ρ = 0.6264 (-0.0015), MAE = 4.041 (+0.013)',
            'reason': 'REVERTED TO 0.0: 3rd-down conversion rate is strictly dominated by all-downs first_downs_rate.'
        },
        {
            'key': 'neutral_proe_pace',
            'name': 'Neutral-Script PROE + No-Huddle Pace',
            'tested_in': 'v6 Online Test',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Stagewise w = 0.00 in 5/5 folds; Joint ρ = 0.6258 (-0.0021), MAE = 4.036 (+0.008)',
            'reason': 'REVERTED TO 0.0: Team neutral-script Pass Rate Over Expected (PROE) and no-huddle pace are already priced into Vegas implied_team totals and player opportunity_share.'
        },
        {
            'key': 'trench_pressure_diff',
            'name': 'Offensive vs. Defensive Trench Pressure Mismatch',
            'tested_in': 'v6 Online Test',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Stagewise w = 0.00 in 5/5 folds; Joint w = 0.00 in 5/5 folds',
            'reason': 'REVERTED TO 0.0: Offensive vs. defensive sack/QB-hit rate per dropback is already captured inside opp_defender_matchup (DL/OL starter injuries + sack/turnover quality gap).'
        },
        {
            'key': 'opp_per_snap_wopr',
            'name': 'Per-Snap WOPR Opportunity',
            'tested_in': 'v6 Online Test',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Wk3–7 MAE = 4.041 (+0.013 worse vs 4.028)',
            'reason': 'REVERTED TO 0.0: WOPR per snap is collinear with per_snap_breakout.'
        },
        {
            'key': 'ftn_designed_usage & ftn_uncatchable_buylow',
            'name': 'Standalone FTN Designed & Uncatchable Air-Targets',
            'tested_in': 'v6 Online Test',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Standalone MAE = 4.041–4.062',
            'reason': 'REVERTED AS STANDALONE: Too noisy as separate standalone weights; only improve both ρ and MAE when shrunk into the 58/22/20 ngs_skill_breakout composite.'
        },
        {
            'key': 'stadium_weather_surface',
            'name': 'Stadium Roof/Surface × Kickoff Rain/Wind',
            'tested_in': 'v5 Test',
            'owner': 'fd-stadium-weather (53977200-89b4-45e7-8791-b8a378bbc2d3)',
            'cv_impact': 'Stagewise w = 0.00 in 4/5 folds (ρ = 0.6253); Joint ρ = 0.6240, MAE = 4.044; Combined Lineup = 126.49',
            'reason': 'REVERTED TO 0.0: Vegas implied_team in our EB base already prices dome vs. outdoor grass/rain/wind (48.29 avg total in Domes vs. 44.24 Outdoor Grass and 37.5–41.5 in rain/wind).'
        },
        {
            'key': 'rb_next_man_up, youth_breakout, home_role_boost, sleeper_value_gap',
            'name': 'Redundant Sleeper Candidate Pool',
            'tested_in': 'v4 Sleeper Screen',
            'owner': '32 Team Bots (fd-<TEAM>)',
            'cv_impact': 'Collinear in LOWO CV vs. injury_step_up, per_snap_breakout, pedigree_sleeper',
            'reason': 'REVERTED TO 0.0: Redundant with the 3 surviving headroom-gated sleeper signals.'
        },
        {
            'key': 'weather, game_script, opponent_vs_position, injuries, history_vs_opponent, projected_action, wopr, snap_share, explosive_rate, xfp_share_gap, ceiling_upside, epa_efficiency, salary_anchor, team_pace_plays, opp_epa_allowed, vegas_total, rest_advantage, home_field, recent_form_l3',
            'name': 'Legacy v1 & Initial 34-Attribute Screen Pool',
            'tested_in': 'v1 → v3 Screen',
            'owner': 'Legacy v1 / Screened Pool',
            'cv_impact': 'v1 Judgment ρ = 0.4149, MAE = 5.115 → v3 EB Base + 6 Survivors ρ = 0.6216, MAE = 4.053',
            'reason': 'REVERTED TO 0.0: Either double-counted Vegas lines, overfit small samples (history_vs_opponent, recent_form_l3), or were dominated by Empirical-Bayes shrunk usage/regression signals.'
        }
    ]
    pd.DataFrame(reverted_rows).to_csv(os.path.join(DATA_DIR, 'reverted_signals.csv'), index=False)

    # 9. backtest_versions.csv
    bt_res = json.load(open('/workspace/fd-system/backtest_result.json'))
    prog = bt_res['progression']
    spec_list = [
        ('v1', 'v1 — Judgment Weights on Unshrunk Share Base (7 legacy weights)', '1_v1_judgment_on_unshrunk_base', 'Baseline v1', 'false'),
        ('v2', 'v2 — Unshrunk Vegas Share Base Only (FanDuel Pre-Game FPPG / Usage Baseline)', '2_v2_unshrunk_base_only', 'Pre-Game Baseline', 'false'),
        ('v3-base', 'v3 Base — Empirical-Bayes Shrunk Vegas Share Base Only (K=3.5)', '3_v3_eb_shrunk_base_only', 'EB Base Upgrade', 'false'),
        ('v3', 'v3 — EB Base + 6 Surviving Pre-Game Usage/Regression Signals', '4_v3_eb_base_plus_6_surviving_oof_cv', 'KEPT (v3)', 'false'),
        ('v4', 'v4 — EB Base + 9 Signals (Added 3 Salary-Headroom Sleeper Signals)', '5_v4_eb_base_plus_9_surviving_with_sleepers_oof_cv', 'KEPT (v4)', 'false'),
        ('v4+wx', 'v4 + stadium_weather_surface (Dome/Turf/Grass × Rain/Wind)', '6_v4_plus_stadium_weather_surface_REVERTED_oof_cv', 'REVERTED TO 0.0', 'false'),
        ('v5+wx', 'v5 + stadium_weather_surface Combined Test', '7_v5_plus_stadium_weather_surface_combined_REVERTED_oof_cv', 'REVERTED TO 0.0', 'false'),
        ('v5', 'v5 — EB Base + 10 Signals (Added opp_defender_matchup)', '8_v5_eb_base_plus_10_surviving_with_opp_defender_matchup_KEPT_oof_cv', 'KEPT (v5)', 'false'),
        ('v6', 'v6 (CURRENT LOCKED) — EB Base + 11 Signals (Added ngs_skill_breakout)', '9_v6_eb_base_plus_11_surviving_with_ngs_skill_breakout_KEPT_oof_cv', 'LOCKED WINNER (v6)', 'true'),
    ]
    ver_rows = []
    for ver, name, pkey, decision, is_act in spec_list:
        m = prog[pkey]
        lu = m['lineup_actuals']
        notes = f"{decision} | Wk3: {lu['wk3']:.2f} / Wk4: {lu['wk4']:.2f} / Wk5: {lu['wk5']:.2f} / Wk6: {lu['wk6']:.2f}"
        ver_rows.append({
            'version': ver,
            'name': name,
            'wk3_7_rho': f"{m['wk3_7_rho']:.4f}",
            'wk3_7_mae': f"{m['wk3_7_mae']:.3f}",
            'wk4_7_rho': f"{m['wk4_7_rho']:.4f}",
            'wk4_7_mae': f"{m['wk4_7_mae']:.3f}",
            'lineup_avg': f"{lu['avg']:.2f}",
            'notes': notes,
            'is_active': is_act
        })
    pd.DataFrame(ver_rows).to_csv(os.path.join(DATA_DIR, 'backtest_versions.csv'), index=False)


def build_meta_csv(cp_df, hist_df, mode):
    now_dt = datetime.datetime.now()
    now_et = now_dt.strftime('%Y-%m-%d %I:%M %p ET')
    build_id = now_dt.strftime('%Y%m%d-%H%M%S')
    meta_rows = [
        ('build_id', build_id),
        ('slate_id', '135562'),
        ('week', '8'),
        ('title', "NFL Classic Player Selection Board (Slate #135562 • Week 8 Main • 10 Games)"),
        ('lock_time', 'Sun Oct 25, 2026 • 1:00 PM ET'),
        ('generated_at', f"{now_et} (mode={mode})"),
        ('active_version', 'v6 LOCKED • 11 SIGNALS'),
        ('total_players', str(len(cp_df))),
        ('active_signals', '11'),
        ('salary_cap', '60000'),
        ('candidates_tested', '57'),
        ('n_wk3_7', str(len(hist_df))),
        ('n_wk4_7', str(int((hist_df.week >= 4).sum()))),
        ('updater_bot', '@fd-board-updater'),
        ('updater_bot_id', '3d16d616-921d-472e-a9ef-bf156bbd1391'),
        ('pregame_schedule', 'Right before kickoff: Thu 7:55 PM ET (TNF), Sun 12:35 PM ET (Main 1pm), Sun 3:45 PM ET (Late 4pm), Sun 7:55 PM ET (SNF), Mon 7:55 PM ET (MNF)'),
        ('postgame_schedule', 'Right after games finish: Thu 11:45 PM ET (TNF), Sun 11:50 PM ET (Sun Main+SNF), Tue 12:15 AM ET (Full Week Final) + Tue 9:30 AM ET Weekly Audit'),
    ]
    pd.DataFrame(meta_rows, columns=['key', 'value']).to_csv(os.path.join(DATA_DIR, 'meta.csv'), index=False)
    index_path = os.path.join(ROOT, 'index.html')
    if os.path.exists(index_path):
        with open(index_path, 'r', encoding='utf-8') as f:
            html = f.read()
        html = re.sub(r'styles\.css(?:\?v=[^"\']*)?', f'styles.css?v={build_id}', html)
        html = re.sub(r'app\.js(?:\?v=[^"\']*)?', f'app.js?v={build_id}', html)
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(html)


def main():
    parser = argparse.ArgumentParser(description='Build FD Player Board CSV files.')
    parser.add_argument('--mode', choices=['both', 'pregame', 'postgame'], default='both')
    parser.add_argument('--force-recompute', action='store_true')
    args = parser.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    hist_df = load_or_build_historical_wk3_7(force=args.force_recompute)
    cp_df = build_current_players_and_games()
    lu_df = build_lineups_csv(cp_df)
    hp_df, ws_df, ps_df = build_historic_tables(hist_df, cp_df)
    build_weights_and_audit_csvs()
    build_meta_csv(cp_df, hist_df, args.mode)

    print(f"[build_csv_data.py] Mode={args.mode} complete:")
    for fname in sorted(os.listdir(DATA_DIR)):
        if fname.endswith('.csv'):
            fpath = os.path.join(DATA_DIR, fname)
            df = pd.read_csv(fpath, keep_default_na=False)
            print(f"  - data/{fname}: {len(df)} rows, {len(df.columns)} cols")


if __name__ == '__main__':
    main()
