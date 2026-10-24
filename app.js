(function () {
  const DATA = window.FD_BOARD_DATA;
  if (!DATA) return;

  const SIGNAL_DEFINITIONS = [
    {
      key: 'first_downs_rate',
      label: 'First Downs Rate',
      short: '1stDn',
      weight: 0.21,
      tier: 'Core Usage & Chains',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_col( sum(rushing_1st_downs + receiving_1st_downs + passing_1st_downs) / (n_2026 + 2.0) )',
      desc: 'Pre-game chain-moving first downs per game shrunk with a 2.0-game prior. Captures sustainable drive-extending usage that coaches keep feeding regardless of single-week touchdown variance.'
    },
    {
      key: 'td_regression',
      label: 'TD & xFP Positive Regression',
      short: 'TDReg',
      weight: 0.21,
      tier: 'Core Usage & Regression',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_col( - (sum(FD_actual) - sum(xFD)) / (n_2026 + 3.0) )',
      desc: 'Expected FanDuel points (from pass attempts, targets, air yards, carries, and first downs) minus actual FanDuel points scored. Identifies high-volume players due for positive touchdown and scoring regression.'
    },
    {
      key: 'opportunity_share',
      label: 'Team Opportunity Share',
      short: 'OppSh',
      weight: 0.18,
      tier: 'Core Volume',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_col( target_share_EB + 0.65 * carry_share_EB )',
      desc: 'Empirical-Bayes blend of 2026 pre-game target share and weighted carry share (shrunk toward 2025 role-adjusted share). Measures a player’s command of team offensive touches.'
    },
    {
      key: 'injury_step_up',
      label: 'Starter Injury Step-Up',
      short: 'InjStep',
      weight: 0.15,
      tier: 'Sleeper / Role Expansion',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_2step( (vacated_same_pos_share * pos_mult + 0.55 * vacated_pass_target_share) * rank_wt, p_mult=1.0 )',
      desc: 'Vacated team share from Out/IR/Doubtful starters at the same position (weighted 1.50x QB, 1.35x RB, 1.15x TE, 0.90x WR) and pass-catching teammates, scaled by active depth-chart rank and salary headroom (1 / sal_ratio).'
    },
    {
      key: 'per_snap_breakout',
      label: 'Per-Snap Efficiency Breakout',
      short: 'SnapBrk',
      weight: 0.15,
      tier: 'Sleeper / Role Expansion',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_2step( ((targets + carries) / max(snaps, 15)) * (0.5 + snap_pct_L1), p_mult=0.5 )',
      desc: 'Touches per offensive snap multiplied by most recent week snap share and gated by salary headroom (1 / sal_ratio^0.5). Flags hyper-efficient part-time or rotational players whose snap roles are expanding.'
    },
    {
      key: 'opp_defender_matchup',
      label: 'Opposing Defender & Unit Matchup',
      short: 'OppDef',
      weight: 0.09,
      tier: 'Matchup Edge (v5 Winner)',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_2step( (0.55 * z_opp_def_injuries_pos + 0.45 * z_opp_unit_quality_gap) * sqrt(role_mult), p_mult=0.5 )',
      desc: 'Combines specific opposing defensive starter injuries at the directly matched unit (CB/S for WR, LB/S for TE, DL/LB for RB, OL/QB for DST, weighted by NFL Draft pedigree) with Empirical-Bayes shrunk positional share & expected share allowed.'
    },
    {
      key: 'ngs_skill_breakout',
      label: 'NGS Skill OE + FTN Charting Breakout',
      short: 'NGS+FTN',
      weight: 0.08,
      tier: 'Tracking & Charting (v6 Winner)',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_2step( (0.58 * z_ngs_skill_oe + 0.22 * z_ftn_designed + 0.20 * z_ftn_uncatchable) * sqrt(role_mult), p_mult=0.5 )',
      desc: 'New v6 online research winner: 58% Next Gen Stats skill over expected (WR/TE separation + YAC over expected, RB RYOE/att + light-box rate, QB CPOE + air yards to sticks) + 22% FTN charted designed/motion/screen/RPO/PA touches + 20% FTN uncatchable air-target buy-low.'
    },
    {
      key: 'pedigree_sleeper',
      label: 'Draft Pedigree & Youth Sleeper',
      short: 'PedSlp',
      weight: 0.07,
      tier: 'Sleeper / Talent Curve',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_2step( ((100 - min(draft_pick, 100)) / 100) * youth_factor, p_mult=0.5 )',
      desc: 'Interacts early-round NFL Draft capital (picks 1–100) with the year-1/year-2 age breakout curve (age <= 26.5, years_exp <= 2) and salary headroom.'
    },
    {
      key: 'floor_consistency',
      label: '25th-Percentile Floor Consistency',
      short: 'Floor',
      weight: 0.06,
      tier: 'Core Stability',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_col( percentile_25(FD_history) / max(base, 2.0) )',
      desc: '25th-percentile weekly FanDuel output relative to Empirical-Bayes base projection. Rewards high-floor volume earners in cash and single-entry builds.'
    },
    {
      key: 'snap_momentum',
      label: 'Snap Share Momentum',
      short: 'SnapMom',
      weight: 0.06,
      tier: 'Role Trend',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_col( snap_pct_last_week - snap_pct_season_to_date )',
      desc: 'Week-over-week offensive snap percentage surge relative to season-to-date average. Captures depth-chart promotions before FanDuel salaries fully adjust.'
    },
    {
      key: 'social_media_buzz',
      label: 'Pre-Game Search & Media Buzz',
      short: 'Buzz',
      weight: 0.05,
      tier: 'Information Signal',
      owner: '32 Team Bots (fd-<TEAM>)',
      formula: 'norm_col( wiki_z_pregame )',
      desc: 'Strictly pre-game Wikipedia/news attention z-score capturing beat-writer camp/practice hype and emerging role chatter.'
    }
  ];

  const REVERTED_ATTRIBUTES = [
    {
      name: 'rz_i10_share & i10_goal_line',
      version: 'v6 Online Test',
      owner: 'fd-<TEAM>',
      metrics: 'Wk3–7 ρ = 0.6248 (-0.0031), MAE = 4.038 (+0.010), Lineup Avg = 132.44 (-7.65)',
      reason: 'REVERTED TO 0.0: Red-zone (<=20) and goal-line (<=10 / <=5) touch shares over 1–6 weeks add small-sample noise and are already captured with lower variance by first_downs_rate + td_regression (xFD).'
    },
    {
      name: 'high_value_touches (HVT)',
      version: 'v6 Online Test',
      owner: 'fd-<TEAM>',
      metrics: 'Wk3–7 ρ = 0.6294, MAE = 4.067 (+0.039 worse vs 4.028)',
      reason: 'REVERTED TO 0.0: Heavily collinear with opportunity_share; double-counting raw targets + inside-10 carries inflates point-error MAE.'
    },
    {
      name: 'third_down_money',
      version: 'v6 Online Test',
      owner: 'fd-<TEAM>',
      metrics: 'Stagewise w = 0.00 in 5/5 folds; Joint ρ = 0.6264 (-0.0015), MAE = 4.041 (+0.013)',
      reason: 'REVERTED TO 0.0: 3rd-down conversion rate is strictly dominated by all-downs first_downs_rate.'
    },
    {
      name: 'neutral_proe_pace',
      version: 'v6 Online Test',
      owner: 'fd-<TEAM>',
      metrics: 'Stagewise w = 0.00 in 5/5 folds; Joint ρ = 0.6258 (-0.0021), MAE = 4.036 (+0.008)',
      reason: 'REVERTED TO 0.0: Team neutral-script Pass Rate Over Expected (PROE) and no-huddle pace are already priced into Vegas implied_team totals and player opportunity_share.'
    },
    {
      name: 'trench_pressure_diff',
      version: 'v6 Online Test',
      owner: 'fd-<TEAM>',
      metrics: 'Stagewise w = 0.00 in 5/5 folds; Joint w = 0.00 in 5/5 folds',
      reason: 'REVERTED TO 0.0: Offensive vs. defensive sack/QB-hit rate per dropback is already captured inside opp_defender_matchup (DL/OL starter injuries + sack/turnover quality gap).'
    },
    {
      name: 'opp_per_snap_wopr',
      version: 'v6 Online Test',
      owner: 'fd-<TEAM>',
      metrics: 'Wk3–7 MAE = 4.041 (+0.013 worse vs 4.028)',
      reason: 'REVERTED TO 0.0: WOPR per snap is collinear with per_snap_breakout.'
    },
    {
      name: 'ftn_designed_usage & ftn_uncatchable_buylow (standalone)',
      version: 'v6 Online Test',
      owner: 'fd-<TEAM>',
      metrics: 'Standalone MAE = 4.041–4.062',
      reason: 'REVERTED AS STANDALONE: Too noisy as separate standalone weights; only improve both ρ and MAE when shrunk into the 58/22/20 ngs_skill_breakout composite.'
    },
    {
      name: 'stadium_weather_surface (dome_track_boost + grass_rain_wind_penalty)',
      version: 'v5 Test',
      owner: 'fd-stadium-weather (53977200-89b4-45e7-8791-b8a378bbc2d3)',
      metrics: 'Stagewise w = 0.00 in 4/5 folds (ρ = 0.6253); Joint ρ = 0.6240, MAE = 4.044; Combined w/ v5 ρ = 0.6244, Lineup = 126.49',
      reason: 'REVERTED TO 0.0: Vegas implied_team in our EB base already prices dome vs. outdoor grass/rain/wind (48.29 avg total in Domes vs. 44.24 Outdoor Grass and 37.5–41.5 in rain/wind).'
    },
    {
      name: 'rb_next_man_up, youth_breakout, home_role_boost, sleeper_value_gap',
      version: 'v4 Sleeper Screen',
      owner: 'fd-<TEAM>',
      metrics: 'Collinear in LOWO CV vs. injury_step_up, per_snap_breakout, pedigree_sleeper',
      reason: 'REVERTED TO 0.0: Redundant with the 3 surviving headroom-gated sleeper signals.'
    },
    {
      name: 'weather, game_script, opponent_vs_position, injuries, history_vs_opponent, projected_action, wopr, snap_share, explosive_rate, xfp_share_gap, ceiling_upside, epa_efficiency, salary_anchor, team_pace_plays, opp_epa_allowed, vegas_total, rest_advantage, home_field, recent_form_l3',
      version: 'v1 → v3 Screen',
      owner: 'Legacy v1 / Screened Pool',
      metrics: 'v1 Judgment ρ = 0.4149, MAE = 5.115 → v3 EB Base + 6 Survivors ρ = 0.6216, MAE = 4.053',
      reason: 'REVERTED TO 0.0: Either double-counted Vegas lines, overfit small samples (history_vs_opponent, recent_form_l3), or were dominated by Empirical-Bayes shrunk usage/regression signals.'
    }
  ];

  // State
  let state = {
    view: 'board', // 'board' | 'audit'
    pos: 'ALL',    // 'ALL' | 'QB' | 'RB' | 'WR' | 'TE' | 'FLEX' | 'DEF' | 'SLEEPERS'
    game: 'ALL',
    team: 'ALL',
    search: '',
    hideOut: true,
    sortCol: 'adjusted',
    sortDesc: true,
    activePresetId: 'contest-1',
    roster: [
      { slot: 'QB', accept: ['QB'], player: null },
      { slot: 'RB', accept: ['RB'], player: null },
      { slot: 'RB', accept: ['RB'], player: null },
      { slot: 'WR', accept: ['WR'], player: null },
      { slot: 'WR', accept: ['WR'], player: null },
      { slot: 'WR', accept: ['WR'], player: null },
      { slot: 'TE', accept: ['TE'], player: null },
      { slot: 'FLEX', accept: ['RB', 'WR', 'TE'], player: null },
      { slot: 'DEF', accept: ['DST'], player: null }
    ],
    strategyNote: ''
  };

  const playerByName = {};
  DATA.players.forEach(p => {
    playerByName[p.name] = p;
  });

  function formatSalary(sal) {
    return '$' + Number(sal || 0).toLocaleString('en-US');
  }

  function formatSigned(val, digits = 2) {
    const n = Number(val || 0);
    if (Math.abs(n) < 0.0005) return '0.00';
    return (n > 0 ? '+' : '') + n.toFixed(digits);
  }

  function loadPreset(presetId) {
    const preset = DATA.presets.find(pr => pr.id === presetId);
    if (!preset) return;
    state.activePresetId = presetId;
    state.roster.forEach(s => { s.player = null; });
    preset.slots.forEach((sl, idx) => {
      const pObj = playerByName[sl.player];
      if (pObj && state.roster[idx]) {
        state.roster[idx].player = pObj;
      }
    });
    state.strategyNote = `${preset.contest} — ${preset.strategy}`;
    renderAll();
  }

  function clearRoster() {
    state.roster.forEach(s => { s.player = null; });
    state.strategyNote = 'Custom interactive build — click + on any player row to draft into an open slot.';
    renderAll();
  }

  function isPlayerInRoster(pName) {
    return state.roster.some(s => s.player && s.player.name === pName);
  }

  function togglePlayerDraft(pName, ev) {
    if (ev) ev.stopPropagation();
    const existingIdx = state.roster.findIndex(s => s.player && s.player.name === pName);
    if (existingIdx !== -1) {
      state.roster[existingIdx].player = null;
      renderAll();
      return;
    }
    const pObj = playerByName[pName];
    if (!pObj) return;
    // Find first open primary slot, then FLEX
    const openSlot = state.roster.find(s => !s.player && s.accept.includes(pObj.pos));
    if (!openSlot) {
      alert(`All ${pObj.pos === 'DST' ? 'DEF' : pObj.pos}${['RB','WR','TE'].includes(pObj.pos) ? '/FLEX' : ''} slots are currently full. Remove a player first.`);
      return;
    }
    openSlot.player = pObj;
    renderAll();
  }

  function removeSlotIndex(idx) {
    if (state.roster[idx]) {
      state.roster[idx].player = null;
      renderAll();
    }
  }

  function exportRosterCSV() {
    const filled = state.roster.filter(s => s.player);
    if (!filled.length) {
      alert('Add players or load a preset lineup before exporting.');
      return;
    }
    const lines = [
      'slot,fd_id,player,pos,team,opp,salary,vegas_base,our_v6_proj,value_per_1k'
    ];
    state.roster.forEach(s => {
      if (s.player) {
        const p = s.player;
        lines.push(`${s.slot},${p.id},"${p.name}",${p.pos},${p.team},${p.opp},${p.salary},${p.base.toFixed(2)},${p.adjusted.toFixed(2)},${p.value_per_1k.toFixed(2)}`);
      }
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fanduel-slate-${DATA.slate_id}-${state.activePresetId || 'custom'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getFilteredPlayers() {
    const q = state.search.trim().toLowerCase();
    const list = DATA.players.filter(p => {
      if (state.hideOut && ['O', 'IR', 'D'].includes(p.injury)) return false;
      if (state.game !== 'ALL' && p.game !== state.game) return false;
      if (state.team !== 'ALL' && p.team !== state.team) return false;
      if (state.pos === 'QB' && p.pos !== 'QB') return false;
      if (state.pos === 'RB' && p.pos !== 'RB') return false;
      if (state.pos === 'WR' && p.pos !== 'WR') return false;
      if (state.pos === 'TE' && p.pos !== 'TE') return false;
      if (state.pos === 'DEF' && p.pos !== 'DST') return false;
      if (state.pos === 'FLEX' && !['RB', 'WR', 'TE'].includes(p.pos)) return false;
      if (state.pos === 'SLEEPERS') {
        if (p.salary > 7500 || p.adjusted < 6.0 || p.sleeper_mult <= 0.04) return false;
      }
      if (q) {
        const hay = `${p.name} ${p.team} ${p.opp} ${p.pos} ${p.matchup}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const col = state.sortCol;
    const dir = state.sortDesc ? -1 : 1;
    list.sort((a, b) => {
      let va, vb;
      if (col in a.signals) {
        va = a.signals[col];
        vb = b.signals[col];
      } else if (col === 'name' || col === 'pos' || col === 'team') {
        return dir * String(a[col]).localeCompare(String(b[col]));
      } else {
        va = a[col];
        vb = b[col];
      }
      if (va === vb) return b.adjusted - a.adjusted;
      return dir * (va - vb);
    });
    return list;
  }

  function renderGameStrip() {
    const el = document.getElementById('fd-game-strip');
    if (!el) return;
    let html = `
      <div class="fd-game-chip ${state.game === 'ALL' ? 'active' : ''}" data-game="ALL">
        <div class="g-teams">ALL 10 GAMES <span class="fd-roof-tag">510 PLAYERS</span></div>
        <div class="g-meta">Sun 1:00 PM & 4:05/4:25 PM ET</div>
      </div>
    `;
    DATA.games.forEach(g => {
      const isAct = state.game === g.code ? 'active' : '';
      const roofClass = (g.roof === 'dome' || g.roof === 'closed') ? 'dome' : '';
      const fav = g.home_spread <= 0 ? `${g.home} ${g.home_spread}` : `${g.away} -${g.home_spread}`;
      html += `
        <div class="fd-game-chip ${isAct}" data-game="${g.code}">
          <div class="g-teams">
            ${g.away} @ ${g.home}
            <span class="fd-roof-tag ${roofClass}">${g.roof}</span>
          </div>
          <div class="g-meta">O/U ${g.total.toFixed(1)} • ${fav}</div>
        </div>
      `;
    });
    el.innerHTML = html;
    el.querySelectorAll('.fd-game-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        state.game = chip.getAttribute('data-game');
        renderAll();
      });
    });
  }

  function renderPlayerTable() {
    const filtered = getFilteredPlayers();
    const countEl = document.getElementById('fd-FilteredCount');
    if (countEl) countEl.textContent = `${filtered.length} of ${DATA.players.length} players shown`;

    // Update header sort indicators
    document.querySelectorAll('.fd-player-table thead th[data-sort]').forEach(th => {
      const sc = th.getAttribute('data-sort');
      th.classList.toggle('sorted', sc === state.sortCol);
      const baseText = th.getAttribute('data-label') || th.textContent.replace(/[▼▲]/g, '').trim();
      th.setAttribute('data-label', baseText);
      if (sc === state.sortCol) {
        th.innerHTML = `${baseText} ${state.sortDesc ? '▼' : '▲'}`;
      } else {
        th.innerHTML = baseText;
      }
    });

    const tbody = document.getElementById('fd-player-tbody');
    if (!tbody) return;

    const rowsHtml = filtered.map((p, idx) => {
      const drafted = isPlayerInRoster(p.name);
      const isOut = ['O', 'IR', 'D'].includes(p.injury);
      const valClass = p.value_per_1k >= 3.0 ? 'val-elite' : (p.value_per_1k >= 2.3 ? 'val-good' : 'val-low');
      const injBadge = p.injury ? `<span class="inj-badge inj-${p.injury}" title="${p.inj_detail || p.injury}">${p.injury}</span>` : '';
      const sleeperTag = (p.salary <= 7500 && p.sleeper_mult >= 0.08 && p.adjusted >= 8.0)
        ? `<span class="sleeper-pill" title="High Sleeper/Breakout Multiplier (+${(p.sleeper_mult*100).toFixed(1)}%)">SLEEPER</span>`
        : '';

      const fmtSig = (val) => {
        const cls = val > 0.02 ? 'sig-pos' : (val < -0.02 ? 'sig-neg' : 'sig-zero');
        return `<span class="${cls}">${formatSigned(val, 2)}</span>`;
      };

      return `
        <tr class="${drafted ? 'drafted-row' : ''} ${isOut ? 'out-row' : ''}" data-player="${p.name}">
          <td class="col-pos">
            <span class="pos-badge pos-${p.pos}">${p.fd_pos}</span>
          </td>
          <td class="col-player">
            <div class="p-name-wrap">
              <span class="p-name">${idx + 1}. ${p.name}</span>
              ${injBadge}
              ${sleeperTag}
            </div>
            <div class="p-submeta">${p.team} ${p.is_home ? 'vs' : '@'} ${p.opp} • Implied ${p.implied_team.toFixed(2)} pts (${p.spread_team > 0 ? '+' : ''}${p.spread_team})</div>
          </td>
          <td class="col-game">
            <div style="font-weight:700;color:#e2e8f0;font-size:12px;">${p.matchup}</div>
            <div class="p-submeta">${p.roof} • ${p.surface}</div>
          </td>
          <td>${p.fppg.toFixed(1)}</td>
          <td>${p.base.toFixed(2)}</td>
          <td class="proj-cell">${p.adjusted.toFixed(2)}</td>
          <td class="salary-cell">${formatSalary(p.salary)}</td>
          <td><span class="val-badge ${valClass}">${p.value_per_1k.toFixed(2)}x</span></td>
          <td>${fmtSig(p.signals.first_downs_rate)}</td>
          <td>${fmtSig(p.signals.td_regression)}</td>
          <td>${fmtSig(p.signals.opportunity_share)}</td>
          <td>${fmtSig(p.signals.injury_step_up)}</td>
          <td>${fmtSig(p.signals.per_snap_breakout)}</td>
          <td>${fmtSig(p.signals.opp_defender_matchup)}</td>
          <td>${fmtSig(p.signals.ngs_skill_breakout)}</td>
          <td>${fmtSig(p.signals.pedigree_sleeper)}</td>
          <td style="text-align:center;">
            <button class="fd-draft-btn ${drafted ? 'added' : ''}" data-draft="${p.name}" title="${drafted ? 'Remove from lineup' : 'Draft to lineup'}">
              ${drafted ? '✓' : '+'}
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = rowsHtml;

    tbody.querySelectorAll('tr[data-player]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openPlayerModal(tr.getAttribute('data-player'));
      });
    });

    tbody.querySelectorAll('button[data-draft]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        togglePlayerDraft(btn.getAttribute('data-draft'), e);
      });
    });
  }

  function renderRosterPanel() {
    const slotsEl = document.getElementById('fd-roster-slots');
    if (!slotsEl) return;

    let usedSal = 0;
    let totalProj = 0;
    let totalBase = 0;
    let filledCount = 0;

    const html = state.roster.map((s, idx) => {
      if (!s.player) {
        return `
          <li class="fd-slot-row empty">
            <span class="slot-tag">${s.slot}</span>
            <span class="slot-empty-txt">Select ${s.slot === 'FLEX' ? 'RB / WR / TE' : s.slot}</span>
            <span></span>
            <span></span>
          </li>
        `;
      }
      const p = s.player;
      usedSal += p.salary;
      totalProj += p.adjusted;
      totalBase += p.base;
      filledCount += 1;
      return `
        <li class="fd-slot-row" data-pmodal="${p.name}" style="cursor:pointer;">
          <span class="slot-tag">${s.slot}</span>
          <div class="slot-player-info">
            <div class="sp-name">${p.name} <span style="font-size:10.5px;color:#93a6c7;">(${p.team})</span></div>
            <div class="sp-meta">${p.matchup} • Base ${p.base.toFixed(1)} → Adj ${p.adjusted.toFixed(2)}</div>
          </div>
          <div class="slot-nums">
            <div class="sn-proj">${p.adjusted.toFixed(2)} pts</div>
            <div class="sn-sal">${formatSalary(p.salary)} (${p.value_per_1k.toFixed(2)}x)</div>
          </div>
          <button class="slot-remove-btn" data-rmslot="${idx}" title="Remove player">×</button>
        </li>
      `;
    }).join('');

    slotsEl.innerHTML = html;

    slotsEl.querySelectorAll('button[data-rmslot]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSlotIndex(Number(btn.getAttribute('data-rmslot')));
      });
    });

    slotsEl.querySelectorAll('li[data-pmodal]').forEach(li => {
      li.addEventListener('click', () => {
        openPlayerModal(li.getAttribute('data-pmodal'));
      });
    });

    const remSal = DATA.salary_cap - usedSal;
    const remSlots = 9 - filledCount;
    const avgRem = remSlots > 0 ? Math.floor(remSal / remSlots) : 0;

    const remEl = document.getElementById('rm-sal-rem');
    if (remEl) {
      remEl.textContent = formatSalary(remSal);
      remEl.classList.toggle('over-cap', remSal < 0);
    }
    const avgEl = document.getElementById('rm-avg-rem');
    if (avgEl) avgEl.textContent = remSlots > 0 ? formatSalary(avgRem) : '$0';
    const projEl = document.getElementById('rm-tot-proj');
    if (projEl) projEl.textContent = totalProj.toFixed(2);
    const fillBadge = document.getElementById('rm-filled-badge');
    if (fillBadge) fillBadge.textContent = `${filledCount} / 9 SLOTS`;
    const noteEl = document.getElementById('fd-strategy-note');
    if (noteEl) {
      const lift = totalProj - totalBase;
      noteEl.innerHTML = `<strong>Active Lineup:</strong> ${state.strategyNote || 'Custom Roster'}<br><span style="color:#34d399;">Vegas EB Base Sum: ${totalBase.toFixed(2)} pts → v6 Adjusted: ${totalProj.toFixed(2)} pts (${lift >= 0 ? '+' : ''}${lift.toFixed(2)} pt signal edge)</span>`;
    }
  }

  function openPlayerModal(pName) {
    const p = playerByName[pName];
    if (!p) return;
    const modal = document.getElementById('fd-player-modal');
    const content = document.getElementById('fd-modal-content');
    if (!modal || !content) return;

    const multPct = (p.total_mult * 100).toFixed(1);
    const sigRows = SIGNAL_DEFINITIONS.map(sd => {
      const sVal = p.signals[sd.key] || 0;
      const w = sd.weight;
      const contribMult = w * sVal;
      const contribPts = p.base * contribMult;
      const pctWidth = Math.min(100, Math.abs(sVal) * 100);
      const barColor = sVal >= 0 ? '#00d084' : '#ff4d4f';
      return `
        <div class="sig-breakdown-row">
          <div>
            <div style="font-weight:700;color:#fff;">${sd.label}</div>
            <div style="font-size:10.5px;color:#93a6c7;font-family:var(--font-mono);">${sd.key}</div>
          </div>
          <div style="text-align:right;font-family:var(--font-mono);color:#93c5fd;">w = ${w.toFixed(2)}</div>
          <div style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${sVal >= 0 ? '#34d399' : '#f87171'};">
            s = ${formatSigned(sVal, 3)}
          </div>
          <div class="sig-bar-track">
            <div class="sig-bar-fill" style="width:${pctWidth}%;background:${barColor};"></div>
          </div>
          <div style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${contribPts >= 0 ? '#34d399' : '#f87171'};">
            ${formatSigned(contribPts, 2)} pts
          </div>
        </div>
      `;
    }).join('');

    content.innerHTML = `
      <div class="fd-modal-head">
        <div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="pos-badge pos-${p.pos}">${p.fd_pos}</span>
            <h3 style="font-size:18px;font-weight:800;color:#fff;">${p.name}</h3>
            <span style="color:#93a6c7;font-weight:700;">${p.team} ${p.is_home ? 'vs' : '@'} ${p.opp}</span>
          </div>
          <div style="font-size:12px;color:#93a6c7;margin-top:4px;">
            FanDuel ID: <code style="color:#fff;">${p.id}</code> • Salary: <strong style="color:#fff;">${formatSalary(p.salary)}</strong> • FD FPPG: <strong>${p.fppg.toFixed(2)}</strong> (${p.played} gms) • Source: <code>${p.base_src}</code>
          </div>
        </div>
        <button class="fd-btn-sm" id="fd-modal-close">✕ Close</button>
      </div>
      <div class="fd-modal-body">
        <div class="fd-roster-metrics" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px;">
          <div class="rm-box">
            <span class="rm-lbl">Vegas EB Base</span>
            <span class="rm-val">${p.base.toFixed(2)} pts</span>
          </div>
          <div class="rm-box">
            <span class="rm-lbl">v6 Signal Multiplier</span>
            <span class="rm-val" style="color:${p.total_mult >= 0 ? '#34d399' : '#f87171'};">${p.total_mult >= 0 ? '+' : ''}${multPct}%</span>
          </div>
          <div class="rm-box">
            <span class="rm-lbl">Final v6 Projection</span>
            <span class="rm-val proj-total">${p.adjusted.toFixed(2)} pts</span>
          </div>
          <div class="rm-box">
            <span class="rm-lbl">FD Value / $1,000</span>
            <span class="rm-val" style="color:#38bdf8;">${p.value_per_1k.toFixed(2)}x</span>
          </div>
        </div>
        <div style="font-size:12px;color:#93a6c7;margin-bottom:10px;">
          Formula: <code class="formula-code">adjusted = base × (1 + Σ weight_i × signal_i) = ${p.base.toFixed(2)} × (1 ${p.total_mult >= 0 ? '+' : '-'} ${Math.abs(p.total_mult).toFixed(4)}) = ${p.adjusted.toFixed(2)} FD pts</code>
        </div>
        <div>${sigRows}</div>
      </div>
    `;

    modal.classList.add('open');
    document.getElementById('fd-modal-close').addEventListener('click', () => {
      modal.classList.remove('open');
    });
  }

  function renderAuditView() {
    const activeTbody = document.getElementById('audit-active-tbody');
    if (activeTbody) {
      activeTbody.innerHTML = SIGNAL_DEFINITIONS.map((sd, i) => `
        <tr>
          <td style="font-family:var(--font-mono);font-weight:800;color:#fff;">#${i + 1}</td>
          <td>
            <div style="font-weight:800;color:#fff;font-size:13px;">${sd.label}</div>
            <code style="color:#38bdf8;font-family:var(--font-mono);font-size:11.5px;">${sd.key}</code>
          </td>
          <td style="font-family:var(--font-mono);font-size:14px;font-weight:800;color:#00d084;">+${sd.weight.toFixed(2)}</td>
          <td><span class="status-pill status-kept">${sd.tier}</span></td>
          <td style="font-size:12px;color:#cbd5e1;">${sd.owner}</td>
          <td>
            <div style="color:#e2e8f0;margin-bottom:4px;">${sd.desc}</div>
            <div class="formula-code">${sd.formula}</div>
          </td>
        </tr>
      `).join('');
    }

    const revTbody = document.getElementById('audit-reverted-tbody');
    if (revTbody) {
      revTbody.innerHTML = REVERTED_ATTRIBUTES.map(r => `
        <tr>
          <td><code style="color:#fca5a5;font-family:var(--font-mono);font-weight:700;">${r.name}</code></td>
          <td>${r.version}</td>
          <td style="font-family:var(--font-mono);font-weight:800;color:#f87171;">0.00 (REVERTED)</td>
          <td style="font-family:var(--font-mono);font-size:11.5px;color:#cbd5e1;">${r.metrics}</td>
          <td style="color:#e2e8f0;">${r.reason}</td>
        </tr>
      `).join('');
    }

    const prog = DATA.backtest.progression;
    const progRows = [
      { name: 'v1 — Judgment Weights on Unshrunk Share Base (7 legacy weights)', m: prog['1_v1_judgment_on_unshrunk_base'], status: 'Baseline v1' },
      { name: 'v2 — Unshrunk Vegas Share Base Only (weights zeroed)', m: prog['2_v2_unshrunk_base_only'], status: 'Re-fit v2' },
      { name: 'v3 Base — Empirical-Bayes Shrunk Vegas Share Base Only (K=3.5)', m: prog['3_v3_eb_shrunk_base_only'], status: 'EB Base Upgrade' },
      { name: 'v3 — EB Base + 6 Surviving Pre-Game Usage/Regression Signals', m: prog['4_v3_eb_base_plus_6_surviving_oof_cv'], status: 'KEPT (v3)' },
      { name: 'v4 — EB Base + 9 Signals (Added 3 Salary-Headroom Sleeper Signals)', m: prog['5_v4_eb_base_plus_9_surviving_with_sleepers_oof_cv'], status: 'KEPT (v4)' },
      { name: 'v4 + stadium_weather_surface (Dome/Turf/Grass × Rain/Wind)', m: prog['6_v4_plus_stadium_weather_surface_REVERTED_oof_cv'], status: 'REVERTED TO 0.0' },
      { name: 'v5 + stadium_weather_surface Combined Test', m: prog['7_v5_plus_stadium_weather_surface_combined_REVERTED_oof_cv'], status: 'REVERTED TO 0.0' },
      { name: 'v5 — EB Base + 10 Signals (Added opp_defender_matchup)', m: prog['8_v5_eb_base_plus_10_surviving_with_opp_defender_matchup_KEPT_oof_cv'], status: 'KEPT (v5)' },
      { name: 'v6 (CURRENT LOCKED) — EB Base + 11 Signals (Added ngs_skill_breakout)', m: prog['9_v6_eb_base_plus_11_surviving_with_ngs_skill_breakout_KEPT_oof_cv'], status: 'LOCKED WINNER (v6)' }
    ];

    const btTbody = document.getElementById('audit-backtest-tbody');
    if (btTbody) {
      btTbody.innerHTML = progRows.map(pr => {
        const m = pr.m;
        const lu = m.lineup_actuals;
        const isRev = pr.status.includes('REVERTED');
        const isV6 = pr.status.includes('v6');
        return `
          <tr style="${isV6 ? 'background:rgba(0,208,132,0.12);font-weight:700;' : ''}">
            <td style="color:#fff;font-weight:700;">${pr.name}</td>
            <td><span class="status-pill ${isRev ? 'status-reverted' : 'status-kept'}">${pr.status}</span></td>
            <td style="font-family:var(--font-mono);color:#38bdf8;font-weight:700;">${m.wk3_7_rho.toFixed(4)}</td>
            <td style="font-family:var(--font-mono);">${m.wk3_7_mae.toFixed(3)}</td>
            <td style="font-family:var(--font-mono);color:#38bdf8;">${m.wk4_7_rho.toFixed(4)}</td>
            <td style="font-family:var(--font-mono);">${m.wk4_7_mae.toFixed(3)}</td>
            <td style="font-family:var(--font-mono);">${lu.wk3.toFixed(2)} / ${lu.wk4.toFixed(2)} / ${lu.wk5.toFixed(2)} / ${lu.wk6.toFixed(2)}</td>
            <td style="font-family:var(--font-mono);font-weight:800;color:#00d084;">${lu.avg.toFixed(2)} FD pts</td>
          </tr>
        `;
      }).join('');
    }
  }

  function renderAll() {
    renderGameStrip();
    renderPlayerTable();
    renderRosterPanel();
  }

  function initEvents() {
    // View switcher (Player Board vs. Weights & Definitions)
    document.querySelectorAll('.fd-nav-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.view = btn.getAttribute('data-view');
        document.querySelectorAll('.fd-nav-btn[data-view]').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('view-board').style.display = state.view === 'board' ? 'block' : 'none';
        document.getElementById('view-audit').classList.toggle('active', state.view === 'audit');
      });
    });

    // Position tabs
    document.querySelectorAll('.fd-pos-tab[data-pos]').forEach(tab => {
      tab.addEventListener('click', () => {
        state.pos = tab.getAttribute('data-pos');
        document.querySelectorAll('.fd-pos-tab[data-pos]').forEach(t => t.classList.toggle('active', t === tab));
        renderPlayerTable();
      });
    });

    // Team dropdown populate
    const teamSel = document.getElementById('fd-team-select');
    if (teamSel) {
      const teams = Array.from(new Set(DATA.players.map(p => p.team))).sort();
      teams.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = `${t}`;
        teamSel.appendChild(opt);
      });
      teamSel.addEventListener('change', () => {
        state.team = teamSel.value;
        renderPlayerTable();
      });
    }

    // Search input
    const searchIn = document.getElementById('fd-search-input');
    if (searchIn) {
      searchIn.addEventListener('input', () => {
        state.search = searchIn.value;
        renderPlayerTable();
      });
    }

    // Hide OUT checkbox
    const hideOutChk = document.getElementById('fd-hide-out');
    if (hideOutChk) {
      hideOutChk.addEventListener('change', () => {
        state.hideOut = hideOutChk.checked;
        renderPlayerTable();
      });
    }

    // Table column sorting
    document.querySelectorAll('.fd-player-table thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-sort');
        if (state.sortCol === col) {
          state.sortDesc = !state.sortDesc;
        } else {
          state.sortCol = col;
          state.sortDesc = (col !== 'name' && col !== 'pos' && col !== 'team');
        }
        renderPlayerTable();
      });
    });

    // Preset selector
    const presetSel = document.getElementById('fd-preset-select');
    if (presetSel) {
      DATA.presets.forEach(pr => {
        const opt = document.createElement('option');
        opt.value = pr.id;
        opt.textContent = pr.label;
        presetSel.appendChild(opt);
      });
      presetSel.value = 'contest-1';
      presetSel.addEventListener('change', () => {
        loadPreset(presetSel.value);
      });
    }

    const optBtn = document.getElementById('btn-load-opt1');
    if (optBtn) {
      optBtn.addEventListener('click', () => {
        if (presetSel) presetSel.value = 'opt-1';
        loadPreset('opt-1');
      });
    }

    const clearBtn = document.getElementById('btn-clear-roster');
    if (clearBtn) clearBtn.addEventListener('click', clearRoster);

    const expBtn = document.getElementById('btn-export-csv');
    if (expBtn) expBtn.addEventListener('click', exportRosterCSV);

    // Close modal on backdrop click
    const modal = document.getElementById('fd-player-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    renderAuditView();
    loadPreset('contest-1');
  });
})();
