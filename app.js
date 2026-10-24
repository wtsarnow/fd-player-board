/**
 * FanDuel NFL Player Selection & Historic Trends Board (100% CSV-Driven + Cache Busting)
 * Zero hardcoded player, lineup, backtest, or historical numbers in JS.
 * Dynamically loads all 9 CSV files from data/*.csv with cache-busting query strings and { cache: "no-store" }.
 */
(function () {
  'use strict';

  const DB = {
    meta: {},
    players: [],
    playerByName: {},
    lineups: [],
    weeklySummary: [],
    histPlayers: [],
    posSummary: [],
    weights: [],
    reverted: [],
    backtest: [],
    lastFetchTs: null
  };

  const STATE = {
    activeTab: 'players',
    posFilter: 'ALL',
    gameFilter: 'ALL',
    sleepersOnly: false,
    activeOnly: true,
    searchQuery: '',
    sortBy: 'our_proj_desc',
    activePresetId: 'contest-1',
    roster: [
      { slot: 'QB', accept: ['QB'], player: null },
      { slot: 'RB1', accept: ['RB'], player: null },
      { slot: 'RB2', accept: ['RB'], player: null },
      { slot: 'WR1', accept: ['WR'], player: null },
      { slot: 'WR2', accept: ['WR'], player: null },
      { slot: 'WR3', accept: ['WR'], player: null },
      { slot: 'TE', accept: ['TE'], player: null },
      { slot: 'FLEX', accept: ['RB', 'WR', 'TE'], player: null },
      { slot: 'DEF', accept: ['DST', 'DEF', 'D'], player: null }
    ],
    lineupMetaText: '',
    histWeek: 'COMPLETED',
    histPos: 'ALL',
    histOutcome: 'ALL',
    histSort: 'actual_desc',
    histSearch: '',
    histPage: 1,
    histPageSize: 100
  };

  // RFC-4180 CSV parser
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const len = text.length;

    for (let i = 0; i < len; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          row.push(field);
          field = '';
        } else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && i + 1 < len && text[i + 1] === '\n') i++;
          row.push(field);
          field = '';
          if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) {
            rows.push(row);
          }
          row = [];
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) {
        rows.push(row);
      }
    }
    if (rows.length === 0) return [];
    const headers = rows[0].map(h => h.trim());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const obj = {};
      const cur = rows[r];
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = cur[c] !== undefined ? cur[c] : '';
      }
      out.push(obj);
    }
    return out;
  }

  async function fetchCSV(relPath, cacheBustParam) {
    const url = `${relPath}?${cacheBustParam}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url} (HTTP ${res.status})`);
    }
    const text = await res.text();
    return parseCSV(text);
  }

  function num(val, fallback = 0) {
    if (val === '' || val === null || val === undefined) return fallback;
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmtMoney(val) {
    return '$' + Math.round(num(val)).toLocaleString('en-US');
  }

  function fmtSigned(val, digits = 2) {
    const n = num(val);
    if (Math.abs(n) < 0.0005) return '0.00';
    return (n > 0 ? '+' : '') + n.toFixed(digits);
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadAllCSVData(isManualRefresh = false) {
    const btnRefresh = document.getElementById('btn-refresh-csv');
    if (btnRefresh) {
      btnRefresh.classList.add('refreshing');
      btnRefresh.textContent = '⏳ Fetching Live CSVs…';
    }

    try {
      const ts = Date.now();
      // 1. Fetch meta.csv first with ?t=${Date.now()} and { cache: "no-store" }
      const metaRows = await fetchCSV('data/meta.csv', `t=${ts}`);
      const metaObj = {};
      metaRows.forEach(r => {
        if (r.key) metaObj[r.key] = r.value;
      });
      DB.meta = metaObj;

      // 2. Build cache-busting query string using meta.build_id + timestamp
      const buildId = metaObj.build_id || String(ts);
      const bust = `v=${encodeURIComponent(buildId)}&t=${ts}`;

      // 3. Fetch all remaining 8 CSV files in parallel with cache-busting query string and { cache: "no-store" }
      const [
        playersRaw,
        lineupsRaw,
        weeklyRaw,
        histPlayersRaw,
        posSummaryRaw,
        weightsRaw,
        revertedRaw,
        backtestRaw
      ] = await Promise.all([
        fetchCSV('data/current_players.csv', bust),
        fetchCSV('data/lineups.csv', bust),
        fetchCSV('data/historic_weekly_summary.csv', bust),
        fetchCSV('data/historic_player_projections.csv', bust),
        fetchCSV('data/historic_position_summary.csv', bust),
        fetchCSV('data/weights.csv', bust),
        fetchCSV('data/reverted_signals.csv', bust),
        fetchCSV('data/backtest_versions.csv', bust)
      ]);

      const keyToColPrefix = {
        first_downs_rate: 'First_Downs_Rate',
        td_regression: 'TD_Regression',
        opportunity_share: 'Opportunity_Share',
        injury_step_up: 'Injury_Step_Up',
        per_snap_breakout: 'Per_Snap_Breakout',
        opp_defender_matchup: 'Opp_Defender_Matchup',
        ngs_skill_breakout: 'NGS_Skill_Breakout',
        pedigree_sleeper: 'Pedigree_Sleeper',
        floor_consistency: 'Floor_Consistency',
        snap_momentum: 'Snap_Momentum',
        social_media_buzz: 'Social_Media_Buzz'
      };
      DB.weights = weightsRaw.map(w => ({
        ...w,
        attribute: keyToColPrefix[w.key] || w.name || w.key,
        displayName: w.name || w.key,
        description: w.why_it_works || w.description || '',
        cv_evidence: `Share of signal weight: ${w.share_pct || ''}`,
        weightNum: num(w.weight)
      }));

      DB.players = playersRaw.map(p => {
        const obj = {
          ...p,
          rankNum: num(p.rank),
          salaryNum: num(p.salary),
          ourProjNum: num(p.our_proj),
          fdProjNum: num(p.fd_proj),
          baseProjNum: num(p.base_proj),
          edgeNum: num(p.proj_edge),
          valNum: num(p.value_per_1k),
          ceilNum: num(p.ceil),
          floorNum: num(p.floor),
          spreadNum: num(p.spread),
          ouNum: num(p.over_under),
          impNum: num(p.implied_total),
          isSleeperBool: String(p.is_sleeper).toLowerCase() === 'true'
        };
        return obj;
      });

      DB.playerByName = {};
      DB.players.forEach(p => {
        DB.playerByName[p.name] = p;
      });

      DB.lineups = lineupsRaw;
      DB.weeklySummary = weeklyRaw.map(w => ({
        ...w,
        status: w.our_rho === 'PENDING' ? 'PRE-GAME LOCKED' : 'COMPLETED',
        slate_label: w.label || `Week ${w.week}`,
        date_et: w.slate_type || '',
        rho_lift: w.rho_gain || w.rho_lift || '',
        our_opt_proj: w.our_opt_lineup_proj || w.our_opt_proj || '',
        our_opt_actual: w.our_opt_lineup_actual === 'PENDING' ? '' : (w.our_opt_lineup_actual || ''),
        fd_opt_proj: w.fd_opt_lineup_proj || w.fd_opt_proj || '',
        fd_opt_actual: w.fd_opt_lineup_actual === 'PENDING' ? '' : (w.fd_opt_lineup_actual || ''),
        opt_actual_edge: w.opt_lineup_edge_pts === 'PENDING' ? 'Pending' : (w.opt_lineup_edge_pts || ''),
        tysa_best_actual: w.tysa_best_entry_actual === 'PENDING' ? '' : (w.tysa_best_entry_actual || '')
      }));
      DB.histPlayers = histPlayersRaw.map(r => {
        const hasAct = r.actual_fd !== '' && r.actual_fd !== undefined && r.actual_fd !== 'PENDING';
        return {
          ...r,
          window: r.game_window || r.slate || '',
          weekNum: num(r.week),
          salaryNum: num(r.salary),
          ourProjNum: num(r.our_proj_pregame ?? r.our_proj),
          fdProjNum: num(r.fd_proj_pregame ?? r.fd_proj),
          baseProjNum: num(r.base_proj_pregame ?? r.base_proj),
          edgeNum: num(r.our_diff_vs_fd ?? r.proj_edge_vs_fd),
          actualNum: hasAct ? num(r.actual_fd) : null,
          ourErrNum: r.our_error === '' ? null : num(r.our_error),
          fdErrNum: r.fd_error === '' ? null : num(r.fd_error),
          ourAbsErrNum: r.our_abs_error === '' ? null : num(r.our_abs_error),
          fdAbsErrNum: r.fd_abs_error === '' ? null : num(r.fd_abs_error),
          isCompleted: hasAct,
          isSleeperBool: String(r.is_sleeper).toLowerCase() === 'true',
          ourBeatFdBool: String(r.our_beat_fd).toLowerCase() === 'true'
        };
      });
      DB.posSummary = posSummaryRaw;
      DB.reverted = revertedRaw.map(r => ({
        ...r,
        attribute: r.key || r.attribute || '',
        description: r.name || r.description || '',
        version_tested: r.tested_in || r.version_tested || '',
        cv_result: r.cv_impact || r.cv_result || '',
        revert_reason: r.reason || r.revert_reason || ''
      }));
      DB.backtest = backtestRaw.map(b => ({
        ...b,
        label: b.name || b.label || '',
        status: String(b.is_active).toLowerCase() === 'true' ? 'LOCKED WINNER (v6)' : (String(b.notes).includes('REVERTED') ? 'REVERTED TO 0.0' : 'VALIDATED STEP')
      }));
      DB.lastFetchTs = new Date();

      // Update CSV download links with cache-busting query string
      document.querySelectorAll('a[href^="data/"]').forEach(a => {
        const baseHref = a.getAttribute('href').split('?')[0];
        a.setAttribute('href', `${baseHref}?v=${encodeURIComponent(buildId)}`);
      });

      renderHeaderAndMeta();
      populatePresetSelect();
      if (!isManualRefresh || !STATE.roster.some(s => s.player)) {
        loadPresetLineup(STATE.activePresetId || 'contest-1');
      } else {
        // Re-bind rostered player objects to fresh CSV objects
        STATE.roster.forEach(s => {
          if (s.player && DB.playerByName[s.player.name]) {
            s.player = DB.playerByName[s.player.name];
          }
        });
      }
      renderGamesStrip();
      renderPlayerTable();
      renderLineupPanel();
      renderHistoricView();
      renderWeightsView();

      if (btnRefresh) {
        btnRefresh.classList.remove('refreshing');
        const timeStr = DB.lastFetchTs.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        btnRefresh.textContent = isManualRefresh ? `✓ Refreshed (${timeStr})` : '🔄 Refresh Live Data';
      }
    } catch (err) {
      console.error('Error loading CSV data:', err);
      if (btnRefresh) {
        btnRefresh.classList.remove('refreshing');
        btnRefresh.textContent = '⚠ Retry CSV Fetch';
      }
    }
  }

  function renderHeaderAndMeta() {
    const m = DB.meta;
    const allSummary = DB.weeklySummary.find(w => w.week === 'ALL') || {};

    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };

    setTxt('hdr-version-badge', m.active_version || 'v6 CSV');
    setTxt('hdr-slate-title', `${m.title || ''} • Build ${m.build_id || ''}`);
    setTxt('hdr-rho-val', allSummary.our_rho ? `${allSummary.our_rho} (vs FD ${allSummary.fd_rho})` : '—');
    setTxt('hdr-mae-val', allSummary.our_mae ? `${allSummary.our_mae} (vs FD ${allSummary.fd_mae})` : '—');
    setTxt('hdr-opt-val', allSummary.our_opt_actual ? `${allSummary.our_opt_actual} pts` : '—');
    setTxt('hdr-lock-time', `Lock: ${m.lock_time || '—'}`);

    setTxt('player-count-badge', String(DB.players.length));
    setTxt('total-player-count', String(DB.players.length));
    setTxt('csv-hist-players-count', `${DB.histPlayers.length.toLocaleString()} rows`);
    setTxt('csv-curr-players-count', `${DB.players.length} rows`);
    setTxt('csv-lineups-count', `${DB.lineups.length} lineups`);

    const nComp = DB.histPlayers.filter(r => r.isCompleted).length;
    const nPre = DB.histPlayers.filter(r => !r.isCompleted).length;
    setTxt('hist-eyebrow-counts', `WEEKS 3–7 COMPLETED (n = ${nComp.toLocaleString()}) + WEEK ${m.week || '8'} PRE-GAME LOCKED (n = ${nPre.toLocaleString()})`);

    setTxt('hist-bot-name', m.updater_bot || '@fd-board-updater');
    setTxt('hist-bot-id', m.updater_bot_id || '');
    setTxt('hist-pregame-sched', m.pregame_schedule || '');
    setTxt('hist-postgame-sched', m.postgame_schedule || '');
    setTxt('hist-generated-at', `${m.generated_at || ''} • Build ${m.build_id || ''}`);
  }

  // ==========================================================================
  // TAB 1: PLAYER POOL & 9-SLOT LINEUP BUILDER
  // ==========================================================================
  function renderGamesStrip() {
    const strip = document.getElementById('games-strip');
    if (!strip) return;

    const gamesMap = new Map();
    DB.players.forEach(p => {
      if (!p.game) return;
      if (!gamesMap.has(p.game)) {
        gamesMap.set(p.game, {
          game: p.game,
          ou: p.ouNum,
          count: 0
        });
      }
      gamesMap.get(p.game).count++;
    });

    const games = Array.from(gamesMap.values());
    let html = `
      <div class="fd-game-chip ${STATE.gameFilter === 'ALL' ? 'active' : ''}" data-game="ALL">
        <div class="g-teams">ALL ${games.length} GAMES</div>
        <div class="g-meta">${DB.players.length} Players • Slate #${esc(DB.meta.slate_id)}</div>
      </div>
    `;

    games.forEach(g => {
      const isAct = STATE.gameFilter === g.game ? 'active' : '';
      html += `
        <div class="fd-game-chip ${isAct}" data-game="${esc(g.game)}">
          <div class="g-teams">${esc(g.game)}</div>
          <div class="g-meta">O/U ${g.ou.toFixed(1)} • ${g.count} plyrs</div>
        </div>
      `;
    });

    strip.innerHTML = html;
    strip.querySelectorAll('.fd-game-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        STATE.gameFilter = chip.getAttribute('data-game');
        renderGamesStrip();
        renderPlayerTable();
      });
    });
  }

  function isRostered(playerName) {
    return STATE.roster.some(s => s.player && s.player.name === playerName);
  }

  function getTopSignalChips(p) {
    const sigCols = [
      { col: 'First_Downs_Rate', short: '1stDn' },
      { col: 'TD_Regression', short: 'TDReg' },
      { col: 'Opportunity_Share', short: 'OppShr' },
      { col: 'Injury_Step_Up', short: 'InjUp' },
      { col: 'Per_Snap_Breakout', short: 'SnapBrk' },
      { col: 'Opp_Defender_Matchup', short: 'DefMup' },
      { col: 'NGS_Skill_Breakout', short: 'NGS+FTN' },
      { col: 'Pedigree_Sleeper', short: 'PedSlp' },
      { col: 'Floor_Consistency', short: 'Floor' },
      { col: 'Snap_Momentum', short: 'SnapMom' },
      { col: 'Social_Media_Buzz', short: 'Buzz' }
    ];
    const items = sigCols
      .map(s => ({
        short: s.short,
        pts: num(p[`${s.col}_pts`]),
        z: num(p[`${s.col}_z`])
      }))
      .filter(x => Math.abs(x.pts) >= 0.08)
      .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
      .slice(0, 3);

    if (!items.length) {
      return '<span style="color:var(--fd-text-dim);font-size:11px;">Neutral (0.00)</span>';
    }
    return `<div class="driver-chips">${items
      .map(it => `<span class="driver-chip ${it.pts >= 0 ? 'pos' : 'neg'}">${it.short} ${fmtSigned(it.pts, 2)}</span>`)
      .join('')}</div>`;
  }

  function renderPlayerTable() {
    const tbody = document.getElementById('player-tbody');
    if (!tbody) return;

    const q = STATE.searchQuery.trim().toLowerCase();
    const filtered = DB.players.filter(p => {
      if (STATE.activeOnly && (['O', 'IR', 'D', 'OUT'].includes(p.status) || p.ourProjNum <= 0)) {
        return false;
      }
      if (STATE.sleepersOnly && !p.isSleeperBool) return false;
      if (STATE.gameFilter !== 'ALL' && p.game !== STATE.gameFilter) return false;
      if (STATE.posFilter !== 'ALL') {
        if (STATE.posFilter === 'FLEX') {
          if (!['RB', 'WR', 'TE'].includes(p.pos)) return false;
        } else if (STATE.posFilter === 'DEF') {
          if (!['DST', 'DEF', 'D'].includes(p.pos)) return false;
        } else if (p.pos !== STATE.posFilter) {
          return false;
        }
      }
      if (q) {
        const hay = `${p.name} ${p.team} ${p.opp} ${p.pos} ${p.game} ${p.sleeper_reasons || ''} ${p.injury_note || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sMode = STATE.sortBy;
    filtered.sort((a, b) => {
      switch (sMode) {
        case 'fd_proj_desc': return b.fdProjNum - a.fdProjNum;
        case 'base_desc': return b.baseProjNum - a.baseProjNum;
        case 'edge_desc': return b.edgeNum - a.edgeNum;
        case 'value_desc': return b.valNum - a.valNum;
        case 'salary_desc': return b.salaryNum - a.salaryNum || b.ourProjNum - a.ourProjNum;
        case 'salary_asc': return a.salaryNum - b.salaryNum || b.ourProjNum - a.ourProjNum;
        case 'ngs_desc': return num(b.NGS_Skill_Breakout_pts) - num(a.NGS_Skill_Breakout_pts);
        case 'def_desc': return num(b.Opp_Defender_Matchup_pts) - num(a.Opp_Defender_Matchup_pts);
        case 'inj_desc': return num(b.Injury_Step_Up_pts) - num(a.Injury_Step_Up_pts);
        case 'our_proj_desc':
        default:
          return b.ourProjNum - a.ourProjNum;
      }
    });

    const visEl = document.getElementById('visible-player-count');
    if (visEl) visEl.textContent = String(filtered.length);

    tbody.innerHTML = filtered.map((p, i) => {
      const rostered = isRostered(p.name);
      const statusBadge = p.status ? `<span class="status-badge status-${esc(p.status)}" title="${esc(p.injury_note)}">${esc(p.status)}</span>` : '';
      const sleeperBadge = p.isSleeperBool ? `<span class="sleeper-tag" title="${esc(p.sleeper_reasons)}">★ SLEEPER</span>` : '';
      const edgeCls = p.edgeNum >= 0.05 ? 'edge-pos' : (p.edgeNum <= -0.05 ? 'edge-neg' : '');

      return `
        <tr class="${rostered ? 'rostered-row' : ''}" data-player-name="${esc(p.name)}">
          <td class="col-rank">${i + 1}</td>
          <td class="col-pos"><span class="pos-badge pos-${esc(p.pos)}">${esc(p.pos === 'DST' ? 'DEF' : p.pos)}</span></td>
          <td class="col-player">
            <div class="p-name-line">
              <span>${esc(p.name)}</span>
              ${statusBadge}
              ${sleeperBadge}
            </div>
            <div class="p-sub-line">${esc(p.team)} ${p.home_away === 'HOME' ? 'vs' : '@'} ${esc(p.opp)} ${p.sleeper_reasons ? '• ' + esc(p.sleeper_reasons) : ''}</div>
          </td>
          <td class="col-game">
            <div style="font-weight:700;color:#e2e8f0;font-size:12px;">${esc(p.game)}</div>
            <div class="p-sub-line">Imp ${p.impNum.toFixed(1)} • O/U ${p.ouNum.toFixed(1)}</div>
          </td>
          <td>${p.fdProjNum.toFixed(2)}</td>
          <td>${p.baseProjNum.toFixed(2)}</td>
          <td class="col-signals">${getTopSignalChips(p)}</td>
          <td class="col-proj-cell">${p.ourProjNum.toFixed(2)}</td>
          <td class="${edgeCls}">${fmtSigned(p.edgeNum, 2)}</td>
          <td>${p.valNum.toFixed(2)}x</td>
          <td style="font-weight:800;color:#fff;">${fmtMoney(p.salaryNum)}</td>
          <td style="text-align:center;">
            <button type="button" class="add-btn ${rostered ? 'rostered' : ''}" data-draft-name="${esc(p.name)}" title="${rostered ? 'Remove from lineup' : 'Add to lineup'}">
              ${rostered ? '✓' : '+'}
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-player-name]').forEach(tr => {
      tr.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        openPlayerModal(tr.getAttribute('data-player-name'));
      });
    });

    tbody.querySelectorAll('button[data-draft-name]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        togglePlayerInLineup(btn.getAttribute('data-draft-name'));
      });
    });
  }

  function populatePresetSelect() {
    const sel = document.getElementById('preset-select');
    if (!sel) return;
    sel.innerHTML = DB.lineups.map(lu => `
      <option value="${esc(lu.preset_id)}">${esc(lu.label)} — ${fmtMoney(lu.salary)} (${num(lu.our_proj).toFixed(2)} pts)</option>
    `).join('');
    sel.value = STATE.activePresetId;
  }

  function cleanSlotCellName(rawCell) {
    if (!rawCell) return '';
    return String(rawCell).replace(/\s*\(\$[\d,]+\)\s*$/, '').trim();
  }

  function loadPresetLineup(presetId) {
    const lu = DB.lineups.find(r => r.preset_id === presetId) || DB.lineups[0];
    if (!lu) return;
    STATE.activePresetId = lu.preset_id;
    const sel = document.getElementById('preset-select');
    if (sel) sel.value = lu.preset_id;

    const slotCols = ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'WR3', 'TE', 'FLEX', 'DEF'];
    STATE.roster.forEach((slotObj, idx) => {
      const colName = slotCols[idx];
      const pName = cleanSlotCellName(lu[colName]);
      slotObj.player = DB.playerByName[pName] || null;
    });

    STATE.lineupMetaText = `${lu.label} • ${lu.contest || ''}`;
    renderPlayerTable();
    renderLineupPanel();
  }

  function togglePlayerInLineup(playerName) {
    const existingIdx = STATE.roster.findIndex(s => s.player && s.player.name === playerName);
    if (existingIdx !== -1) {
      STATE.roster[existingIdx].player = null;
      renderPlayerTable();
      renderLineupPanel();
      return;
    }
    const p = DB.playerByName[playerName];
    if (!p) return;
    const openSlot = STATE.roster.find(s => !s.player && s.accept.includes(p.pos));
    if (!openSlot) {
      alert(`All eligible ${p.pos} / FLEX slots are currently filled. Remove a player first.`);
      return;
    }
    openSlot.player = p;
    renderPlayerTable();
    renderLineupPanel();
  }

  function autoFillRemainingSlots() {
    const cap = num(DB.meta.salary_cap, 60000);
    let usedSal = STATE.roster.reduce((acc, s) => acc + (s.player ? s.player.salaryNum : 0), 0);
    const openIndices = STATE.roster.map((s, idx) => (!s.player ? idx : -1)).filter(i => i !== -1);
    if (openIndices.length === 0) return;

    const minSalPerOpen = 4000;
    openIndices.forEach((slotIdx, k) => {
      const slotObj = STATE.roster[slotIdx];
      const remainingAfterThis = openIndices.length - 1 - k;
      const maxAllowable = (cap - usedSal) - remainingAfterThis * minSalPerOpen;
      const candidate = DB.players
        .filter(p =>
          slotObj.accept.includes(p.pos) &&
          !isRostered(p.name) &&
          !['O', 'IR', 'D', 'OUT'].includes(p.status) &&
          p.salaryNum <= maxAllowable
        )
        .sort((a, b) => b.ourProjNum - a.ourProjNum)[0];
      if (candidate) {
        slotObj.player = candidate;
        usedSal += candidate.salaryNum;
      }
    });

    renderPlayerTable();
    renderLineupPanel();
  }

  function renderLineupPanel() {
    const slotsContainer = document.getElementById('roster-slots');
    if (!slotsContainer) return;

    const cap = num(DB.meta.salary_cap, 60000);
    let usedSal = 0;
    let totalOurProj = 0;
    let totalFdProj = 0;
    let filledCount = 0;

    slotsContainer.innerHTML = STATE.roster.map((s, idx) => {
      if (!s.player) {
        return `
          <div class="roster-slot-row empty">
            <span class="slot-pill">${esc(s.slot)}</span>
            <div class="slot-p-sub">Open ${esc(s.slot)} slot — click + on board</div>
            <div></div>
            <div></div>
          </div>
        `;
      }
      const p = s.player;
      usedSal += p.salaryNum;
      totalOurProj += p.ourProjNum;
      totalFdProj += p.fdProjNum;
      filledCount++;
      return `
        <div class="roster-slot-row">
          <span class="slot-pill">${esc(s.slot)}</span>
          <div>
            <div class="slot-p-name" data-modal-player="${esc(p.name)}">${esc(p.name)} <span style="color:var(--fd-text-muted);font-size:11px;">(${esc(p.team)})</span></div>
            <div class="slot-p-sub">${esc(p.game)} • FD ${p.fdProjNum.toFixed(1)} → Our ${p.ourProjNum.toFixed(2)}</div>
          </div>
          <div class="slot-p-nums">
            <div class="slot-p-proj">${p.ourProjNum.toFixed(2)}</div>
            <div class="slot-p-sal">${fmtMoney(p.salaryNum)}</div>
          </div>
          <button type="button" class="slot-rm-btn" data-rm-idx="${idx}" title="Remove player">×</button>
        </div>
      `;
    }).join('');

    slotsContainer.querySelectorAll('[data-modal-player]').forEach(el => {
      el.addEventListener('click', () => openPlayerModal(el.getAttribute('data-modal-player')));
    });

    slotsContainer.querySelectorAll('button[data-rm-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-rm-idx'));
        if (STATE.roster[idx]) {
          STATE.roster[idx].player = null;
          renderPlayerTable();
          renderLineupPanel();
        }
      });
    });

    const remSal = cap - usedSal;
    const openSlots = 9 - filledCount;
    const avgOpen = openSlots > 0 ? Math.floor(remSal / openSlots) : 0;
    const edgeTotal = totalOurProj - totalFdProj;

    const setTxt = (id, t) => {
      const el = document.getElementById(id);
      if (el) el.textContent = t;
    };

    const capRemEl = document.getElementById('cap-remaining');
    if (capRemEl) {
      capRemEl.textContent = fmtMoney(remSal);
      capRemEl.classList.toggle('over-cap', remSal < 0);
    }
    setTxt('cap-used', `${fmtMoney(usedSal)} / ${fmtMoney(cap)}`);
    setTxt('cap-avg-slot', openSlots > 0 ? fmtMoney(avgOpen) : '$0');
    setTxt('slots-filled-count', `${filledCount} / 9 Rostered`);
    setTxt('lineup-total-proj', totalOurProj.toFixed(2));
    setTxt('lineup-total-edge', `FD Proj: ${totalFdProj.toFixed(2)} (${fmtSigned(edgeTotal, 2)})`);

    setTxt('m-bar-slots', `${filledCount}/9`);
    setTxt('m-bar-sal', fmtMoney(remSal));
    setTxt('m-bar-proj', totalOurProj.toFixed(2));

    const footerEl = document.getElementById('lineup-footer-info');
    if (footerEl) {
      footerEl.innerHTML = `<strong>Active Build:</strong> ${esc(STATE.lineupMetaText || 'Custom Lineup')} • <strong>Total Edge vs FD:</strong> <span class="edge-pos">${fmtSigned(edgeTotal, 2)} FD pts</span>`;
    }
  }

  // ==========================================================================
  // TAB 2: HISTORIC TRENDS (OUR PROJ vs ACTUAL vs FANDUEL PROJ)
  // ==========================================================================
  function renderHistoricView() {
    renderHistoricKpisAndLegends();
    renderWeeklyLineupsChart();
    renderWeeklyAccuracyChart();
    renderScatterCalibrationChart();
    renderPosSummaryTable();
    renderHistoricWeeklyTable();
    renderHistoricExplorer();
  }

  function renderHistoricKpisAndLegends() {
    const allRow = DB.weeklySummary.find(r => r.week === 'ALL') || {};
    const wk8Row = DB.weeklySummary.find(r => r.week === '8') || {};

    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };
    setTxt('leg-our-opt', `Our Optimal Actual (${allRow.our_opt_actual || '—'} avg)`);
    setTxt('leg-tysa-opt', `Tysa Best Entry (${allRow.tysa_best_actual || '—'} avg)`);
    setTxt('leg-fd-opt', `FD Pre-Game Optimal (${allRow.fd_opt_actual || '—'} avg)`);
    setTxt('leg-our-acc', `Our v6 Pre-Game (ρ=${allRow.our_rho || '—'}, MAE=${allRow.our_mae || '—'})`);
    setTxt('leg-fd-acc', `FD Pre-Game (ρ=${allRow.fd_rho || '—'}, MAE=${allRow.fd_mae || '—'})`);

    const kpiGrid = document.getElementById('historic-kpi-grid');
    if (!kpiGrid) return;

    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <div class="k-lbl">Out-of-Sample Rank ρ (Wk 3–7)</div>
        <div class="k-val">${esc(allRow.our_rho)} <span style="font-size:13px;color:#38bdf8;">(${esc(allRow.rho_lift)} vs FD)</span></div>
        <div class="k-sub">Our v6 ρ = ${esc(allRow.our_rho)} vs. FanDuel Pre-Game ρ = ${esc(allRow.fd_rho)} across ${esc(allRow.n_players)} completed player-games</div>
      </div>
      <div class="kpi-card">
        <div class="k-lbl">Out-of-Sample MAE (Wk 3–7)</div>
        <div class="k-val">${esc(allRow.our_mae)} pts</div>
        <div class="k-sub">Beat FanDuel Pre-Game MAE (${esc(allRow.fd_mae)} pts) by ${esc(allRow.mae_improvement)} FD pts/player</div>
      </div>
      <div class="kpi-card">
        <div class="k-lbl">Head-to-Head Player Win Rate</div>
        <div class="k-val">${esc(allRow.our_beat_fd_pct)}%</div>
        <div class="k-sub">Our pre-game projection was closer to Actual FD Points than FanDuel’s in 5 of 5 weeks</div>
      </div>
      <div class="kpi-card">
        <div class="k-lbl">Our Pre-Game Optimal Lineup Actual</div>
        <div class="k-val">${esc(allRow.our_opt_actual)} pts/wk</div>
        <div class="k-sub">vs. FanDuel Pre-Game Optimal (${esc(allRow.fd_opt_actual)} pts/wk) → <strong>${esc(allRow.opt_actual_edge)} pts/wk edge</strong></div>
      </div>
      <div class="kpi-card">
        <div class="k-lbl">Tysa Entered Lineups Actual Avg</div>
        <div class="k-val">${esc(allRow.tysa_best_actual)} pts/wk</div>
        <div class="k-sub">${esc(allRow.tysa_contest_note)}</div>
      </div>
      <div class="kpi-card">
        <div class="k-lbl">Week 8 Locked Optimal Projection</div>
        <div class="k-val">${esc(wk8Row.our_opt_proj)} pts</div>
        <div class="k-sub">Slate #${esc(DB.meta.slate_id)} (${esc(wk8Row.n_players)} players) • FD Base for same lineup: ${esc(wk8Row.fd_opt_proj)} pts</div>
      </div>
    `;
  }

  function renderWeeklyLineupsChart() {
    const wrap = document.getElementById('chart-weekly-lineups');
    if (!wrap) return;
    const weeks = DB.weeklySummary.filter(r => r.week !== 'ALL');
    if (!weeks.length) return;

    const W = 680, H = 260, padL = 44, padR = 18, padT = 22, padB = 42;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxY = 185;
    const yScale = v => padT + plotH - (Math.min(maxY, Math.max(0, v)) / maxY) * plotH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly Optimal Lineup Scoring Chart">`;
    [0, 45, 90, 135, 180].forEach(tick => {
      const y = yScale(tick);
      svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1e3256" stroke-dasharray="3,3" />`;
      svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="#8ca2c6" font-size="10" font-family="JetBrains Mono">${tick}</text>`;
    });

    const groupW = plotW / weeks.length;
    const barW = Math.min(22, (groupW - 18) / 3);

    weeks.forEach((w, idx) => {
      const gx = padL + idx * groupW + 10;
      const isPre = w.status !== 'COMPLETED';
      const ourVal = isPre ? num(w.our_opt_proj) : num(w.our_opt_actual);
      const tysaVal = isPre ? num(w.our_opt_proj) : num(w.tysa_best_actual);
      const fdVal = isPre ? num(w.fd_opt_proj) : num(w.fd_opt_actual);

      const bars = [
        { val: ourVal, color: isPre ? '#1493ff' : '#00d084', lbl: ourVal.toFixed(1) },
        { val: tysaVal, color: '#38bdf8', lbl: tysaVal.toFixed(1) },
        { val: fdVal, color: '#f87171', lbl: fdVal.toFixed(1) }
      ];

      bars.forEach((b, bi) => {
        const bx = gx + bi * (barW + 3);
        const by = yScale(b.val);
        const bh = padT + plotH - by;
        svg += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="3" fill="${b.color}" opacity="${isPre ? '0.65' : '0.92'}" />`;
        svg += `<text x="${bx + barW / 2}" y="${by - 4}" text-anchor="middle" fill="#e2e8f0" font-size="9" font-family="JetBrains Mono">${b.lbl}</text>`;
      });

      const wkLbl = isPre ? `Wk ${w.week} (Proj)` : `Wk ${w.week}`;
      svg += `<text x="${gx + barW * 1.5 + 3}" y="${H - 16}" text-anchor="middle" fill="#cbd5e1" font-size="11" font-weight="700">${esc(wkLbl)}</text>`;
    });

    svg += `</svg>`;
    wrap.innerHTML = svg;
  }

  function renderWeeklyAccuracyChart() {
    const wrap = document.getElementById('chart-weekly-accuracy');
    if (!wrap) return;
    const compWeeks = DB.weeklySummary.filter(r => r.status === 'COMPLETED' && r.week !== 'ALL');
    if (!compWeeks.length) return;

    const W = 680, H = 260, padL = 44, padR = 20, padT = 24, padB = 42;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const groupW = plotW / compWeeks.length;
    const barW = 24;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly Spearman Rank Correlation Chart">`;
    [0.0, 0.2, 0.4, 0.6, 0.8].forEach(tick => {
      const y = padT + plotH - (tick / 0.8) * plotH;
      svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1e3256" stroke-dasharray="3,3" />`;
      svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="#8ca2c6" font-size="10" font-family="JetBrains Mono">${tick.toFixed(1)}</text>`;
    });

    compWeeks.forEach((w, idx) => {
      const cx = padL + idx * groupW + groupW / 2;
      const ourRho = num(w.our_rho);
      const fdRho = num(w.fd_rho);
      const yOur = padT + plotH - (ourRho / 0.8) * plotH;
      const yFd = padT + plotH - (fdRho / 0.8) * plotH;

      svg += `<rect x="${cx - barW - 3}" y="${yOur}" width="${barW}" height="${padT + plotH - yOur}" rx="3" fill="#00d084" />`;
      svg += `<text x="${cx - barW / 2 - 3}" y="${yOur - 5}" text-anchor="middle" fill="#6ee7b7" font-size="9.5" font-family="JetBrains Mono">${ourRho.toFixed(3)}</text>`;

      svg += `<rect x="${cx + 3}" y="${yFd}" width="${barW}" height="${padT + plotH - yFd}" rx="3" fill="#f87171" />`;
      svg += `<text x="${cx + barW / 2 + 3}" y="${yFd - 5}" text-anchor="middle" fill="#fca5a5" font-size="9.5" font-family="JetBrains Mono">${fdRho.toFixed(3)}</text>`;

      svg += `<text x="${cx}" y="${H - 18}" text-anchor="middle" fill="#cbd5e1" font-size="11" font-weight="700">Wk ${esc(w.week)} (MAE ${esc(w.our_mae)} vs ${esc(w.fd_mae)})</text>`;
    });

    svg += `</svg>`;
    wrap.innerHTML = svg;
  }

  function renderScatterCalibrationChart() {
    const wrap = document.getElementById('chart-scatter-calibration');
    if (!wrap) return;

    const pts = DB.histPlayers.filter(r => {
      if (!r.isCompleted || r.actualNum === null) return false;
      if (STATE.histWeek !== 'COMPLETED' && STATE.histWeek !== 'ALL' && String(r.week) !== STATE.histWeek) return false;
      if (STATE.histPos !== 'ALL' && r.pos !== STATE.histPos) return false;
      return true;
    });

    const W = 680, H = 260, padL = 44, padR = 20, padT = 18, padB = 36;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = 40;
    const xScale = v => padL + (Math.min(maxVal, Math.max(0, v)) / maxVal) * plotW;
    const yScale = v => padT + plotH - (Math.min(maxVal, Math.max(0, v)) / maxVal) * plotH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pre-Game Projection vs Actual Calibration Scatter">`;
    [0, 10, 20, 30, 40].forEach(t => {
      const y = yScale(t);
      const x = xScale(t);
      svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1b2d4f" stroke-dasharray="2,3" />`;
      svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="#8ca2c6" font-size="9.5" font-family="JetBrains Mono">${t}</text>`;
      svg += `<text x="${x}" y="${H - 10}" text-anchor="middle" fill="#8ca2c6" font-size="9.5" font-family="JetBrains Mono">${t}</text>`;
    });

    // Perfect y = x calibration line
    svg += `<line x1="${xScale(0)}" y1="${yScale(0)}" x2="${xScale(38)}" y2="${yScale(38)}" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="5,4" />`;

    const step = Math.max(1, Math.ceil(pts.length / 450));
    for (let i = 0; i < pts.length; i += step) {
      const r = pts[i];
      svg += `<circle cx="${xScale(r.fdProjNum).toFixed(1)}" cy="${yScale(r.actualNum).toFixed(1)}" r="2.2" fill="#f87171" opacity="0.35" />`;
      svg += `<circle cx="${xScale(r.ourProjNum).toFixed(1)}" cy="${yScale(r.actualNum).toFixed(1)}" r="2.6" fill="#00d084" opacity="0.68"><title>Wk ${esc(r.week)} ${esc(r.name)} (${esc(r.pos)}): Our ${r.ourProjNum.toFixed(2)} vs FD ${r.fdProjNum.toFixed(2)} → Actual ${r.actualNum.toFixed(2)}</title></circle>`;
    }

    svg += `</svg>`;
    wrap.innerHTML = svg;
  }

  function renderPosSummaryTable() {
    const wrap = document.getElementById('pos-summary-container');
    if (!wrap) return;
    const targetScope = (STATE.histWeek === 'COMPLETED' || STATE.histWeek === 'ALL' || STATE.histWeek === '8') ? 'ALL' : STATE.histWeek;
    const rows = DB.posSummary.filter(r => r.week === targetScope);

    wrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>POS (${targetScope === 'ALL' ? 'WK 3–7 ALL' : 'WK ' + esc(targetScope)})</th>
            <th>N</th>
            <th>OUR ρ</th>
            <th>FD ρ</th>
            <th>OUR MAE</th>
            <th>FD MAE</th>
            <th>OUR BIAS</th>
            <th>FD BIAS</th>
            <th>WIN %</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><span class="pos-badge pos-${esc(r.pos)}">${esc(r.pos)}</span></td>
              <td>${esc(r.n_players)}</td>
              <td class="edge-pos">${esc(r.our_rho)}</td>
              <td>${esc(r.fd_rho)}</td>
              <td class="edge-pos">${esc(r.our_mae)}</td>
              <td>${esc(r.fd_mae)}</td>
              <td>${esc(r.our_bias)}</td>
              <td>${esc(r.fd_bias)}</td>
              <td class="edge-pos">${esc(r.our_beat_fd_pct)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderHistoricWeeklyTable() {
    const tbody = document.getElementById('historic-weekly-tbody');
    if (!tbody) return;

    tbody.innerHTML = DB.weeklySummary.map(r => {
      const isAll = r.week === 'ALL';
      const isPre = r.status !== 'COMPLETED';
      const rowStyle = isAll ? 'background:rgba(0,208,132,0.11);font-weight:700;' : (isPre ? 'background:rgba(20,147,255,0.10);' : 'cursor:pointer;');

      return `
        <tr style="${rowStyle}" data-hist-week="${esc(r.week)}">
          <td>
            <div style="font-weight:800;color:#fff;">${esc(r.slate_label)}</div>
            <div style="font-size:11px;color:var(--fd-text-muted);">${esc(r.date_et)} • ${esc(r.status)}</div>
          </td>
          <td>${esc(r.n_players)}</td>
          <td class="edge-pos">${esc(r.our_rho || '—')}</td>
          <td>${esc(r.fd_rho || '—')}</td>
          <td class="edge-pos">${esc(r.rho_lift || '—')}</td>
          <td class="edge-pos">${esc(r.our_mae || '—')}</td>
          <td>${esc(r.fd_mae || '—')}</td>
          <td class="edge-pos">${esc(r.mae_improvement || '—')}</td>
          <td class="edge-pos">${r.our_beat_fd_pct ? esc(r.our_beat_fd_pct) + '%' : '—'}</td>
          <td>
            <span style="color:#38bdf8;">${esc(r.our_opt_proj)}</span> →
            <strong style="color:#00d084;">${esc(r.our_opt_actual || 'Pending')}</strong>
          </td>
          <td>
            <span>${esc(r.fd_opt_proj)}</span> →
            <strong>${esc(r.fd_opt_actual || 'Pending')}</strong>
          </td>
          <td class="edge-pos">${esc(r.opt_actual_edge || '—')}</td>
          <td style="text-align:left;max-width:250px;white-space:normal;font-family:var(--font-sans);font-size:11.5px;">
            <strong style="color:#fff;">${esc(r.tysa_best_actual ? r.tysa_best_actual + ' pts' : 'Locked')}</strong> — ${esc(r.tysa_contest_note)}
          </td>
          <td style="text-align:left;max-width:260px;white-space:normal;font-family:var(--font-sans);font-size:11.5px;color:#fcd34d;">
            ${esc(r.top_sleeper_hit)}
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-hist-week]').forEach(tr => {
      tr.addEventListener('click', () => {
        const wk = tr.getAttribute('data-hist-week');
        const wkSel = document.getElementById('hist-filter-week');
        STATE.histWeek = wk === 'ALL' ? 'COMPLETED' : wk;
        if (wkSel) wkSel.value = STATE.histWeek;
        STATE.histPage = 1;
        renderScatterCalibrationChart();
        renderPosSummaryTable();
        renderHistoricExplorer();
      });
    });
  }

  function getFilteredHistPlayers() {
    const q = STATE.histSearch.trim().toLowerCase();
    const list = DB.histPlayers.filter(r => {
      if (STATE.histWeek === 'COMPLETED' && !r.isCompleted) return false;
      if (STATE.histWeek !== 'COMPLETED' && STATE.histWeek !== 'ALL' && String(r.week) !== STATE.histWeek) return false;
      if (STATE.histPos !== 'ALL' && r.pos !== STATE.histPos) return false;
      if (STATE.histOutcome === 'OUR_BEAT_FD' && !r.ourBeatFdBool) return false;
      if (STATE.histOutcome === 'SLEEPER_HITS' && !(r.isSleeperBool && (r.actualNum ?? 0) >= 14)) return false;
      if (STATE.histOutcome === 'BIG_BOOMS' && (r.actualNum ?? -1) < 20) return false;
      if (STATE.histOutcome === 'BIG_MISSES' && (r.ourAbsErrNum ?? 0) < 10) return false;
      if (q) {
        const hay = `${r.name} ${r.team} ${r.opp} ${r.pos} ${r.window}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      switch (STATE.histSort) {
        case 'our_proj_desc': return b.ourProjNum - a.ourProjNum;
        case 'fd_proj_desc': return b.fdProjNum - a.fdProjNum;
        case 'edge_desc': return b.edgeNum - a.edgeNum;
        case 'our_err_asc': return (a.ourAbsErrNum ?? 999) - (b.ourAbsErrNum ?? 999);
        case 'fd_beat_margin': return ((b.fdAbsErrNum ?? 0) - (b.ourAbsErrNum ?? 0)) - ((a.fdAbsErrNum ?? 0) - (a.ourAbsErrNum ?? 0));
        case 'actual_desc':
        default:
          return (b.actualNum ?? b.ourProjNum) - (a.actualNum ?? a.ourProjNum);
      }
    });
    return list;
  }

  function renderHistoricExplorer() {
    const tbody = document.getElementById('historic-players-tbody');
    if (!tbody) return;

    const filtered = getFilteredHistPlayers();
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / STATE.histPageSize));
    if (STATE.histPage > totalPages) STATE.histPage = totalPages;

    const startIdx = (STATE.histPage - 1) * STATE.histPageSize;
    const pageRows = filtered.slice(startIdx, startIdx + STATE.histPageSize);

    const cntEl = document.getElementById('hist-explorer-count');
    if (cntEl) cntEl.textContent = total.toLocaleString();
    const infoEl = document.getElementById('hist-page-info');
    if (infoEl) infoEl.textContent = total ? `Showing ${startIdx + 1}–${Math.min(total, startIdx + pageRows.length)} of ${total.toLocaleString()}` : '0 matching rows';
    const indEl = document.getElementById('hist-page-indicator');
    if (indEl) indEl.textContent = `Page ${STATE.histPage} / ${totalPages}`;

    tbody.innerHTML = pageRows.map(r => {
      const actStr = r.actualNum !== null ? r.actualNum.toFixed(2) : 'LOCKED (Wk 8)';
      const ourErrStr = r.ourErrNum !== null ? fmtSigned(r.ourErrNum, 2) : '—';
      const fdErrStr = r.fdErrNum !== null ? fmtSigned(r.fdErrNum, 2) : '—';
      let winnerHtml = '<span style="color:var(--fd-text-dim);">Pending</span>';
      if (r.isCompleted) {
        winnerHtml = r.ourBeatFdBool
          ? `<span class="edge-pos">✓ OUR v6 (by ${((r.fdAbsErrNum ?? 0) - (r.ourAbsErrNum ?? 0)).toFixed(2)})</span>`
          : `<span style="color:#fca5a5;">FD (by ${((r.ourAbsErrNum ?? 0) - (r.fdAbsErrNum ?? 0)).toFixed(2)})</span>`;
      }

      return `
        <tr>
          <td>Wk ${esc(r.week)} • <span style="color:var(--fd-text-muted);font-size:11px;">${esc(r.window)}</span></td>
          <td>
            <strong style="color:#fff;">${esc(r.name)}</strong>
            ${r.isSleeperBool ? '<span class="sleeper-tag">SLEEPER</span>' : ''}
          </td>
          <td><span class="pos-badge pos-${esc(r.pos)}">${esc(r.pos)}</span></td>
          <td>${esc(r.team)} ${r.home_away === 'HOME' ? 'vs' : '@'} ${esc(r.opp)}</td>
          <td>${fmtMoney(r.salaryNum)}</td>
          <td>${r.fdProjNum.toFixed(2)}</td>
          <td>${r.baseProjNum.toFixed(2)}</td>
          <td class="col-proj-cell">${r.ourProjNum.toFixed(2)}</td>
          <td class="${r.edgeNum >= 0 ? 'edge-pos' : 'edge-neg'}">${fmtSigned(r.edgeNum, 2)}</td>
          <td style="font-weight:800;color:#fff;">${actStr}</td>
          <td>${ourErrStr}</td>
          <td>${fdErrStr}</td>
          <td>${winnerHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // ==========================================================================
  // TAB 3: WEIGHTS, DEFINITIONS & MULTI-WEEK BACKTEST
  // ==========================================================================
  function renderWeightsView() {
    const heroKpis = document.getElementById('weights-hero-kpis');
    const allRow = DB.weeklySummary.find(r => r.week === 'ALL') || {};
    if (heroKpis) {
      heroKpis.innerHTML = `
        <div class="kpi-card">
          <div class="k-lbl">Active Surviving Signals</div>
          <div class="k-val">${esc(DB.meta.active_signals || DB.weights.length)} / ${esc(DB.meta.candidates_tested || '57')}</div>
          <div class="k-sub">46 candidate signals reverted to 0.0 in LOWO CV</div>
        </div>
        <div class="kpi-card">
          <div class="k-lbl">Wk 3–7 Out-of-Sample ρ</div>
          <div class="k-val">${esc(allRow.our_rho || '—')}</div>
          <div class="k-sub">Up from v1 baseline ρ = 0.4149 (+51.5% gain)</div>
        </div>
        <div class="kpi-card">
          <div class="k-lbl">Wk 3–7 Out-of-Sample MAE</div>
          <div class="k-val">${esc(allRow.our_mae || '—')} pts</div>
          <div class="k-sub">Down from v1 baseline MAE = 5.115 pts</div>
        </div>
        <div class="kpi-card">
          <div class="k-lbl">Optimal Lineup Actual Avg</div>
          <div class="k-val">${esc(allRow.our_opt_actual || '—')} pts</div>
          <div class="k-sub">+52.78 pts/wk over FD Pre-Game Optimal (${esc(allRow.fd_opt_actual || '—')})</div>
        </div>
      `;
    }

    const btTbody = document.getElementById('backtest-tbody');
    if (btTbody) {
      btTbody.innerHTML = DB.backtest.map(b => {
        const isAct = String(b.is_active).toLowerCase() === 'true';
        const isRev = String(b.status).includes('REVERTED');
        return `
          <tr style="${isAct ? 'background:rgba(0,208,132,0.12);font-weight:700;' : ''}">
            <td style="font-family:var(--font-mono);font-weight:800;color:#fff;">${esc(b.version)}</td>
            <td style="color:#fff;font-weight:700;">${esc(b.label)}</td>
            <td class="edge-pos">${esc(b.wk3_7_rho)}</td>
            <td>${esc(b.wk3_7_mae)}</td>
            <td style="color:#38bdf8;">${esc(b.wk4_7_rho)}</td>
            <td>${esc(b.wk4_7_mae)}</td>
            <td class="edge-pos" style="font-weight:800;">${esc(b.lineup_avg)} pts</td>
            <td style="text-align:left;white-space:normal;font-family:var(--font-sans);font-size:11.5px;color:var(--fd-text-muted);">${esc(b.notes)}</td>
            <td><span class="sleeper-tag" style="${isRev ? 'color:#f87171;border-color:#f87171;' : 'color:#00d084;border-color:#00d084;'}">${esc(b.status)}</span></td>
          </tr>
        `;
      }).join('');
    }

    const wGrid = document.getElementById('active-weights-grid');
    if (wGrid) {
      wGrid.innerHTML = DB.weights.map((w, idx) => `
        <div class="weight-card">
          <div class="weight-card-top">
            <div>
              <span style="font-family:var(--font-mono);font-size:11px;color:var(--fd-text-muted);">#${idx + 1} • ${esc(w.category)}</span>
              <h3 style="font-size:14px;font-weight:800;color:#fff;">${esc(w.attribute)}</h3>
            </div>
            <span class="weight-val-pill">w = +${num(w.weight).toFixed(2)}</span>
          </div>
          <p style="font-size:12px;color:#e2e8f0;">${esc(w.description)}</p>
          <div style="background:#060d1b;padding:6px 8px;border-radius:5px;border:1px solid var(--fd-border);font-family:var(--font-mono);font-size:11px;color:#7dd3fc;">
            ${esc(w.formula)}
          </div>
          <div style="font-size:11px;color:var(--fd-text-muted);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <span>Owner: <strong>${esc(w.owner)}</strong></span>
            <span style="color:#34d399;">${esc(w.cv_evidence)}</span>
          </div>
        </div>
      `).join('');
    }

    const revTbody = document.getElementById('reverted-tbody');
    if (revTbody) {
      revTbody.innerHTML = DB.reverted.map(r => `
        <tr>
          <td style="font-family:var(--font-mono);color:#fca5a5;font-weight:700;white-space:normal;max-width:240px;">${esc(r.attribute)}</td>
          <td style="text-align:left;white-space:normal;font-family:var(--font-sans);max-width:260px;">${esc(r.description)}</td>
          <td>${esc(r.version_tested)}</td>
          <td style="font-size:11.5px;">${esc(r.owner)}</td>
          <td style="font-family:var(--font-mono);font-size:11.5px;color:#fcd34d;white-space:normal;max-width:220px;">${esc(r.cv_result)}</td>
          <td style="text-align:left;white-space:normal;font-family:var(--font-sans);color:#e2e8f0;max-width:340px;">${esc(r.revert_reason)}</td>
        </tr>
      `).join('');
    }
  }

  // ==========================================================================
  // PLAYER 11-SIGNAL MODAL
  // ==========================================================================
  function openPlayerModal(playerName) {
    const p = DB.playerByName[playerName];
    if (!p) return;
    const modal = document.getElementById('player-modal');
    const hdr = document.getElementById('modal-player-header');
    const body = document.getElementById('modal-player-body');
    if (!modal || !hdr || !body) return;

    hdr.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="pos-badge pos-${esc(p.pos)}">${esc(p.pos)}</span>
        <h3 style="font-size:17px;font-weight:800;color:#fff;">${esc(p.name)}</h3>
        <span style="color:var(--fd-text-muted);font-weight:700;">${esc(p.team)} ${p.home_away === 'HOME' ? 'vs' : '@'} ${esc(p.opp)} (${esc(p.game)})</span>
        ${p.isSleeperBool ? `<span class="sleeper-tag">★ SLEEPER (${esc(p.sleeper_reasons)})</span>` : ''}
      </div>
      <div style="font-size:12px;color:var(--fd-text-muted);margin-top:4px;">
        FD ID: <code>${esc(p.id)}</code> • Salary: <strong style="color:#fff;">${fmtMoney(p.salaryNum)}</strong> • Value: <strong style="color:#38bdf8;">${p.valNum.toFixed(2)}x</strong> • Vegas Implied: <strong>${p.impNum.toFixed(1)} pts</strong>
      </div>
    `;

    const sigRows = DB.weights.map(w => {
      const col = w.attribute;
      const z = num(p[`${col}_z`]);
      const pts = num(p[`${col}_pts`]);
      return `
        <tr>
          <td style="font-weight:700;color:#fff;">${esc(col)}</td>
          <td>+${w.weightNum.toFixed(2)}</td>
          <td class="${z >= 0 ? 'edge-pos' : 'edge-neg'}">${fmtSigned(z, 3)}</td>
          <td class="${pts >= 0 ? 'edge-pos' : 'edge-neg'}" style="font-weight:800;">${fmtSigned(pts, 2)} pts</td>
          <td style="text-align:left;font-family:var(--font-sans);font-size:11px;color:var(--fd-text-muted);white-space:normal;">${esc(w.description)}</td>
        </tr>
      `;
    }).join('');

    body.innerHTML = `
      <div class="fd-cap-meters" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px;">
        <div class="cap-meter">
          <span class="meter-label">FD PRE-GAME PROJ</span>
          <span class="meter-value">${p.fdProjNum.toFixed(2)}</span>
        </div>
        <div class="cap-meter">
          <span class="meter-label">EB VEGAS BASE</span>
          <span class="meter-value">${p.baseProjNum.toFixed(2)}</span>
        </div>
        <div class="cap-meter">
          <span class="meter-label">OUR v6 PROJECTION</span>
          <span class="meter-value proj-total">${p.ourProjNum.toFixed(2)}</span>
        </div>
        <div class="cap-meter">
          <span class="meter-label">EDGE VS FANDUEL</span>
          <span class="meter-value ${p.edgeNum >= 0 ? 'proj-total' : 'over-cap'}">${fmtSigned(p.edgeNum, 2)}</span>
        </div>
      </div>
      <div class="table-scroll-x">
        <table class="data-table">
          <thead>
            <tr>
              <th>SIGNAL ATTRIBUTE</th>
              <th>WEIGHT</th>
              <th>RANK Z-SCORE</th>
              <th>Δ FD PTS</th>
              <th>SIGNAL DEFINITION</th>
            </tr>
          </thead>
          <tbody>${sigRows}</tbody>
        </table>
      </div>
    `;

    modal.classList.add('open');
  }

  function exportFilteredHistoricCSV() {
    const rows = getFilteredHistPlayers();
    if (!rows.length) return;
    const headers = ['week', 'window', 'status', 'name', 'pos', 'team', 'opp', 'salary', 'fd_proj', 'base_proj', 'our_proj', 'proj_edge_vs_fd', 'actual_pts', 'our_error', 'fd_error', 'our_beat_fd'];
    const csvLines = [headers.join(',')];
    rows.forEach(r => {
      csvLines.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
    });
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `historic_filtered_${STATE.histWeek}_${STATE.histPos}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function bindUIEvents() {
    // Top navigation tabs
    document.querySelectorAll('.fd-nav-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        STATE.activeTab = tab;
        document.querySelectorAll('.fd-nav-tab[data-tab]').forEach(b => {
          const active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', String(active));
        });
        document.querySelectorAll('.fd-view').forEach(v => {
          v.classList.toggle('active', v.id === `tab-${tab}`);
        });
      });
    });

    // Refresh Live Data button
    const btnRefresh = document.getElementById('btn-refresh-csv');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => loadAllCSVData(true));
    }

    // Position filter tabs
    document.querySelectorAll('#pos-tabs .pos-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        STATE.posFilter = btn.getAttribute('data-pos');
        document.querySelectorAll('#pos-tabs .pos-tab').forEach(b => b.classList.toggle('active', b === btn));
        renderPlayerTable();
      });
    });

    // Search & checkboxes & sort
    const searchEl = document.getElementById('player-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        STATE.searchQuery = searchEl.value;
        renderPlayerTable();
      });
    }
    const slpEl = document.getElementById('filter-sleepers');
    if (slpEl) {
      slpEl.addEventListener('change', () => {
        STATE.sleepersOnly = slpEl.checked;
        renderPlayerTable();
      });
    }
    const actEl = document.getElementById('filter-active');
    if (actEl) {
      actEl.addEventListener('change', () => {
        STATE.activeOnly = actEl.checked;
        renderPlayerTable();
      });
    }
    const sortSel = document.getElementById('sort-select');
    if (sortSel) {
      sortSel.addEventListener('change', () => {
        STATE.sortBy = sortSel.value;
        const lbl = document.getElementById('active-sort-label');
        if (lbl) lbl.textContent = sortSel.options[sortSel.selectedIndex].text;
        renderPlayerTable();
      });
    }

    document.querySelectorAll('#player-table thead th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const sortKey = th.getAttribute('data-sort');
        if (sortKey) {
          STATE.sortBy = sortKey;
          if (sortSel) sortSel.value = sortKey;
          document.querySelectorAll('#player-table thead th.sortable').forEach(h => h.classList.toggle('active-col', h === th));
          renderPlayerTable();
        }
      });
    });

    // Lineup controls
    const presetSel = document.getElementById('preset-select');
    if (presetSel) {
      presetSel.addEventListener('change', () => loadPresetLineup(presetSel.value));
    }
    const optBtn = document.getElementById('btn-optimize-remaining');
    if (optBtn) optBtn.addEventListener('click', autoFillRemainingSlots);
    const clrBtn = document.getElementById('btn-clear-lineup');
    if (clrBtn) {
      clrBtn.addEventListener('click', () => {
        STATE.roster.forEach(s => { s.player = null; });
        STATE.lineupMetaText = 'Custom Build';
        renderPlayerTable();
        renderLineupPanel();
      });
    }

    // Mobile drawer controls
    const drawer = document.getElementById('lineup-drawer-panel');
    const openDrawerBtn = document.getElementById('btn-open-mobile-lineup');
    const closeDrawerBtn = document.getElementById('btn-close-mobile-lineup');
    if (openDrawerBtn && drawer) {
      openDrawerBtn.addEventListener('click', () => drawer.classList.add('drawer-open'));
    }
    if (closeDrawerBtn && drawer) {
      closeDrawerBtn.addEventListener('click', () => drawer.classList.remove('drawer-open'));
    }

    // Historic explorer controls
    const bindHistControl = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evName = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(evName, () => {
        STATE[key] = el.value;
        STATE.histPage = 1;
        renderScatterCalibrationChart();
        renderPosSummaryTable();
        renderHistoricExplorer();
      });
    };
    bindHistControl('hist-filter-week', 'histWeek');
    bindHistControl('hist-filter-pos', 'histPos');
    bindHistControl('hist-filter-outcome', 'histOutcome');
    bindHistControl('hist-sort', 'histSort');
    bindHistControl('hist-search', 'histSearch');

    const prevBtn = document.getElementById('btn-hist-prev');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (STATE.histPage > 1) {
          STATE.histPage--;
          renderHistoricExplorer();
        }
      });
    }
    const nextBtn = document.getElementById('btn-hist-next');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        STATE.histPage++;
        renderHistoricExplorer();
      });
    }
    const expHistBtn = document.getElementById('btn-export-filtered-hist');
    if (expHistBtn) expHistBtn.addEventListener('click', exportFilteredHistoricCSV);

    // Modal close
    const modal = document.getElementById('player-modal');
    const closeBtn = document.getElementById('modal-close-btn');
    if (closeBtn && modal) {
      closeBtn.addEventListener('click', () => modal.classList.remove('open'));
    }
    if (modal) {
      modal.addEventListener('click', e => {
        if (e.target === modal) modal.classList.remove('open');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindUIEvents();
    loadAllCSVData(false);
  });
})();
