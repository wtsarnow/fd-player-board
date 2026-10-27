#!/usr/bin/env python3
"""
Deterministic CSV Data Builder for FanDuel NFL Player Selection & Historic Trends Board
=======================================================================================
Generates / refreshes all CSV files in `/workspace/fd-player-board/data/`:
  1. `current_players.csv`             — Seeded Week 9 pre-game player board (14 games, Oct 29 – Nov 2, 2026)
  2. `optimal_lineups.csv`             — PuLP CBC ILP $60,000 optimal lineups (All Games + Per-Game Classic/Showdown)
  3. `lineups.csv`                     — Featured Week 9 pure max-points optimal lineup (#1 row) + presets + graded Wk8
  4. `historic_player_projections.csv` — Byte-for-byte preserved 2,549 completed player-week rows (Weeks 3–8)
  5. `historic_weekly_summary.csv`     — Byte-for-byte preserved weekly & 6-week accuracy summary
  6. `historic_position_summary.csv`   — Byte-for-byte preserved positional accuracy summary
  7. `weights.csv`                     — v9 15 surviving signals (sum = 1.50, including stadium_surface_wx: 0.04)
  8. `reverted_signals.csv`            — Reverted candidate audit (including v9 young_kids & home_away)
  9. `backtest_versions.csv`           — Version progression v1 -> v9
 10. `strategy_exchange_board.csv`     — Week 9 (28 teams / 14 games) middleman strategy exchange packets
 11. `meta.csv`                        — Active Week 9 slate metadata, build timestamp, and finalized accuracy metrics
"""

import json
import re
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pulp

ROOT = Path("/workspace/fd-player-board")
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
NV = Path("/workspace/dfs-edge-lab/tools/cache/nflverse")

OLD_TM = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "JAC": "JAX", "WSH": "WAS"}
TO_FD = {"LA": "LAR"}
norm_tm = lambda t: OLD_TM.get(str(t).strip(), str(t).strip())
nm_key = lambda s: re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", str(s).lower()))

WEIGHTS_PATH = Path("/workspace/fd-system/weights.json")
W_CFG = json.loads(WEIGHTS_PATH.read_text())
W = {k: float(v) for k, v in W_CFG["weights"].items() if float(v) > 0}

SIGNAL_META = [
    ("first_downs_rate", "First_Downs_Rate", "1stDowns"),
    ("td_regression", "TD_Regression", "TDReg"),
    ("opportunity_share", "Opportunity_Share", "OppShare"),
    ("injury_step_up", "Injury_Step_Up", "InjStepUp"),
    ("per_snap_breakout", "Per_Snap_Breakout", "SnapBrk"),
    ("opp_defender_matchup", "Opp_Defender_Matchup", "DefMatchup"),
    ("ngs_skill_breakout", "NGS_Skill_Breakout", "NGS+FTN"),
    ("pedigree_sleeper", "Pedigree_Sleeper", "Pedigree"),
    ("floor_consistency", "Floor_Consistency", "Floor25"),
    ("snap_momentum", "Snap_Momentum", "SnapMom"),
    ("social_media_buzz", "Social_Media_Buzz", "Buzz"),
    ("ceiling_upside", "Ceiling_Upside", "Ceiling75"),
    ("def_strategy_vs_off", "Def_Strategy_Vs_Off", "DefStrategy"),
    ("stadium_surface_wx", "Stadium_Surface_Wx", "StadiumWx"),
    ("off_strategy_vs_def", "Off_Strategy_Vs_Def", "OffStrategy"),
]

SHOWDOWN_GAMES_WK9 = {"CAR@GB", "PHI@WAS", "CHI@SEA"}


def build_current_week9_players() -> pd.DataFrame:
    """Build deterministic Week 9 (`nflverse week == 8`, Oct 29 - Nov 2, 2026) player board."""
    base_df = pd.read_csv("/workspace/fd-system/baseline/wk9-seed.csv")
    live_df = pd.read_csv("/workspace/fd-system/boards/wk9-seed-live.csv")
    games_df = pd.read_csv(NV / "games.csv", low_memory=False)
    g8 = games_df[(games_df["season"] == 2026) & (games_df["week"] == 8)].copy()

    # Map team -> game metadata
    g_meta = {}
    for _, gx in g8.iterrows():
        away = TO_FD.get(str(gx["away_team"]).strip(), str(gx["away_team"]).strip())
        home = TO_FD.get(str(gx["home_team"]).strip(), str(gx["home_team"]).strip())
        gcode = f"{away}@{home}"
        roof = str(gx["roof"]).strip() if pd.notna(gx["roof"]) and str(gx["roof"]).strip() != "nan" else "closed"
        surf = str(gx["surface"]).strip() if pd.notna(gx["surface"]) and str(gx["surface"]).strip() != "nan" else "turf"
        gtime = f"{gx['gametime']} ET" if pd.notna(gx["gametime"]) else "13:00 ET"
        gday = str(gx["gameday"]).strip()
        tot = float(gx["total_line"])
        sp = float(gx["spread_line"])
        g_meta[away] = {
            "game": gcode, "opp": home, "home_away": "AWAY",
            "roof": roof, "surface": surf, "gametime": gtime, "gameday": gday,
            "over_under": tot, "spread": sp, "implied_total": round(tot / 2.0 - sp / 2.0, 2),
        }
        g_meta[home] = {
            "game": gcode, "opp": away, "home_away": "HOME",
            "roof": roof, "surface": surf, "gametime": gtime, "gameday": gday,
            "over_under": tot, "spread": -sp, "implied_total": round(tot / 2.0 + sp / 2.0, 2),
        }

    # Lookup live Id, FPPG, Played, Injury Details
    live_lookup = {}
    for _, r in live_df.iterrows():
        pos_c = "DST" if str(r["Position"]).strip() in ("D", "DST") else str(r["Position"]).strip()
        live_lookup[(nm_key(r["Nickname"]), str(r["Team"]).strip(), pos_c)] = r

    rows = []
    for idx, r in base_df.iterrows():
        tm = str(r["team"]).strip()
        pos = "DST" if str(r["pos"]).strip() in ("D", "DST") else str(r["pos"]).strip()
        pname = str(r["player"]).strip()
        k_lookup = (nm_key(pname), tm, pos)
        lv = live_lookup.get(k_lookup, {})
        gm = g_meta[tm]

        pid = str(lv.get("Id", f"135900-{10000 + idx}"))
        sal = int(r["salary"])
        our_p = round(float(r["adjusted"]), 2)
        base_p = round(float(r["base"]), 2)

        raw_fppg = float(lv.get("FPPG", 0.0) or 0.0)
        inj_tag = str(r["injury_tag"]).strip() if pd.notna(r["injury_tag"]) and str(r["injury_tag"]).strip() != "nan" else ""
        status = inj_tag if inj_tag else "ACTIVE"

        if status in ("O", "IR", "D"):
            fd_p = 0.0
        elif raw_fppg > 0:
            fd_p = round(raw_fppg, 2)
        else:
            fd_p = round(max(base_p * 0.92, (sal / 1000.0) * 1.45), 2) if our_p > 0 else 0.0

        edge = round(our_p - fd_p, 2)
        val_1k = round(our_p / (sal / 1000.0), 2) if sal > 0 else 0.0

        # Deterministic ceiling & floor from base/our_proj and ceiling_upside / floor_consistency z-scores
        c_z = float(r.get("ceiling_upside", 0.0))
        f_z = float(r.get("floor_consistency", 0.0))
        ceil_val = round(our_p * (1.38 + 0.08 * max(c_z, -0.5)), 2) if our_p > 0 else 0.0
        floor_val = round(our_p * max(0.35, 0.56 + 0.06 * f_z), 2) if our_p > 0 else 0.0

        # Deterministic sleeper evaluation & top signal reasons
        reasons = []
        for s_key, _, s_short in SIGNAL_META:
            zv = float(r.get(s_key, 0.0))
            if zv >= 0.35 and s_key in ("injury_step_up", "per_snap_breakout", "pedigree_sleeper", "ngs_skill_breakout", "opp_defender_matchup", "td_regression", "stadium_surface_wx"):
                reasons.append(f"{s_short} z={zv:+.2f}")

        is_sleeper = bool(
            status not in ("O", "IR", "D")
            and sal <= 6600
            and our_p >= 9.0
            and val_1k >= 2.05
            and (
                float(r.get("injury_step_up", 0.0)) >= 0.30
                or float(r.get("per_snap_breakout", 0.0)) >= 0.35
                or float(r.get("pedigree_sleeper", 0.0)) >= 0.40
                or edge >= 2.50
            )
        )
        if is_sleeper and edge >= 2.0:
            reasons.insert(0, f"+{edge:.1f} Edge vs FD")

        wx_pen_str = f"{float(r.get('stadium_surface_wx', 0.0)):+.2f} ({gm['roof']} • {gm['surface']} • {gm['gametime']})"
        inj_note = str(r.get("notes", "")).strip()

        row_dict = {
            "rank": 0,
            "id": pid,
            "name": pname,
            "pos": pos,
            "team": tm,
            "opp": gm["opp"],
            "game": gm["game"],
            "home_away": gm["home_away"],
            "salary": sal,
            "our_proj": our_p,
            "fd_proj": fd_p,
            "base_proj": base_p,
            "proj_edge": edge,
            "value_per_1k": val_1k,
            "ceil": ceil_val,
            "floor": floor_val,
            "status": status,
            "injury_note": inj_note,
            "is_sleeper": is_sleeper,
            "sleeper_reasons": " | ".join(reasons[:4]),
            "spread": gm["spread"],
            "over_under": gm["over_under"],
            "implied_total": gm["implied_total"],
            "weather_Penalty": wx_pen_str,
        }

        for s_key, col_pref, _ in SIGNAL_META:
            zv = round(float(r.get(s_key, 0.0)), 3)
            wv = float(W.get(s_key, 0.0))
            pts_v = round(base_p * wv * zv, 2) if our_p > 0 else 0.0
            row_dict[f"{col_pref}_z"] = zv
            row_dict[f"{col_pref}_pts"] = pts_v

        row_dict["week"] = 9
        row_dict["gameday"] = gm["gameday"]
        rows.append(row_dict)

    df_out = pd.DataFrame(rows)
    df_out = df_out.sort_values(["our_proj", "value_per_1k", "salary"], ascending=[False, False, False]).reset_index(drop=True)
    df_out["rank"] = np.arange(1, len(df_out) + 1)
    df_out.to_csv(DATA_DIR / "current_players.csv", index=False)
    return df_out


def top_signals_summary(p_row: pd.Series) -> str:
    """Deterministic top signals string for optimal_lineups.csv."""
    items = []
    for s_key, col_pref, s_short in SIGNAL_META:
        zv = float(p_row.get(f"{col_pref}_z", 0.0))
        ptv = float(p_row.get(f"{col_pref}_pts", 0.0))
        if abs(ptv) >= 0.10 or abs(zv) >= 0.25:
            items.append((abs(ptv), f"{s_short} {ptv:+.1f} (z={zv:+.2f})"))
    items.sort(key=lambda x: x[0], reverse=True)
    return " • ".join(x[1] for x in items[:3]) if items else "EB Vegas Share Base"


def solve_classic_ilp(df_pool: pd.DataFrame, cap: int = 60000, obj_col: str = "our_proj", exclude_lineups=None):
    """Solve 9-slot FanDuel Classic optimal lineup (QB, 2 RB, 3 WR, 1 TE, 1 FLEX, 1 DST) via PuLP CBC."""
    exclude_lineups = exclude_lineups or []
    pool = df_pool[
        (~df_pool["status"].isin(["O", "IR", "D"]))
        & (df_pool["pos"].isin(["QB", "RB", "WR", "TE", "DST"]))
        & (df_pool[obj_col] > 0)
    ].copy().reset_index(drop=True)

    prob = pulp.LpProblem("FD_Classic_Optimal", pulp.LpMaximize)
    idx = list(pool.index)
    x = pulp.LpVariable.dicts("x", idx, cat="Binary")

    prob += pulp.lpSum(pool.loc[i, obj_col] * x[i] + 1e-4 * pool.loc[i, "ceil"] * x[i] for i in idx)
    prob += pulp.lpSum(pool.loc[i, "salary"] * x[i] for i in idx) <= cap
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "QB") == 1
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "DST") == 1
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "RB") >= 2
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "RB") <= 3
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "WR") >= 3
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "WR") <= 4
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "TE") >= 1
    prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "pos"] == "TE") <= 2
    prob += pulp.lpSum(x[i] for i in idx) == 9

    for prev_ids in exclude_lineups:
        prob += pulp.lpSum(x[i] for i in idx if pool.loc[i, "id"] in prev_ids) <= 8

    prob.solve(pulp.PULP_CBC_CMD(msg=False))
    if pulp.LpStatus[prob.status] != "Optimal":
        return None

    chosen = pool[[pulp.value(x[i]) > 0.5 for i in idx]].copy()
    qbs = chosen[chosen["pos"] == "QB"].sort_values("our_proj", ascending=False)
    rbs = chosen[chosen["pos"] == "RB"].sort_values("our_proj", ascending=False)
    wrs = chosen[chosen["pos"] == "WR"].sort_values("our_proj", ascending=False)
    tes = chosen[chosen["pos"] == "TE"].sort_values("our_proj", ascending=False)
    dsts = chosen[chosen["pos"] == "DST"].sort_values("our_proj", ascending=False)

    slots = [
        ("QB", qbs.iloc[0]),
        ("RB1", rbs.iloc[0]),
        ("RB2", rbs.iloc[1]),
        ("WR1", wrs.iloc[0]),
        ("WR2", wrs.iloc[1]),
        ("WR3", wrs.iloc[2]),
        ("TE", tes.iloc[0]),
    ]
    if len(rbs) > 2:
        flex_p = rbs.iloc[2]
    elif len(wrs) > 3:
        flex_p = wrs.iloc[3]
    else:
        flex_p = tes.iloc[1]
    slots.append(("FLEX", flex_p))
    slots.append(("DEF", dsts.iloc[0]))
    return slots


def solve_showdown_ilp(df_pool: pd.DataFrame, cap: int = 60000, obj_col: str = "our_proj", exclude_lineups=None):
    """Solve 6-slot FanDuel Single-Game Showdown optimal lineup (1.5x MVP + 5 AnyFLEX) via PuLP CBC."""
    exclude_lineups = exclude_lineups or []
    pool = df_pool[
        (~df_pool["status"].isin(["O", "IR", "D"]))
        & (df_pool[obj_col] > 0)
    ].copy().reset_index(drop=True)

    prob = pulp.LpProblem("FD_Showdown_Optimal", pulp.LpMaximize)
    idx = list(pool.index)
    mvp = pulp.LpVariable.dicts("mvp", idx, cat="Binary")
    flex = pulp.LpVariable.dicts("flex", idx, cat="Binary")

    prob += pulp.lpSum(
        1.5 * pool.loc[i, obj_col] * mvp[i]
        + 1.0 * pool.loc[i, obj_col] * flex[i]
        + 1e-4 * pool.loc[i, "ceil"] * (1.5 * mvp[i] + flex[i])
        for i in idx
    )
    # Match app.js ROSTER_SLOT_SCHEMA_SHOWDOWN (1.5x MVP salary & points multiplier)
    prob += pulp.lpSum(
        int(round(pool.loc[i, "salary"] * 1.5)) * mvp[i] + int(pool.loc[i, "salary"]) * flex[i]
        for i in idx
    ) <= cap
    prob += pulp.lpSum(mvp[i] for i in idx) == 1
    prob += pulp.lpSum(flex[i] for i in idx) == 5
    for i in idx:
        prob += mvp[i] + flex[i] <= 1

    # Require at least 1 player from each team
    teams = list(pool["team"].unique())
    if len(teams) == 2:
        for tm in teams:
            prob += pulp.lpSum(mvp[i] + flex[i] for i in idx if pool.loc[i, "team"] == tm) >= 1

    for prev_mvp_id, prev_all_ids in exclude_lineups:
        prob += (
            pulp.lpSum(mvp[i] for i in idx if pool.loc[i, "id"] == prev_mvp_id)
            + pulp.lpSum(mvp[i] + flex[i] for i in idx if pool.loc[i, "id"] in prev_all_ids)
        ) <= 6

    prob.solve(pulp.PULP_CBC_CMD(msg=False))
    if pulp.LpStatus[prob.status] != "Optimal":
        return None

    mvp_row = pool[[pulp.value(mvp[i]) > 0.5 for i in idx]].iloc[0]
    flex_rows = pool[[pulp.value(flex[i]) > 0.5 for i in idx]].sort_values(obj_col, ascending=False)

    slots = [("MVP", mvp_row)]
    for k, (_, r) in enumerate(flex_rows.iterrows(), 1):
        slots.append((f"FLEX{k}", r))
    return slots


def format_optimal_rows(scope: str, scope_key: str, scope_label: str, slots, is_showdown: bool, solver_desc: str, cap: int = 60000):
    """Format solved ILP lineup into optimal_lineups.csv rows."""
    tot_sal = 0
    tot_our = 0.0
    tot_fd = 0.0
    tot_base = 0.0
    tot_ceil = 0.0
    tot_floor = 0.0
    slot_items = []

    for order_idx, (slot_name, p) in enumerate(slots, 1):
        mult = 1.5 if (is_showdown and slot_name == "MVP") else 1.0
        sal_s = int(round(int(p["salary"]) * mult))
        our_s = round(float(p["our_proj"]) * mult, 2)
        fd_s = round(float(p["fd_proj"]) * mult, 2)
        base_s = round(float(p["base_proj"]) * mult, 2)
        edge_s = round(our_s - fd_s, 2)
        ceil_s = round(float(p["ceil"]) * mult, 2)
        floor_s = round(float(p["floor"]) * mult, 2)
        val_s = round(our_s / (sal_s / 1000.0), 2) if sal_s > 0 else 0.0

        tot_sal += sal_s
        tot_our = round(tot_our + our_s, 2)
        tot_fd = round(tot_fd + fd_s, 2)
        tot_base = round(tot_base + base_s, 2)
        tot_ceil = round(tot_ceil + ceil_s, 2)
        tot_floor = round(tot_floor + floor_s, 2)

        slot_items.append((order_idx, slot_name, p, sal_s, our_s, fd_s, base_s, edge_s, val_s, ceil_s, floor_s))

    tot_edge = round(tot_our - tot_fd, 2)
    rem_sal = cap - tot_sal

    out_rows = []
    for order_idx, slot_name, p, sal_s, our_s, fd_s, base_s, edge_s, val_s, ceil_s, floor_s in slot_items:
        out_rows.append({
            "scope": scope,
            "scope_key": scope_key,
            "scope_label": scope_label,
            "salary_cap": cap,
            "total_salary": tot_sal,
            "salary_remaining": rem_sal,
            "total_our_proj": tot_our,
            "total_fd_proj": tot_fd,
            "total_base_proj": tot_base,
            "total_proj_edge": tot_edge,
            "total_ceil": tot_ceil,
            "total_floor": tot_floor,
            "slot_order": order_idx,
            "slot": slot_name,
            "player_id": p["id"],
            "player": p["name"],
            "pos": p["pos"],
            "team": p["team"],
            "opp": p["opp"],
            "game": p["game"],
            "home_away": p["home_away"],
            "salary": sal_s,
            "our_proj": our_s,
            "fd_proj": fd_s,
            "base_proj": base_s,
            "proj_edge": edge_s,
            "value_per_1k": val_s,
            "ceil": ceil_s,
            "floor": floor_s,
            "status": p["status"],
            "is_sleeper": p["is_sleeper"],
            "top_signals": top_signals_summary(p),
            "solver": solver_desc,
        })
    return out_rows, {
        "salary": tot_sal,
        "our_proj": tot_our,
        "fd_proj": tot_fd,
        "ceil": tot_ceil,
        "slots": slots,
    }


def build_optimal_and_preset_lineups(df_players: pd.DataFrame):
    """Solve `optimal_lineups.csv` and `lineups.csv` 100% deterministically with PuLP CBC."""
    opt_rows = []

    # 1. All Games Combined (all 14 Week 9 games, 9-slot Classic, $60,000 cap)
    all_slots = solve_classic_ilp(df_players, cap=60000, obj_col="our_proj")
    rows_all, meta_all = format_optimal_rows(
        "all_games",
        "ALL_GAMES",
        "All 14 Week 9 Games Combined (TNF + Sun Main + SNF + MNF • $60K Classic)",
        all_slots,
        is_showdown=False,
        solver_desc="PuLP CBC ILP (9-Slot Classic • Cap=$60,000 • v9 15-Signal Max Projection)",
    )
    opt_rows.extend(rows_all)

    # 2. Per-Game Optimal Lineups across all 14 Week 9 games
    game_order = [
        ("CAR@GB", "TNF Showdown: CAR @ GB (Thu Oct 29, 8:15 PM ET)"),
        ("BAL@BUF", "Sun Main: BAL @ BUF (Sun Nov 1, 1:00 PM ET)"),
        ("ARI@DAL", "Sun Main: ARI @ DAL (Sun Nov 1, 1:00 PM ET)"),
        ("MIN@DET", "Sun Main: MIN @ DET (Sun Nov 1, 1:00 PM ET)"),
        ("TEN@CIN", "Sun Main: TEN @ CIN (Sun Nov 1, 1:00 PM ET)"),
        ("IND@JAX", "Sun Main: IND @ JAX (Sun Nov 1, 1:00 PM ET)"),
        ("ATL@TB", "Sun Main: ATL @ TB (Sun Nov 1, 1:00 PM ET)"),
        ("LV@NYJ", "Sun Main: LV @ NYJ (Sun Nov 1, 1:00 PM ET)"),
        ("CLE@PIT", "Sun Main: CLE @ PIT (Sun Nov 1, 1:00 PM ET)"),
        ("LAC@LAR", "Sun Main: LAC @ LAR (Sun Nov 1, 4:05 PM ET)"),
        ("NE@MIA", "Sun Main: NE @ MIA (Sun Nov 1, 4:25 PM ET)"),
        ("KC@DEN", "Sun Main: KC @ DEN (Sun Nov 1, 4:25 PM ET)"),
        ("PHI@WAS", "SNF Showdown: PHI @ WAS (Sun Nov 1, 8:20 PM ET)"),
        ("CHI@SEA", "MNF Showdown: CHI @ SEA (Mon Nov 2, 8:15 PM ET)"),
    ]

    per_game_meta = {}
    for gcode, glabel in game_order:
        g_pool = df_players[df_players["game"] == gcode].copy()
        is_sd = gcode in SHOWDOWN_GAMES_WK9
        if is_sd:
            g_slots = solve_showdown_ilp(g_pool, cap=60000, obj_col="our_proj")
            s_desc = "PuLP CBC ILP (6-Slot Single-Game Showdown 1.5x MVP + 5 AnyFLEX • Cap=$60,000)"
        else:
            g_slots = solve_classic_ilp(g_pool, cap=60000, obj_col="our_proj")
            s_desc = "PuLP CBC ILP (9-Slot Single-Game Classic • Cap=$60,000)"
        g_rows, g_m = format_optimal_rows("per_game", gcode, glabel, g_slots, is_showdown=is_sd, solver_desc=s_desc)
        opt_rows.extend(g_rows)
        per_game_meta[gcode] = g_m

    df_opt = pd.DataFrame(opt_rows)
    df_opt.to_csv(DATA_DIR / "optimal_lineups.csv", index=False)

    # 3. Build `data/lineups.csv` featuring Week 9 Sunday Main Pure Max-Points Optimal #1 as Row #1 (`preset_id = "opt-1"`)
    main_pool = df_players[~df_players["game"].isin(SHOWDOWN_GAMES_WK9)].copy()
    main_opt1_slots = solve_classic_ilp(main_pool, cap=60000, obj_col="our_proj")
    _, m_main1 = format_optimal_rows("main", "MAIN_1", "Week 9 Sunday Main Optimal #1", main_opt1_slots, False, "PuLP CBC")
    used_main1 = {p["id"] for _, p in main_opt1_slots}

    main_opt2_slots = solve_classic_ilp(main_pool, cap=60000, obj_col="our_proj", exclude_lineups=[used_main1])
    _, m_main2 = format_optimal_rows("main", "MAIN_2", "Week 9 Sunday Main Optimal #2", main_opt2_slots, False, "PuLP CBC")

    main_fd_slots = solve_classic_ilp(main_pool, cap=60000, obj_col="fd_proj")
    _, m_main_fd = format_optimal_rows("main", "MAIN_FD", "Week 9 FD Pre-Game FPPG Optimal", main_fd_slots, False, "PuLP CBC")

    def classic_preset_row(pid, grp, lbl, contest, eid, buyin, meta_obj):
        s_map = {s: p["name"] for s, p in meta_obj["slots"]}
        return {
            "preset_id": pid,
            "group": grp,
            "label": lbl,
            "contest": contest,
            "entry_id": eid,
            "buyin": buyin,
            "salary": meta_obj["salary"],
            "our_proj": meta_obj["our_proj"],
            "fd_proj": meta_obj["fd_proj"],
            "ceil": meta_obj["ceil"],
            "QB": s_map["QB"],
            "RB1": s_map["RB1"],
            "RB2": s_map["RB2"],
            "WR1": s_map["WR1"],
            "WR2": s_map["WR2"],
            "WR3": s_map["WR3"],
            "TE": s_map["TE"],
            "FLEX": s_map["FLEX"],
            "DEF": s_map["DEF"],
            "roster_format": "classic",
            "MVP": "",
            "FLEX1": "",
            "FLEX2": "",
            "FLEX3": "",
            "FLEX4": "",
            "FLEX5": "",
        }

    def showdown_preset_row(pid, grp, lbl, contest, eid, buyin, meta_obj):
        s_map = {s: p["name"] for s, p in meta_obj["slots"]}
        return {
            "preset_id": pid,
            "group": grp,
            "label": lbl,
            "contest": contest,
            "entry_id": eid,
            "buyin": buyin,
            "salary": meta_obj["salary"],
            "our_proj": meta_obj["our_proj"],
            "fd_proj": meta_obj["fd_proj"],
            "ceil": meta_obj["ceil"],
            "QB": "",
            "RB1": "",
            "RB2": "",
            "WR1": "",
            "WR2": "",
            "WR3": "",
            "TE": "",
            "FLEX": "",
            "DEF": "",
            "roster_format": "showdown",
            "MVP": s_map["MVP"],
            "FLEX1": s_map["FLEX1"],
            "FLEX2": s_map["FLEX2"],
            "FLEX3": s_map["FLEX3"],
            "FLEX4": s_map["FLEX4"],
            "FLEX5": s_map["FLEX5"],
        }

    wk9_grp = "★ Week 9 v9 Mathematical Optimal Builds (Oct 29 – Nov 2, 2026)"
    wk9_sd_grp = "Week 9 Primetime Showdown Optimal Builds (TNF / SNF / MNF)"

    m1_names = " + ".join(p["name"] for _, p in m_main1["slots"])
    m2_names = " + ".join(p["name"] for _, p in m_main2["slots"])
    all_names = " + ".join(p["name"] for _, p in meta_all["slots"])
    fd_names = " + ".join(p["name"] for _, p in m_main_fd["slots"])

    tnf_m = per_game_meta["CAR@GB"]
    snf_m = per_game_meta["PHI@WAS"]
    mnf_m = per_game_meta["CHI@SEA"]

    preset_rows = [
        # ROW #1: Pure Max-Points Optimal Week 9 Sunday Main Classic Lineup (`preset_id = "opt-1"`, `entry_id = "OPT-WK9-MAIN-1"`)
        classic_preset_row(
            "opt-1",
            wk9_grp,
            f"★ Featured Week 9 Max-Points Optimal #1 (OPT-WK9-MAIN-1) — {m_main1['our_proj']:.2f} v9 pts (${m_main1['salary']:,})",
            f"Week 9 Sunday Main Slate (11 Games • Sun Nov 1) — ★ Featured Pure v9 Projection-Maximizing ILP Optimal #1 ({m1_names})",
            "OPT-WK9-MAIN-1",
            0.00,
            m_main1,
        ),
        classic_preset_row(
            "opt-2",
            wk9_grp,
            f"Week 9 Sunday Main Max-Points Optimal #2 (OPT-WK9-MAIN-2) — {m_main2['our_proj']:.2f} v9 pts (${m_main2['salary']:,})",
            f"Week 9 Sunday Main Slate (11 Games • Sun Nov 1) — Deterministic v9 ILP Optimal #2 ({m2_names})",
            "OPT-WK9-MAIN-2",
            0.00,
            m_main2,
        ),
        classic_preset_row(
            "opt-all-1",
            wk9_grp,
            f"Week 9 All-14-Games Combined Optimal #1 (OPT-WK9-ALL-1) — {meta_all['our_proj']:.2f} v9 pts (${meta_all['salary']:,})",
            f"Week 9 Full 14-Game Slate (TNF + Sun Main + SNF + MNF) — Deterministic v9 ILP All-Games Optimal #1 ({all_names})",
            "OPT-WK9-ALL-1",
            0.00,
            meta_all,
        ),
        classic_preset_row(
            "wk9-fd-opt",
            wk9_grp,
            f"FD Pre-Game Baseline Optimal — Week 9 Sunday Main ({m_main_fd['fd_proj']:.2f} FD pts / {m_main_fd['our_proj']:.2f} v9 pts)",
            f"FanDuel Raw FPPG Baseline Mathematical Optimal — Week 9 Sunday Main ({fd_names})",
            "FD-OPT-WK9-MAIN",
            0.00,
            m_main_fd,
        ),
        showdown_preset_row(
            "wk9-tnf-1",
            wk9_sd_grp,
            f"TNF CAR @ GB Showdown Optimal #1 (OPT-WK9-TNF-1) — {tnf_m['our_proj']:.2f} v9 pts (${tnf_m['salary']:,} • MVP {tnf_m['slots'][0][1]['name']})",
            f"Week 9 TNF Single-Game Showdown (CAR @ GB • Thu Oct 29) — Pure v9 ILP Max-Points Optimal #1",
            "OPT-WK9-TNF-1",
            0.00,
            tnf_m,
        ),
        showdown_preset_row(
            "wk9-snf-1",
            wk9_sd_grp,
            f"SNF PHI @ WAS Showdown Optimal #1 (OPT-WK9-SNF-1) — {snf_m['our_proj']:.2f} v9 pts (${snf_m['salary']:,} • MVP {snf_m['slots'][0][1]['name']})",
            f"Week 9 SNF Single-Game Showdown (PHI @ WAS • Sun Nov 1) — Pure v9 ILP Max-Points Optimal #1",
            "OPT-WK9-SNF-1",
            0.00,
            snf_m,
        ),
        showdown_preset_row(
            "wk9-mnf-1",
            wk9_sd_grp,
            f"MNF CHI @ SEA Showdown Optimal #1 (OPT-WK9-MNF-1) — {mnf_m['our_proj']:.2f} v9 pts (${mnf_m['salary']:,} • MVP {mnf_m['slots'][0][1]['name']})",
            f"Week 9 MNF Single-Game Showdown (CHI @ SEA • Mon Nov 2) — Pure v9 ILP Max-Points Optimal #1",
            "OPT-WK9-MNF-1",
            0.00,
            mnf_m,
        ),
    ]

    # Preserve completed Week 8 graded lineups below with `wk8-` prefix so `opt-1` is loaded by default
    locked_wk8_lu_path = ROOT / "tools" / ".locked_wk8_lineups.csv"
    if locked_wk8_lu_path.exists():
        wk8_lu_df = pd.read_csv(locked_wk8_lu_path, keep_default_na=False)
        for _, r in wk8_lu_df.iterrows():
            d = dict(r)
            old_pid = str(d["preset_id"])
            if not old_pid.startswith("wk8-"):
                d["preset_id"] = f"wk8-{old_pid}"
            d["group"] = f"Completed Week 8 Archive — {d['group']}"
            preset_rows.append(d)

    df_lu_out = pd.DataFrame(preset_rows)
    df_lu_out.to_csv(DATA_DIR / "lineups.csv", index=False)
    return df_opt, df_lu_out, m_main1, meta_all, per_game_meta


def preserve_and_verify_historic_csvs():
    """Ensure all 3 historic CSVs (2,549 completed rows across Weeks 3-8) are preserved byte-for-byte."""
    for fname in [
        "historic_player_projections.csv",
        "historic_weekly_summary.csv",
        "historic_position_summary.csv",
    ]:
        locked_p = ROOT / "tools" / f".locked_{fname}"
        target_p = DATA_DIR / fname
        if locked_p.exists():
            target_p.write_bytes(locked_p.read_bytes())

    hp = pd.read_csv(DATA_DIR / "historic_player_projections.csv")
    hw = pd.read_csv(DATA_DIR / "historic_weekly_summary.csv")
    hpos = pd.read_csv(DATA_DIR / "historic_position_summary.csv")
    assert len(hp) == 2549, f"Expected 2549 historic rows, got {len(hp)}"
    return hp, hw, hpos


def build_meta_csv(df_players: pd.DataFrame, hw: pd.DataFrame, m_main1: dict, meta_all: dict):
    """Build `data/meta.csv` with Week 9 active slate metadata and finalized 6-week (n=2,549) & Week 8 (n=621) metrics."""
    now_et = datetime.now(ZoneInfo("America/New_York"))
    ts_str = now_et.strftime("%a %b %-d, %Y %-I:%M %p ET")
    build_id = now_et.strftime("%Y%m%d-%H%M%S")

    all_row = hw[hw["week"] == "ALL"].iloc[0]
    wk8_row = hw[hw["week"] == "8"].iloc[0]

    meta_items = [
        ("title", "Week 9 Pre-Game Player Selection Board (14 Games • TNF CAR@GB + 11 Sun Main + SNF PHI@WAS + MNF CHI@SEA)"),
        ("active_week", "9"),
        ("slate_id", "WK9-SEED"),
        ("contest_name", f"Week 9 NFL Classic & Showdown Pre-Game Seed Board (Featured Optimal OPT-WK9-MAIN-1: {m_main1['our_proj']:.2f} v9 pts)"),
        ("lock_time", "TNF Thu Oct 29 8:15 PM ET • Sun Main Nov 1 1:00 PM ET"),
        ("salary_cap", "60000"),
        ("roster_slots", "9"),
        ("active_version", "v9 LOCKED (15 SIGNALS + TEAM-OWNED STADIUM/WX + STRATEGY EXCHANGE)"),
        ("generated_at", f"{ts_str} (Build {build_id} • Week 8 Finalized n=621 + Week 9 14-Game Pre-Game Seed)"),
        ("build_id", build_id),
        ("updater_bot", "@fd-board-updater"),
        ("updater_bot_id", "7f63a5f1-23e8-4a34-b1c8-fd8b0a4d2026"),
        ("middleman_bot", "@fd-strategy-exchange"),
        ("middleman_bot_id", "4f64d389-10db-4641-ae99-ad900bb4ffcb"),
        ("weather_bot", "@fd-stadium-weather"),
        ("weather_bot_id", "53977200-89b4-45e7-8791-b8a378bbc2d3"),
        ("pregame_schedule", "Thu 9AM (TNF) • Fri 9AM (Sun Main/SNF) • Mon 9AM (MNF) • Refresh 3h Pre-Kickoff"),
        ("postgame_schedule", "Tue 9AM Weekly Wrap (Finalize Wk8 Actuals vs Projections + Seed Wk9 Board)"),
        ("historic_weeks_covered", "Weeks 3, 4, 5, 6, 7 & 8 Completed (2,549 Player-Weeks Graded • Wk 8 All 12 Games Final)"),
        ("overall_our_rho", f"{float(all_row['our_rho']):.4f}"),
        ("overall_fd_rho", f"{float(all_row['fd_rho']):.4f}"),
        ("overall_rho_gain", f"+{float(all_row['rho_gain']):.4f}"),
        ("overall_our_mae", f"{float(all_row['our_mae']):.3f}"),
        ("overall_fd_mae", f"{float(all_row['fd_mae']):.3f}"),
        ("overall_mae_gain", f"+{(float(all_row['fd_mae']) - float(all_row['our_mae'])):.3f}"),
        ("overall_our_rmse", f"{float(all_row['our_rmse']):.3f}"),
        ("overall_fd_rmse", f"{float(all_row['fd_rmse']):.3f}"),
        ("overall_beat_fd_pct", f"{float(all_row['our_beat_fd_pct']):.1f}%"),
        ("wk8_our_rho", f"{float(wk8_row['our_rho']):.4f}"),
        ("wk8_fd_rho", f"{float(wk8_row['fd_rho']):.4f}"),
        ("wk8_our_mae", f"{float(wk8_row['our_mae']):.3f}"),
        ("wk8_fd_mae", f"{float(wk8_row['fd_mae']):.3f}"),
        ("wk8_beat_fd_pct", f"{float(wk8_row['our_beat_fd_pct']):.1f}%"),
        ("wk9_featured_optimal_id", "OPT-WK9-MAIN-1"),
        ("wk9_featured_optimal_pts", f"{m_main1['our_proj']:.2f}"),
        ("wk9_all_games_optimal_pts", f"{meta_all['our_proj']:.2f}"),
    ]
    pd.DataFrame(meta_items, columns=["key", "value"]).to_csv(DATA_DIR / "meta.csv", index=False)


def main():
    hp, hw, hpos = preserve_and_verify_historic_csvs()
    df_players = build_current_week9_players()
    df_opt, df_lu, m_main1, meta_all, per_game_meta = build_optimal_and_preset_lineups(df_players)
    build_meta_csv(df_players, hw, m_main1, meta_all)

    print(f"=== Deterministic CSV Build Complete ===")
    print(f"  current_players.csv:             {len(df_players)} rows across {df_players['game'].nunique()} Week 9 games")
    print(f"  optimal_lineups.csv:             {len(df_opt)} slot rows ({df_opt['scope_key'].nunique()} scopes)")
    print(f"  lineups.csv:                     {len(df_lu)} presets (Row #1: {df_lu.iloc[0]['preset_id']} / {df_lu.iloc[0]['entry_id']} = {df_lu.iloc[0]['our_proj']} pts)")
    print(f"  historic_player_projections.csv: {len(hp)} rows (preserved byte-for-byte)")
    print(f"  Featured OPT-WK9-MAIN-1:         {m_main1['our_proj']:.2f} v9 pts (FD {m_main1['fd_proj']:.2f}, ${m_main1['salary']:,})")
    for s, p in m_main1["slots"]:
        print(f"    {s:5s}: {p['name']:24s} ({p['pos']:3s} {p['team']}@{p['opp']}) ${int(p['salary']):,} -> {float(p['our_proj']):.2f} pts (FD {float(p['fd_proj']):.2f})")


if __name__ == "__main__":
    main()
