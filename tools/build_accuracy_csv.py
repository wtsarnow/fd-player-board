#!/usr/bin/env python3
"""Copy/derive the 'Accuracy: FanDuel vs My Model' CSVs for the board (deterministic, no hardcoded numbers).

Source of truth (built by /workspace/fd-system/tools/build_accuracy.py):
  <src>/fd_vs_model_weekly.csv   -> data/accuracy_weekly.csv   (byte-for-byte copy)
  <src>/fd_vs_model_players.csv  -> data/accuracy_players.csv  (byte-for-byte copy)
  <src>/fd_vs_model_weekly.json  -> data/accuracy_meta.csv     (labels, filter, slates, derived caveat)

Before writing anything it checks that the weekly CSV matches the JSON rows and that every ALL-position
week / season_to_date / season row can be reproduced from the player-level file (n, MAE, win rate).

Usage:  python3 tools/build_accuracy_csv.py [--src /workspace/fd-system/data/accuracy]
"""
import argparse, csv, hashlib, importlib.util, json, os, shutil, sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True  # do not leave __pycache__ in fd-system/tools when importing build_accuracy.py

BOARD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = '/workspace/fd-system/data/accuracy'


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def check(src):
    W = list(csv.DictReader(open(os.path.join(src, 'fd_vs_model_weekly.csv'))))
    J = json.load(open(os.path.join(src, 'fd_vs_model_weekly.json')))
    assert len(J['rows']) == len(W), 'weekly CSV and JSON row counts differ'
    for a, b in zip(W, J['rows']):
        for k in ('level', 'position', 'n_head_to_head'):
            assert str(a[k]) == str(b[k]), f'CSV/JSON mismatch on {k}'
        for k in ('model_mae', 'fd_mae', 'model_win_rate'):
            x, y = fnum(a[k]), fnum(b[k])
            assert (x is None and y is None) or abs(x - y) < 1e-3, f'CSV/JSON mismatch on {k}'
    P = [r for r in csv.DictReader(open(os.path.join(src, 'fd_vs_model_players.csv')))
         if r['in_eval'] == 'True' and (fnum(r['fd_fppg']) or 0) > 0]

    def agg(rows):
        n = len(rows)
        me = sum(abs(float(r['model_proj']) - float(r['actual'])) for r in rows) / n
        fe = sum(abs(float(r['fd_fppg']) - float(r['actual'])) for r in rows) / n
        wr = sum((float(r['model_closer']) + 1) / 2 for r in rows) / n
        return n, me, fe, wr

    report = []
    for r in W:
        if r['level'] not in ('week', 'season_to_date', 'season'):
            continue
        rows = [p for p in P if r['position'] in ('ALL', p['pos'])]
        if r['level'] == 'week':
            rows = [p for p in rows if p['nfl_week'] == r['nfl_week']]
        elif r['level'] == 'season_to_date':
            rows = [p for p in rows if int(p['nfl_week']) <= int(r['nfl_week'])]
        n, me, fe, wr = agg(rows)
        assert n == int(r['n_head_to_head']), f"n mismatch {r['level']} {r['nfl_week']} {r['position']}"
        # player file is rounded to 2 dp, so allow small rounding drift
        assert abs(me - float(r['model_mae'])) < 0.01 and abs(fe - float(r['fd_mae'])) < 0.01, 'MAE mismatch'
        assert abs(wr - float(r['model_win_rate'])) < 0.002, 'win-rate mismatch'
        report.append((r['level'], r['nfl_week'], r['position'], n))
    return W, J, report


def caveat(W, J, src):
    weeks = sorted({int(r['nfl_week']) for r in W if r['level'] == 'week' and r['position'] == 'ALL'
                    and int(r['n_head_to_head'] or 0) > 0})
    n_words = {1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five'}
    past_versions = sorted({s.get('model_version') or 'unknown' for s in J['meta']['slates_included']})
    # current model version + QB starter-check fix date come from the accuracy builder itself
    current, fix_date = '', ''
    spec = importlib.util.spec_from_file_location('ba', os.path.join(os.path.dirname(os.path.dirname(src)), 'tools', 'build_accuracy.py'))
    try:
        ba = importlib.util.module_from_spec(spec); spec.loader.exec_module(ba)
        current = ba.MODEL_VERSION_BY_DATE[-1][1]
        fix_date = next((d for d, lab in ba.MODEL_VERSION_BY_DATE if 'QB' in lab), '')
    except Exception as e:  # keep building, just with less detail
        print('warn: could not read MODEL_VERSION_BY_DATE:', e, file=sys.stderr)
    last_gameday = max(s['gameday'] for s in J['meta']['slates_included'])
    parts = [f"{n_words.get(len(weeks), str(len(weeks)))} head-to-head week{'s' if len(weeks) != 1 else ''} so far "
             f"(Board Weeks {', '.join(str(w + 1) for w in weeks)})"]
    parts.append(f"past slates were projected with older model versions ({', '.join(past_versions)})"
                 + (f"; current model is {current}" if current else ''))
    if fix_date and last_gameday < fix_date:
        parts.append(f"QB numbers predate the {fix_date} QB starter-check fix")
    return '. '.join(p[0].upper() + p[1:] for p in parts) + '.'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC)
    src = ap.parse_args().src
    W, J, report = check(src)
    out = os.path.join(BOARD, 'data')
    shutil.copyfile(os.path.join(src, 'fd_vs_model_weekly.csv'), os.path.join(out, 'accuracy_weekly.csv'))
    shutil.copyfile(os.path.join(src, 'fd_vs_model_players.csv'), os.path.join(out, 'accuracy_players.csv'))
    m = J['meta']
    src_csv = os.path.join(src, 'fd_vs_model_weekly.csv')
    built = datetime.fromtimestamp(os.path.getmtime(src_csv), timezone.utc).astimezone()
    inc = m['slates_included']
    rows = [
        ('benchmark_label', m['benchmark_label']),
        ('fdr_label', m['fdr_label']),
        ('model_label', 'My model (pre-slate projection, exactly as saved)'),
        ('filter', m['filter']),
        ('week_note', m['week_note']),
        ('win_rate_note', m['win_rate_note']),
        ('caveat', caveat(W, J, src)),
        ('season', m['season']),
        ('source_generated_by', m['generated_by']),
        ('source_built_at', built.strftime('%Y-%m-%d %I:%M %p ET')),
        ('source_weekly_sha256', sha(src_csv)),
        ('source_players_sha256', sha(os.path.join(src, 'fd_vs_model_players.csv'))),
        ('slates_included_count', len(inc)),
        ('slates_included', '; '.join(f"{s['slate']} {s['slate_type']} {s['gameday']} {s['games']} (Board Wk {s['board_week']}, {s['model_version']}{'' if s.get('has_fppg') else ', no FPPG in export'})" for s in inc)),
        ('slates_skipped', '; '.join(f"{s['slate']}: {s['reason']}" for s in m['slates_skipped'])),
    ]
    with open(os.path.join(out, 'accuracy_meta.csv'), 'w', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(['key', 'value'])
        w.writerows(rows)
    print(f'ok: {len(W)} weekly rows, verified {len(report)} aggregate rows vs player file')
    for k, v in rows:
        if k in ('caveat', 'source_built_at', 'slates_included_count'):
            print(f'  {k}: {v}')


if __name__ == '__main__':
    main()
