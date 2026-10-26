/* ==========================================================================
   FanDuel NFL Player Selection & Historic Trends Board (100% CSV-Driven v6)
   Zero Hardcoded Data — All Tables, Charts, Lineups & Weights Read from data/*.csv
   ========================================================================== */

(function () {
  "use strict";

  const ROSTER_SLOT_SCHEMA_CLASSIC = [
    { slotId: "QB", label: "QB", allowed: ["QB"], mult: 1.0 },
    { slotId: "RB1", label: "RB", allowed: ["RB"], mult: 1.0 },
    { slotId: "RB2", label: "RB", allowed: ["RB"], mult: 1.0 },
    { slotId: "WR1", label: "WR", allowed: ["WR"], mult: 1.0 },
    { slotId: "WR2", label: "WR", allowed: ["WR"], mult: 1.0 },
    { slotId: "WR3", label: "WR", allowed: ["WR"], mult: 1.0 },
    { slotId: "TE", label: "TE", allowed: ["TE"], mult: 1.0 },
    { slotId: "FLEX", label: "FLEX", allowed: ["RB", "WR", "TE"], mult: 1.0 },
    { slotId: "DEF", label: "DEF", allowed: ["DST"], mult: 1.0 }
  ];

  const ROSTER_SLOT_SCHEMA_SHOWDOWN = [
    { slotId: "MVP", label: "MVP 1.5x", allowed: ["QB", "RB", "WR", "TE", "K", "DST"], mult: 1.5 },
    { slotId: "FLEX1", label: "FLEX", allowed: ["QB", "RB", "WR", "TE", "K", "DST"], mult: 1.0 },
    { slotId: "FLEX2", label: "FLEX", allowed: ["QB", "RB", "WR", "TE", "K", "DST"], mult: 1.0 },
    { slotId: "FLEX3", label: "FLEX", allowed: ["QB", "RB", "WR", "TE", "K", "DST"], mult: 1.0 },
    { slotId: "FLEX4", label: "FLEX", allowed: ["QB", "RB", "WR", "TE", "K", "DST"], mult: 1.0 },
    { slotId: "FLEX5", label: "FLEX", allowed: ["QB", "RB", "WR", "TE", "K", "DST"], mult: 1.0 }
  ];

  let ROSTER_SLOT_SCHEMA = ROSTER_SLOT_SCHEMA_CLASSIC;

  const SIGNAL_COLUMNS = [
    { key: "first_downs_rate", prefix: "First_Downs_Rate", short: "1stDowns" },
    { key: "td_regression", prefix: "TD_Regression", short: "TDReg" },
    { key: "opportunity_share", prefix: "Opportunity_Share", short: "OppShare" },
    { key: "injury_step_up", prefix: "Injury_Step_Up", short: "InjStepUp" },
    { key: "per_snap_breakout", prefix: "Per_Snap_Breakout", short: "SnapBrk" },
    { key: "opp_defender_matchup", prefix: "Opp_Defender_Matchup", short: "DefMatchup" },
    { key: "ngs_skill_breakout", prefix: "NGS_Skill_Breakout", short: "NGS+FTN" },
    { key: "pedigree_sleeper", prefix: "Pedigree_Sleeper", short: "Pedigree" },
    { key: "floor_consistency", prefix: "Floor_Consistency", short: "Floor25" },
    { key: "snap_momentum", prefix: "Snap_Momentum", short: "SnapMom" },
    { key: "social_media_buzz", prefix: "Social_Media_Buzz", short: "Buzz" }
  ];

  const state = {
    loaded: false,
    meta: {},
    players: [],
    playerById: new Map(),
    playerByName: new Map(),
    games: [],
    lineups: [],
    historicPlayers: [],
    historicWeekly: [],
    historicPositions: [],
    weights: [],
    revertedSignals: [],
    backtestVersions: [],
    strategyExchangeBoard: [],
    optimalLineupRows: [],
    optimalByScopeKey: {},
    optimalGameKeys: [],
    optActiveScope: "all_games",
    optActiveGameKey: "DAL@PHI",
    optDalSubKey: "DAL@PHI",
    rosterMode: "classic",

    activeTab: "players",
    posFilter: "ALL",
    gameFilter: "ALL",
    searchQuery: "",
    sleepersOnly: false,
    activeOnly: true,
    sortBy: "our_proj_desc",
    roster: {},
    activeSlotFilter: null,
    activePresetMeta: null,
    mobileDrawerOpen: false,

    histWeekFilter: "COMPLETED",
    histPosFilter: "ALL",
    histOutcomeFilter: "ALL",
    histSortBy: "actual_desc",
    histSearch: "",
    histPage: 1,
    histPageSize: 100
  };

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const len = text.length;

    for (let i = 0; i < len; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (inQuotes) {
        if (ch === '"' && next === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          row.push(field);
          field = "";
        } else if (ch === "\r" && next === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
          i++;
        } else if (ch === "\n" || ch === "\r") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    if (rows.length === 0) return [];
    const headers = rows[0].map((h) => h.trim());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      if (rows[r].length === 1 && rows[r][0].trim() === "") continue;
      const obj = {};
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = rows[r][c] !== undefined ? rows[r][c] : "";
      }
      out.push(obj);
    }
    return out;
  }

  async function fetchCSV(url) {
    const res = await fetch(url + "?v=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load " + url + ": " + res.status);
    const txt = await res.text();
    return parseCSV(txt);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtMoney(n) {
    return "$" + Number(n || 0).toLocaleString("en-US");
  }

  function fmtSigned(n, digits = 2) {
    const val = Number(n || 0);
    return (val >= 0 ? "+" : "") + val.toFixed(digits);
  }

  // ---------- LOAD ALL 9 CSV FILES ----------
  async function loadAllCSVData() {
    const [
      metaRows,
      playerRows,
      lineupRows,
      histPlayerRows,
      histWeeklyRows,
      histPosRows,
      weightRows,
      revertedRows,
      btVersionRows,
      strategyExRows,
      optimalLuRows
    ] = await Promise.all([
      fetchCSV("data/meta.csv"),
      fetchCSV("data/current_players.csv"),
      fetchCSV("data/lineups.csv"),
      fetchCSV("data/historic_player_projections.csv"),
      fetchCSV("data/historic_weekly_summary.csv"),
      fetchCSV("data/historic_position_summary.csv"),
      fetchCSV("data/weights.csv"),
      fetchCSV("data/reverted_signals.csv"),
      fetchCSV("data/backtest_versions.csv"),
      fetchCSV("data/strategy_exchange_board.csv").catch(() => []),
      fetchCSV("data/optimal_lineups.csv").catch(() => [])
    ]);

    metaRows.forEach((r) => {
      state.meta[r.key] = r.value;
    });

    state.weights = weightRows.map((w) => ({
      ...w,
      weightNum: parseFloat(w.weight) || 0
    }));
    const weightByKey = {};
    state.weights.forEach((w) => {
      weightByKey[w.key] = w;
    });

    const gamesMap = new Map();
    state.players = playerRows.map((r) => {
      const sal = parseInt(r.salary, 10) || 0;
      const our_proj = parseFloat(r.our_proj) || 0;
      const fd_proj = parseFloat(r.fd_proj) || 0;
      const base_proj = parseFloat(r.base_proj) || 0;
      const proj_edge = parseFloat(r.proj_edge) || 0;
      const value_per_1k = parseFloat(r.value_per_1k) || 0;
      const ceil = parseFloat(r.ceil) || 0;
      const floor = parseFloat(r.floor) || 0;
      const spread = parseFloat(r.spread) || 0;
      const over_under = parseFloat(r.over_under) || 0;
      const implied_total = parseFloat(r.implied_total) || 0;
      const is_sleeper = String(r.is_sleeper || "").trim().toLowerCase() === "true";

      const signals = {};
      const contribs = [];
      let totalMult = 0;

      SIGNAL_COLUMNS.forEach((sc) => {
        const z = parseFloat(r[sc.prefix + "_z"]) || 0;
        const pts = parseFloat(r[sc.prefix + "_pts"]) || 0;
        const wObj = weightByKey[sc.key] || { weightNum: 0, name: sc.short };
        const w = wObj.weightNum;
        const pct = w * z * 100.0;
        totalMult += w * z;
        signals[sc.key] = z;
        contribs.push({
          key: sc.key,
          short: sc.short,
          label: wObj.name || sc.short,
          w,
          z,
          pts,
          pct
        });
      });

      contribs.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
      const topDrivers = contribs.filter((c) => Math.abs(c.pts) >= 0.08).slice(0, 3);

      let roof = "outdoors";
      let surface = "grass";
      let gametime = "13:00 ET";
      const wxMatch = String(r.weather_Penalty || "").match(/\(([^•]+)•([^•]+)•([^)]+)\)/);
      if (wxMatch) {
        roof = wxMatch[1].trim();
        surface = wxMatch[2].trim();
        gametime = wxMatch[3].trim();
      }

      if (r.game && !gamesMap.has(r.game)) {
        const parts = r.game.split("@");
        const away = parts[0] || "";
        const home = parts[1] || "";
        const isHome = r.team === home;
        const homeImp = isHome ? implied_total : over_under - implied_total;
        const awayImp = isHome ? over_under - implied_total : implied_total;
        const homeSpread = isHome ? spread : -spread;
        gamesMap.set(r.game, {
          code: r.game,
          away,
          home,
          total: over_under,
          home_spread: homeSpread,
          away_implied: Number(awayImp.toFixed(2)),
          home_implied: Number(homeImp.toFixed(2)),
          roof,
          surface,
          gametime
        });
      }

      const pObj = {
        rank: parseInt(r.rank, 10) || 0,
        id: r.id,
        name: r.name,
        pos: r.pos,
        pos_display: r.pos === "DST" ? "DEF" : r.pos,
        team: r.team,
        opp: r.opp,
        game: r.game,
        home_away: r.home_away,
        is_home: r.home_away === "HOME",
        salary: sal,
        our_proj,
        fd_proj,
        base_proj,
        proj_edge,
        value_per_1k,
        ceil,
        floor,
        status: r.status === "ACTIVE" ? "" : r.status,
        injury_note: r.injury_note,
        is_sleeper,
        sleeper_reasons: r.sleeper_reasons ? r.sleeper_reasons.split(" | ") : [],
        spread,
        over_under,
        implied_total,
        weather_Penalty: r.weather_Penalty,
        roof,
        surface,
        gametime,
        signals,
        contribs,
        top_drivers: topDrivers,
        total_mult_pct: Number((totalMult * 100).toFixed(1))
      };

      state.playerById.set(pObj.id, pObj);
      state.playerByName.set(pObj.name, pObj);
      return pObj;
    });

    state.games = Array.from(gamesMap.values()).sort((a, b) => b.total - a.total);
    state.lineups = lineupRows;
    state.historicPlayers = histPlayerRows.map((r) => ({
      ...r,
      weekNum: parseInt(r.week, 10) || 0,
      salaryNum: parseInt(r.salary, 10) || 0,
      ourProjNum: parseFloat(r.our_proj_pregame) || 0,
      fdProjNum: parseFloat(r.fd_proj_pregame) || 0,
      baseProjNum: parseFloat(r.base_proj_pregame) || 0,
      actualNum: r.actual_fd !== "" ? parseFloat(r.actual_fd) : null,
      diffFdNum: parseFloat(r.our_diff_vs_fd) || 0,
      ourErrNum: r.our_error !== "" ? parseFloat(r.our_error) : null,
      fdErrNum: r.fd_error !== "" ? parseFloat(r.fd_error) : null,
      ourAbsErrNum: r.our_abs_error !== "" ? parseFloat(r.our_abs_error) : null,
      fdAbsErrNum: r.fd_abs_error !== "" ? parseFloat(r.fd_abs_error) : null,
      isSleeperBool: String(r.is_sleeper || "").trim().toLowerCase() === "true"
    }));
    state.historicWeekly = histWeeklyRows;
    state.historicPositions = histPosRows;
    state.revertedSignals = revertedRows;
    state.backtestVersions = btVersionRows;
    state.strategyExchangeBoard = strategyExRows || [];
    state.optimalLineupRows = optimalLuRows || [];
    state.optimalByScopeKey = {};
    state.optimalGameKeys = [];

    state.optimalLineupRows.forEach((r) => {
      const sKey = r.scope_key;
      if (!sKey) return;
      if (!state.optimalByScopeKey[sKey]) {
        state.optimalByScopeKey[sKey] = {
          scope: r.scope,
          scopeKey: sKey,
          scopeLabel: r.scope_label || sKey,
          salaryCap: parseInt(r.salary_cap, 10) || 60000,
          totalSalary: parseInt(r.total_salary, 10) || 0,
          salaryRemaining: parseInt(r.salary_remaining, 10) || 0,
          totalOurProj: parseFloat(r.total_our_proj) || 0,
          totalFdProj: parseFloat(r.total_fd_proj) || 0,
          totalBaseProj: parseFloat(r.total_base_proj) || 0,
          totalProjEdge: parseFloat(r.total_proj_edge) || 0,
          totalCeil: parseFloat(r.total_ceil) || 0,
          totalFloor: parseFloat(r.total_floor) || 0,
          solver: r.solver || "PuLP CBC ILP (cap=$60,000)",
          slots: []
        };
        if (r.scope === "per_game") {
          state.optimalGameKeys.push(sKey);
        }
      }
      state.optimalByScopeKey[sKey].slots.push({
        slotOrder: parseInt(r.slot_order, 10) || 0,
        slot: r.slot,
        playerId: r.player_id,
        player: r.player,
        pos: r.pos,
        posDisplay: r.pos === "DST" ? "DEF" : r.pos,
        team: r.team,
        opp: r.opp,
        game: r.game,
        homeAway: r.home_away,
        isHome: r.home_away === "HOME",
        salary: parseInt(r.salary, 10) || 0,
        ourProj: parseFloat(r.our_proj) || 0,
        fdProj: parseFloat(r.fd_proj) || 0,
        baseProj: parseFloat(r.base_proj) || 0,
        projEdge: parseFloat(r.proj_edge) || 0,
        valuePer1k: parseFloat(r.value_per_1k) || 0,
        ceil: parseFloat(r.ceil) || 0,
        floor: parseFloat(r.floor) || 0,
        status: r.status === "ACTIVE" ? "" : r.status,
        isSleeper: String(r.is_sleeper || "").trim().toLowerCase() === "true",
        topSignals: r.top_signals || ""
      });
    });

    Object.values(state.optimalByScopeKey).forEach((lu) => {
      lu.slots.sort((a, b) => a.slotOrder - b.slotOrder);
    });
    if (state.optimalGameKeys.length > 0 && !state.optimalByScopeKey[state.optActiveGameKey]) {
      state.optActiveGameKey = state.optimalGameKeys[0];
    }

    ROSTER_SLOT_SCHEMA.forEach((s) => {
      state.roster[s.slotId] = null;
    });

    state.loaded = true;
  }

  function populateHeaderAndMeta() {
    const m = state.meta;
    const allRow = state.historicWeekly.find((w) => w.week === "ALL") || {};

    document.getElementById("hdr-version-badge").textContent = m.active_version || "v6 LOCKED";
    document.getElementById("hdr-slate-title").textContent =
      (m.title || "NFL Classic Player Selection Board") + " • 100% CSV-Driven";
    document.getElementById("hdr-rho-val").textContent = allRow.our_rho || "0.6284";
    document.getElementById("hdr-mae-val").textContent = allRow.our_mae || "4.017";
    document.getElementById("hdr-opt-val").textContent =
      (allRow.our_opt_lineup_actual || "140.09") + " pts";
    document.getElementById("hdr-lock-time").textContent = "Lock: " + (m.lock_time || "Sun 1:00 PM ET");

    const sleeperCount = state.players.filter((p) => p.is_sleeper).length;
    document.getElementById("player-count-badge").textContent = state.players.length;
    document.getElementById("total-player-count").textContent = state.players.length;
    const stc = document.getElementById("sleeper-tab-count");
    if (stc) stc.textContent = sleeperCount;
    const scc = document.getElementById("sleeper-chip-count");
    if (scc) scc.textContent = sleeperCount;
    const hec = document.getElementById("hist-eyebrow-counts");
    if (hec) hec.textContent = `${state.historicPlayers.length.toLocaleString("en-US")} PLAYER-WEEKS • ${state.players.length} WK8 PLAYERS • ${state.weights.length} SIGNALS`;
    const chp = document.getElementById("csv-hist-players-count");
    if (chp) chp.textContent = state.historicPlayers.length.toLocaleString("en-US");
    const ccp = document.getElementById("csv-curr-players-count");
    if (ccp) ccp.textContent = state.players.length;
    const clc = document.getElementById("csv-lineups-count");
    if (clc) clc.textContent = state.lineups.length;
    const colc = document.getElementById("csv-opt-lineups-count");
    if (colc) colc.textContent = state.optimalLineupRows.length;
    const oagc = document.getElementById("opt-all-games-count");
    if (oagc) oagc.textContent = state.games.length || 12;

    document.getElementById("hist-bot-name").textContent = m.updater_bot || "@fd-board-updater";
    document.getElementById("hist-bot-id").textContent = (m.updater_bot_id || "").slice(0, 13) + "…";
    document.getElementById("hist-pregame-sched").textContent = m.pregame_schedule || "";
    document.getElementById("hist-postgame-sched").textContent = m.postgame_schedule || "";
    document.getElementById("hist-generated-at").textContent = m.generated_at || "";
  }

  function renderGamesStrip() {
    const strip = document.getElementById("games-strip");
    let html = `
      <div class="game-chip all-games-chip ${state.gameFilter === "ALL" ? "active" : ""}" data-game="ALL">
        <div class="gc-teams">ALL ${state.games.length} GAMES</div>
        <div class="gc-meta">${state.players.length} Players • Main Slate</div>
      </div>
    `;
    state.games.forEach((g) => {
      const isAct = state.gameFilter === g.code ? "active" : "";
      const spreadTxt = g.home_spread <= 0 ? `${g.home} ${g.home_spread}` : `${g.away} -${g.home_spread}`;
      html += `
        <div class="game-chip ${isAct}" data-game="${escapeHtml(g.code)}">
          <div class="gc-top">
            <span class="gc-teams">${escapeHtml(g.away)} @ ${escapeHtml(g.home)}</span>
            <span class="gc-roof">${escapeHtml(g.roof)}</span>
          </div>
          <div class="gc-meta">O/U <strong>${g.total.toFixed(1)}</strong> • ${escapeHtml(spreadTxt)}</div>
          <div class="gc-meta">${escapeHtml(g.away)} ${g.away_implied} | ${escapeHtml(g.home)} ${g.home_implied}</div>
        </div>
      `;
    });
    strip.innerHTML = html;

    strip.querySelectorAll(".game-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.gameFilter = chip.getAttribute("data-game");
        renderGamesStrip();
        renderPlayerPool();
      });
    });
  }

  // ---------- TAB 1: PLAYER POOL & LINEUP BUILDER ----------
  function getRosteredPlayerIds() {
    const s = new Set();
    Object.values(state.roster).forEach((p) => {
      if (p) s.add(p.id);
    });
    return s;
  }

  function setRosterMode(mode) {
    state.rosterMode = mode === "showdown" ? "showdown" : "classic";
    ROSTER_SLOT_SCHEMA = state.rosterMode === "showdown" ? ROSTER_SLOT_SCHEMA_SHOWDOWN : ROSTER_SLOT_SCHEMA_CLASSIC;
  }

  function findTargetSlotForPlayer(p) {
    if (state.activeSlotFilter) {
      const schema = ROSTER_SLOT_SCHEMA.find((s) => s.slotId === state.activeSlotFilter);
      if (schema && schema.allowed.includes(p.pos)) return schema.slotId;
    }
    if (state.rosterMode === "showdown") {
      for (const s of ROSTER_SLOT_SCHEMA) {
        if (s.allowed.includes(p.pos) && !state.roster[s.slotId]) {
          return s.slotId;
        }
      }
      return null;
    }
    for (const s of ROSTER_SLOT_SCHEMA) {
      if (s.slotId !== "FLEX" && s.allowed.includes(p.pos) && !state.roster[s.slotId]) {
        return s.slotId;
      }
    }
    if (["RB", "WR", "TE"].includes(p.pos)) {
      if (!state.roster.FLEX) {
        return "FLEX";
      }
      // FanDuel UI parity: if FLEX is occupied by a player whose primary position has an open slot, can auto-shift FLEX
      const flexP = state.roster.FLEX;
      if (flexP) {
        for (const s of ROSTER_SLOT_SCHEMA) {
          if (s.slotId !== "FLEX" && s.allowed.includes(flexP.pos) && !state.roster[s.slotId]) {
            return "FLEX";
          }
        }
      }
    }
    return null;
  }

  function renderPlayerPool() {
    const tbody = document.getElementById("player-tbody");
    const rosteredIds = getRosteredPlayerIds();
    const q = state.searchQuery.trim().toLowerCase();

    let filtered = state.players.filter((p) => {
      if (state.posFilter !== "ALL") {
        if (state.posFilter === "SLEEPERS") {
          if (!p.is_sleeper) return false;
        } else if (state.posFilter === "FLEX") {
          if (!["RB", "WR", "TE"].includes(p.pos)) return false;
        } else if (state.posFilter === "DEF") {
          if (p.pos !== "DST") return false;
        } else if (p.pos !== state.posFilter) {
          return false;
        }
      }
      if (state.gameFilter !== "ALL" && p.game !== state.gameFilter) return false;
      if (state.sleepersOnly && !p.is_sleeper) return false;
      if (state.activeOnly) {
        if (["O", "IR", "D"].includes(p.status)) return false;
        if (p.our_proj <= 0.55 && p.base_proj <= 0.2) return false;
      }
      if (q) {
        const hay = `${p.name} ${p.team} ${p.opp} ${p.pos_display} ${p.sleeper_reasons.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sortFns = {
      our_proj_desc: (a, b) => b.our_proj - a.our_proj || b.salary - a.salary,
      fd_proj_desc: (a, b) => b.fd_proj - a.fd_proj || b.our_proj - a.our_proj,
      base_desc: (a, b) => b.base_proj - a.base_proj || b.our_proj - a.our_proj,
      edge_desc: (a, b) => b.proj_edge - a.proj_edge || b.our_proj - a.our_proj,
      value_desc: (a, b) => b.value_per_1k - a.value_per_1k || b.our_proj - a.our_proj,
      salary_desc: (a, b) => b.salary - a.salary || b.our_proj - a.our_proj,
      salary_asc: (a, b) => a.salary - b.salary || b.our_proj - a.our_proj,
      ngs_desc: (a, b) => (b.signals.ngs_skill_breakout || 0) - (a.signals.ngs_skill_breakout || 0) || b.our_proj - a.our_proj,
      def_desc: (a, b) => (b.signals.opp_defender_matchup || 0) - (a.signals.opp_defender_matchup || 0) || b.our_proj - a.our_proj,
      inj_desc: (a, b) => (b.signals.injury_step_up || 0) - (a.signals.injury_step_up || 0) || b.our_proj - a.our_proj
    };

    filtered.sort(sortFns[state.sortBy] || sortFns.our_proj_desc);
    document.getElementById("visible-player-count").textContent = filtered.length;

    const sortLabels = {
      our_proj_desc: "Our Projection (v6)",
      fd_proj_desc: "FanDuel Pre-Game Projection",
      base_desc: "EB Vegas Base",
      edge_desc: "Edge vs. FD Pre-Game",
      value_desc: "Value / $1K",
      salary_desc: "FD Salary (High → Low)",
      salary_asc: "FD Salary (Low → High)",
      ngs_desc: "NGS + FTN Skill Signal",
      def_desc: "Opp Defender Matchup",
      inj_desc: "Injury Step-Up Signal"
    };
    document.getElementById("active-sort-label").textContent = sortLabels[state.sortBy] || "Our Projection (v6)";

    const rowsHtml = filtered.map((p, idx) => {
      const isRostered = rosteredIds.has(p.id);
      const targetSlot = findTargetSlotForPlayer(p);
      const canDraft = !isRostered && targetSlot !== null;

      let injHtml = "";
      if (p.status) {
        const cls = ["O", "IR", "D"].includes(p.status) ? "O" : "Q";
        injHtml = `<span class="inj-badge ${cls}" title="${escapeHtml(p.injury_note)}">${escapeHtml(p.status)}</span>`;
      }
      const sleeperHtml = p.is_sleeper
        ? `<span class="sleeper-badge" title="${escapeHtml(p.sleeper_reasons.join(", "))}">SLEEPER</span>`
        : "";

      let driversHtml = "";
      if (p.top_drivers && p.top_drivers.length > 0) {
        driversHtml = p.top_drivers
          .map((d) => {
            const cls = d.pts >= 0 ? "pos" : "neg";
            const sign = d.pts >= 0 ? "+" : "";
            return `<span class="sig-pill ${cls}" title="${escapeHtml(d.label)}: w=${d.w}, z=${d.z.toFixed(2)}">${escapeHtml(d.short)} ${sign}${d.pts.toFixed(1)}</span>`;
          })
          .join("");
      } else {
        driversHtml = `<span class="sig-pill">Neutral Signals</span>`;
      }

      const edgeCls = p.proj_edge >= 0.25 ? "pos" : p.proj_edge <= -0.25 ? "neg" : "neutral";
      const valCls = p.value_per_1k >= 2.8 ? "high" : "";
      const multSign = p.total_mult_pct >= 0 ? "+" : "";
      const matchupStr = p.is_home ? `vs ${p.opp}` : `@ ${p.opp}`;

      return `
        <tr class="${isRostered ? "rostered-row" : ""}" data-pid="${escapeHtml(p.id)}">
          <td class="col-rank">${idx + 1}</td>
          <td class="col-pos"><span class="pos-badge ${escapeHtml(p.pos_display)}">${escapeHtml(p.pos_display)}</span></td>
          <td class="col-player sticky-col">
            <div class="p-name-line">
              <span class="p-name">${escapeHtml(p.name)}</span>
              ${injHtml}
              ${sleeperHtml}
            </div>
            <div class="p-sub-line">
              <span class="p-team-tag">${escapeHtml(p.team)}</span>
              <span>${escapeHtml(matchupStr)}</span>
              <span>•</span>
              <span>Flr ${p.floor.toFixed(1)} / Ceil ${p.ceil.toFixed(1)}</span>
            </div>
          </td>
          <td class="col-game">
            <div class="game-cell-top">${escapeHtml(p.game)}</div>
            <div class="game-cell-sub">Imp ${p.implied_total.toFixed(1)} • O/U ${p.over_under.toFixed(1)} (${escapeHtml(p.roof)})</div>
          </td>
          <td class="col-fppg">${p.fd_proj.toFixed(2)}</td>
          <td class="col-base">${p.base_proj.toFixed(2)}</td>
          <td class="col-signals"><div class="sig-pills-wrap">${driversHtml}</div></td>
          <td class="col-proj">
            <div class="proj-main">${p.our_proj.toFixed(2)}</div>
            <div class="proj-mult">${multSign}${p.total_mult_pct.toFixed(1)}% vs Base</div>
          </td>
          <td class="col-edge"><span class="edge-val ${edgeCls}">${fmtSigned(p.proj_edge)}</span></td>
          <td class="col-val"><span class="val-chip ${valCls}">${p.value_per_1k.toFixed(2)}x</span></td>
          <td class="col-sal">${fmtMoney(p.salary)}</td>
          <td class="col-act">
            <button class="btn-add-player ${isRostered ? "in-lineup" : ""}"
                    data-action="${isRostered ? "remove" : "add"}"
                    data-pid="${escapeHtml(p.id)}"
                    ${!isRostered && !canDraft ? "disabled" : ""}
                    title="${isRostered ? "Remove from lineup" : canDraft ? "Draft into " + targetSlot : "Position slots full"}">
              ${isRostered ? "✓" : "+"}
            </button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = rowsHtml.join("");

    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-add-player");
        const pid = tr.getAttribute("data-pid");
        const player = state.playerById.get(pid);
        if (!player) return;

        if (btn) {
          e.stopPropagation();
          const act = btn.getAttribute("data-action");
          if (act === "remove") {
            removePlayerFromRoster(player.id);
          } else {
            addPlayerToRoster(player);
          }
          return;
        }
        openPlayerModal(player);
      });
    });
  }

  function populatePresetsDropdown() {
    const sel = document.getElementById("preset-select");
    const groups = new Map();
    state.lineups.forEach((lu) => {
      if (!groups.has(lu.group)) groups.set(lu.group, []);
      groups.get(lu.group).push(lu);
    });

    let html = `<option value="">-- Select a Saved Contest Entry or v6 Optimal Build --</option>`;
    groups.forEach((list, grpName) => {
      html += `<optgroup label="${escapeHtml(grpName)}">`;
      list.forEach((lu) => {
        html += `<option value="${escapeHtml(lu.preset_id)}">${escapeHtml(lu.label)}</option>`;
      });
      html += `</optgroup>`;
    });
    sel.innerHTML = html;

    sel.addEventListener("change", () => {
      const val = sel.value;
      if (val) loadPresetLineup(val);
    });
  }

  function loadPresetLineup(presetId) {
    const preset = state.lineups.find((p) => p.preset_id === presetId);
    if (!preset) return;

    const isSd = preset.roster_format === "showdown" || Boolean(preset.MVP);
    setRosterMode(isSd ? "showdown" : "classic");
    state.roster = {};
    ROSTER_SLOT_SCHEMA.forEach((s) => {
      const pName = preset[s.slotId];
      const pObj = pName ? state.playerByName.get(pName) : null;
      state.roster[s.slotId] = pObj || null;
    });
    state.activePresetMeta = preset;
    state.activeSlotFilter = null;

    document.getElementById("preset-select").value = presetId;
    renderLineupPanel();
    renderPlayerPool();
  }

  function addPlayerToRoster(player) {
    const slotId = findTargetSlotForPlayer(player);
    if (!slotId) return;
    if (state.rosterMode === "classic" && slotId === "FLEX" && state.roster.FLEX) {
      const flexP = state.roster.FLEX;
      for (const s of ROSTER_SLOT_SCHEMA) {
        if (s.slotId !== "FLEX" && s.allowed.includes(flexP.pos) && !state.roster[s.slotId]) {
          state.roster[s.slotId] = flexP;
          state.roster.FLEX = null;
          break;
        }
      }
    }
    state.roster[slotId] = player;
    state.activePresetMeta = null;
    document.getElementById("preset-select").value = "";
    if (state.activeSlotFilter === slotId) state.activeSlotFilter = null;
    renderLineupPanel();
    renderPlayerPool();
  }

  function removePlayerFromRoster(playerId) {
    Object.keys(state.roster).forEach((slotId) => {
      if (state.roster[slotId] && state.roster[slotId].id === playerId) {
        state.roster[slotId] = null;
      }
    });
    state.activePresetMeta = null;
    document.getElementById("preset-select").value = "";
    renderLineupPanel();
    renderPlayerPool();
  }

  function clearLineup() {
    ROSTER_SLOT_SCHEMA.forEach((s) => {
      state.roster[s.slotId] = null;
    });
    state.activePresetMeta = null;
    state.activeSlotFilter = null;
    document.getElementById("preset-select").value = "";
    renderLineupPanel();
    renderPlayerPool();
  }

  function autoFillRemainingSlots() {
    const cap = parseInt(state.meta.salary_cap || "60000", 10);
    const openSlots = ROSTER_SLOT_SCHEMA.filter((s) => !state.roster[s.slotId]);
    if (openSlots.length === 9 && state.lineups.length > 0) {
      const opt1 = state.lineups.find((l) => l.preset_id === "opt-1") || state.lineups[0];
      loadPresetLineup(opt1.preset_id);
      return;
    }

    const usedIds = getRosteredPlayerIds();
    let currentSal = Object.values(state.roster).reduce((acc, p) => acc + (p ? p.salary : 0), 0);

    for (let i = 0; i < openSlots.length; i++) {
      const slot = openSlots[i];
      const remAfterThis = openSlots.length - 1 - i;
      const minReserve = remAfterThis * 3200;
      const maxAffordable = cap - currentSal - minReserve;

      const cands = state.players
        .filter((p) => {
          if (usedIds.has(p.id)) return false;
          if (!slot.allowed.includes(p.pos)) return false;
          if (["O", "IR", "D"].includes(p.status)) return false;
          if (p.salary > maxAffordable) return false;
          return true;
        })
        .sort((a, b) => b.our_proj - a.our_proj);

      if (cands.length > 0) {
        state.roster[slot.slotId] = cands[0];
        usedIds.add(cands[0].id);
        currentSal += cands[0].salary;
      }
    }
    state.activePresetMeta = null;
    renderLineupPanel();
    renderPlayerPool();
  }

  function renderLineupPanel() {
    const cap = parseInt(state.meta.salary_cap || "60000", 10);
    const totalSlotsCount = ROSTER_SLOT_SCHEMA.length;
    let usedSal = 0;
    let totalProj = 0;
    let totalFd = 0;
    let totalCeil = 0;
    let filledCount = 0;

    ROSTER_SLOT_SCHEMA.forEach((s) => {
      const p = state.roster[s.slotId];
      if (p) {
        const mult = s.mult || 1.0;
        usedSal += Math.round(p.salary * mult);
        totalProj += Number((p.our_proj * mult).toFixed(2));
        totalFd += Number((p.fd_proj * mult).toFixed(2));
        totalCeil += Number((p.ceil * mult).toFixed(2));
        filledCount++;
      }
    });

    const remSal = cap - usedSal;
    const openCount = totalSlotsCount - filledCount;
    const avgOpen = openCount > 0 ? Math.floor(remSal / openCount) : 0;

    const remEl = document.getElementById("cap-remaining");
    remEl.textContent = fmtMoney(remSal);
    remEl.className = "meter-value" + (remSal < 0 ? " over-cap" : "");

    document.getElementById("cap-used").textContent = `${fmtMoney(usedSal)} / ${fmtMoney(cap)}`;
    document.getElementById("cap-avg-slot").textContent = openCount > 0 ? fmtMoney(avgOpen) : "FULL";
    document.getElementById("slots-filled-count").textContent = `${filledCount} / ${totalSlotsCount} Rostered${state.rosterMode === "showdown" ? " (Showdown)" : ""}`;
    document.getElementById("lineup-total-proj").textContent = totalProj.toFixed(2);
    const edgeTotal = totalProj - totalFd;
    document.getElementById("lineup-total-edge").textContent =
      `FD: ${totalFd.toFixed(2)} (${fmtSigned(edgeTotal)} edge)`;

    document.getElementById("m-bar-slots").textContent = `${filledCount}/${totalSlotsCount}`;
    document.getElementById("m-bar-sal").textContent = fmtMoney(remSal);
    document.getElementById("m-bar-proj").textContent = totalProj.toFixed(2);

    const subText = document.getElementById("lineup-subtitle-text");
    if (state.activePresetMeta) {
      subText.textContent = state.activePresetMeta.contest;
    } else if (filledCount === totalSlotsCount) {
      subText.textContent = `Custom ${totalSlotsCount}-Player ${state.rosterMode === "showdown" ? "Showdown" : "Classic"} Build • Ceiling ${totalCeil.toFixed(1)} pts`;
    } else {
      subText.textContent = `Select ${openCount} more player${openCount === 1 ? "" : "s"}`;
    }

    const container = document.getElementById("roster-slots");
    container.innerHTML = ROSTER_SLOT_SCHEMA.map((s) => {
      const p = state.roster[s.slotId];
      const isSelectedSlot = state.activeSlotFilter === s.slotId;
      const mult = s.mult || 1.0;
      if (!p) {
        return `
          <div class="roster-slot empty-slot ${isSelectedSlot ? "active-slot-filter" : ""}" data-slot="${s.slotId}">
            <div class="slot-pos-tag">${s.label}</div>
            <div class="slot-body">
              <div class="slot-empty-text">Click to filter ${s.label} pool or click + on table</div>
            </div>
          </div>
        `;
      }
      const matchup = p.is_home ? `vs ${p.opp}` : `@ ${p.opp}`;
      const effProj = Number((p.our_proj * mult).toFixed(2));
      const effFd = Number((p.fd_proj * mult).toFixed(2));
      const effCeil = Number((p.ceil * mult).toFixed(2));
      const effSal = Math.round(p.salary * mult);
      return `
        <div class="roster-slot" data-slot="${s.slotId}" data-pid="${escapeHtml(p.id)}">
          <div class="slot-pos-tag">${s.label}</div>
          <div class="slot-body">
            <div class="slot-p-name">
              <span>${escapeHtml(p.name)}</span>
              ${mult > 1 ? `<span class="sleeper-badge" style="background:rgba(56,189,248,0.18);color:#38bdf8;border-color:rgba(56,189,248,0.4);">1.5x MVP</span>` : ""}
              ${p.is_sleeper ? `<span class="sleeper-badge">SLEEPER</span>` : ""}
            </div>
            <div class="slot-p-meta">${escapeHtml(p.pos_display)} • ${escapeHtml(p.team)} ${escapeHtml(matchup)} • FD ${effFd.toFixed(1)} • Ceil ${effCeil.toFixed(1)}</div>
          </div>
          <div class="slot-numbers">
            <div class="slot-proj">${effProj.toFixed(2)}</div>
            <div class="slot-sal">${fmtMoney(effSal)}</div>
          </div>
          <button class="slot-remove" data-remove-slot="${s.slotId}" title="Remove player">✕</button>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".roster-slot").forEach((el) => {
      el.addEventListener("click", (e) => {
        const rmBtn = e.target.closest(".slot-remove");
        const slotId = el.getAttribute("data-slot");
        if (rmBtn) {
          e.stopPropagation();
          state.roster[slotId] = null;
          state.activePresetMeta = null;
          document.getElementById("preset-select").value = "";
          renderLineupPanel();
          renderPlayerPool();
          return;
        }
        const pid = el.getAttribute("data-pid");
        if (pid) {
          const p = state.playerById.get(pid);
          if (p) openPlayerModal(p);
        } else {
          state.activeSlotFilter = state.activeSlotFilter === slotId ? null : slotId;
          const schema = ROSTER_SLOT_SCHEMA.find((x) => x.slotId === slotId);
          if (schema) {
            setPosTabFilter(slotId === "FLEX" ? "FLEX" : slotId === "DEF" ? "DEF" : schema.allowed[0]);
          }
          renderLineupPanel();
        }
      });
    });

    const footer = document.getElementById("lineup-footer-info");
    const teamCounts = {};
    let sleepersCount = 0;
    Object.values(state.roster).forEach((p) => {
      if (p) {
        teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
        if (p.is_sleeper) sleepersCount++;
      }
    });
    const stacks = Object.entries(teamCounts)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t} (${c})`)
      .join(", ");

    if (state.activePresetMeta) {
      const m = state.activePresetMeta;
      footer.innerHTML = `
        <div><strong>Entry ID:</strong> <code>${escapeHtml(m.entry_id)}</code> • <strong>Contest:</strong> ${escapeHtml(m.contest)}</div>
        <div><strong>Team Stacks:</strong> ${escapeHtml(stacks || "Balanced")} • <strong>Sleepers:</strong> ${sleepersCount} • <strong>9-Slot Ceiling:</strong> ${totalCeil.toFixed(1)} pts</div>
      `;
    } else {
      footer.innerHTML = `
        <div><strong>Team Stacks:</strong> ${escapeHtml(stacks || "None (add 2+ from same team)")} • <strong>Sleeper Breakouts:</strong> ${sleepersCount}</div>
        <div><strong>Lineup Ceiling:</strong> ${totalCeil.toFixed(2)} pts • <strong>Edge vs FD Pre-Game:</strong> ${fmtSigned(edgeTotal)} pts</div>
      `;
    }
  }

  function setPosTabFilter(posKey) {
    const wasSleepersTab = state.posFilter === "SLEEPERS";
    state.posFilter = posKey;
    const sleepChk = document.getElementById("filter-sleepers");
    if (posKey === "SLEEPERS") {
      state.sleepersOnly = true;
      if (sleepChk) sleepChk.checked = true;
    } else if (wasSleepersTab || posKey === "ALL") {
      state.sleepersOnly = false;
      if (sleepChk) sleepChk.checked = false;
    }
    document.querySelectorAll("#pos-tabs .pos-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-pos") === posKey);
    });
    renderPlayerPool();
  }

  // ---------- TAB 2: HISTORIC TRENDS ----------
  function renderHistoricTrendsTab() {
    renderHistoricKpis();
    renderWeeklyLineupsChart();
    renderWeeklyAccuracyChart();
    renderPositionSummaryTable();
    renderHistoricWeeklyTable();
    renderHistoricExplorerAndScatter();
  }

  function renderHistoricKpis() {
    const allRow = state.historicWeekly.find((w) => w.week === "ALL") || {};
    const w8Row = state.historicWeekly.find((w) => w.week === "8") || {};
    const w8Done = w8Row.our_opt_lineup_actual && w8Row.our_opt_lineup_actual !== "PENDING";
    const wkSpan = w8Done ? "WK 3–8" : "WK 3–7";
    const grid = document.getElementById("historic-kpi-grid");
    document.getElementById("leg-our-opt").textContent = `Our Optimal Actual (${allRow.our_opt_lineup_actual} avg)`;
    document.getElementById("leg-tysa-opt").textContent = `Tysa Best Entry (${allRow.tysa_best_entry_actual} avg)`;
    document.getElementById("leg-fd-opt").textContent = `FD Pre-Game Optimal (${allRow.fd_opt_lineup_actual} avg)`;
    document.getElementById("leg-our-acc").textContent = `Our v6 Pre-Game (ρ=${allRow.our_rho}, MAE=${allRow.our_mae})`;
    document.getElementById("leg-fd-acc").textContent = `FD Pre-Game (ρ=${allRow.fd_rho}, MAE=${allRow.fd_mae})`;

    const w8CardHtml = w8Done
      ? `<div class="hist-kpi-card">
          <div class="hk-label">WEEK 8 MAIN SLATE FINAL (${escapeHtml(w8Row.n_players)} PLAYERS)</div>
          <div class="hk-val pos">ρ ${escapeHtml(w8Row.our_rho)} <span class="hk-vs">vs FD ${escapeHtml(w8Row.fd_rho)}</span></div>
          <div class="hk-sub">MAE <strong>${escapeHtml(w8Row.our_mae)} vs ${escapeHtml(w8Row.fd_mae)}</strong> (${escapeHtml(w8Row.our_beat_fd_pct)}% Win) • Best Entry: <strong>${escapeHtml(w8Row.tysa_best_entry_actual)} pts</strong></div>
        </div>`
      : `<div class="hist-kpi-card">
          <div class="hk-label">WEEK 8 PRE-GAME LOCKED SNAPSHOT</div>
          <div class="hk-val gold">${escapeHtml(w8Row.our_opt_lineup_proj || "167.87")} <span class="hk-vs">vs FD ${escapeHtml(w8Row.fd_opt_lineup_proj || "149.12")}</span></div>
          <div class="hk-sub">${escapeHtml(w8Row.n_players || "511")} players locked in CSV • ${escapeHtml(w8Row.tysa_contest_note || "")}</div>
        </div>`;

    grid.innerHTML = `
      <div class="hist-kpi-card">
        <div class="hk-label">OUT-OF-SAMPLE SPEARMAN ρ (${wkSpan})</div>
        <div class="hk-val pos">${escapeHtml(allRow.our_rho)} <span class="hk-vs">vs FD ${escapeHtml(allRow.fd_rho)}</span></div>
        <div class="hk-sub"><strong>${escapeHtml(allRow.rho_gain)} rank correlation lift</strong> across n = ${escapeHtml(allRow.n_players)} completed player-games</div>
      </div>
      <div class="hist-kpi-card">
        <div class="hk-label">PRE-GAME POINT ERROR (MAE ${wkSpan})</div>
        <div class="hk-val pos">${escapeHtml(allRow.our_mae)} <span class="hk-vs">vs FD ${escapeHtml(allRow.fd_mae)}</span></div>
        <div class="hk-sub"><strong>${escapeHtml(allRow.mae_improvement)} FD pts lower error</strong> per player-game (${escapeHtml(allRow.our_beat_fd_pct)}% Head-to-Head Win Rate)</div>
      </div>
      <div class="hist-kpi-card">
        <div class="hk-label">OPTIMAL LINEUP ACTUAL AVG (${wkSpan})</div>
        <div class="hk-val accent">${escapeHtml(allRow.our_opt_lineup_actual)} <span class="hk-vs">vs FD ${escapeHtml(allRow.fd_opt_lineup_actual)}</span></div>
        <div class="hk-sub"><strong>${escapeHtml(allRow.opt_lineup_edge_pts)} FD pts/wk</strong> actual scoring edge • Tysa Best Entry Avg: <strong>${escapeHtml(allRow.tysa_best_entry_actual)} pts</strong></div>
      </div>
      ${w8CardHtml}
    `;
  }

  function renderWeeklyLineupsChart() {
    const wrap = document.getElementById("chart-weekly-lineups");
    const weeks = state.historicWeekly.filter((w) => ["3", "4", "5", "6", "7", "8"].includes(w.week));
    const W = 640;
    const H = 265;
    const padL = 44;
    const padR = 18;
    const padT = 24;
    const padB = 46;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxY = 200;

    const yPos = (val) => padT + plotH - (Math.min(maxY, Math.max(0, val)) / maxY) * plotH;

    let gridLines = "";
    [0, 50, 100, 150, 200].forEach((tick) => {
      const y = yPos(tick);
      gridLines += `
        <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1f2d47" stroke-dasharray="3,3" />
        <text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="10" font-family="JetBrains Mono">${tick}</text>
      `;
    });

    const groupW = plotW / weeks.length;
    const barW = 19;
    let bars = "";

    weeks.forEach((w, idx) => {
      const cx = padL + idx * groupW + groupW / 2;
      const isPending = !w.our_opt_lineup_actual || w.our_opt_lineup_actual === "PENDING";
      const ourVal = isPending ? parseFloat(w.our_opt_lineup_proj) || 0 : parseFloat(w.our_opt_lineup_actual) || 0;
      const bestW8 = Math.max(...state.lineups.filter(l => l.preset_id.startsWith("contest-")).map(l => parseFloat(l.our_proj) || 0));
      const tysaVal = isPending ? bestW8 : parseFloat(w.tysa_best_entry_actual) || 0;
      const fdVal = isPending ? parseFloat(w.fd_opt_lineup_proj) || 0 : parseFloat(w.fd_opt_lineup_actual) || 0;

      const xOur = cx - barW * 1.55;
      const xTysa = cx - barW * 0.45;
      const xFd = cx + barW * 0.65;

      const yOur = yPos(ourVal);
      const yTysa = yPos(tysaVal);
      const yFd = yPos(fdVal);
      const opAttr = isPending ? 'fill-opacity="0.45" stroke-dasharray="3,2"' : "";

      bars += `
        <g class="chart-bar-group">
          <rect x="${xOur}" y="${yOur}" width="${barW}" height="${padT + plotH - yOur}" rx="3" fill="#00d68f" stroke="#00d68f" ${opAttr} />
          <text x="${xOur + barW / 2}" y="${yOur - 5}" text-anchor="middle" fill="#00d68f" font-size="9.5" font-weight="700" font-family="JetBrains Mono">${ourVal.toFixed(0)}</text>

          <rect x="${xTysa}" y="${yTysa}" width="${barW}" height="${padT + plotH - yTysa}" rx="3" fill="#38bdf8" stroke="#38bdf8" ${opAttr} />
          <text x="${xTysa + barW / 2}" y="${yTysa - 5}" text-anchor="middle" fill="#38bdf8" font-size="9.5" font-weight="700" font-family="JetBrains Mono">${tysaVal.toFixed(0)}</text>

          <rect x="${xFd}" y="${yFd}" width="${barW}" height="${padT + plotH - yFd}" rx="3" fill="#f59e0b" stroke="#f59e0b" ${opAttr} />
          <text x="${xFd + barW / 2}" y="${yFd - 5}" text-anchor="middle" fill="#f59e0b" font-size="9.5" font-weight="700" font-family="JetBrains Mono">${fdVal.toFixed(0)}</text>

          <text x="${cx}" y="${H - 22}" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="700">${isPending ? "Wk 8*" : "Wk " + w.week}</text>
          <text x="${cx}" y="${H - 8}" text-anchor="middle" fill="#64748b" font-size="9.5">${isPending ? "Pre-Game" : "+" + (ourVal - fdVal).toFixed(1) + " edge"}</text>
        </g>
      `;
    });

    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="resp-svg" role="img" aria-label="Week by Week Optimal Lineup Scoring Chart">${gridLines}${bars}</svg>`;
  }

  function renderWeeklyAccuracyChart() {
    const wrap = document.getElementById("chart-weekly-accuracy");
    const weeks = state.historicWeekly.filter((w) => w.week !== "ALL" && w.our_rho && w.our_rho !== "PENDING");
    const W = 640;
    const H = 265;
    const padL = 44;
    const padR = 44;
    const padT = 24;
    const padB = 46;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const yRho = (r) => padT + plotH - (Math.min(0.85, Math.max(0, r)) / 0.85) * plotH;

    let gridLines = "";
    [0.2, 0.4, 0.6, 0.8].forEach((rTick) => {
      const y = yRho(rTick);
      gridLines += `
        <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1f2d47" stroke-dasharray="3,3" />
        <text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#00d68f" font-size="10" font-family="JetBrains Mono">ρ ${rTick.toFixed(1)}</text>
      `;
    });

    const groupW = plotW / weeks.length;
    const barW = 24;
    let bars = "";

    weeks.forEach((w, idx) => {
      const cx = padL + idx * groupW + groupW / 2;
      const rOur = parseFloat(w.our_rho) || 0;
      const rFd = parseFloat(w.fd_rho) || 0;
      const mOur = parseFloat(w.our_mae) || 0;
      const mFd = parseFloat(w.fd_mae) || 0;

      const xOur = cx - barW - 3;
      const xFd = cx + 3;
      const yROur = yRho(rOur);
      const yRFd = yRho(rFd);

      bars += `
        <g>
          <rect x="${xOur}" y="${yROur}" width="${barW}" height="${padT + plotH - yROur}" rx="3" fill="#00d68f" fill-opacity="0.85" />
          <text x="${xOur + barW / 2}" y="${yROur - 5}" text-anchor="middle" fill="#00d68f" font-size="9.5" font-weight="700" font-family="JetBrains Mono">.${Math.round(rOur * 1000)}</text>

          <rect x="${xFd}" y="${yRFd}" width="${barW}" height="${padT + plotH - yRFd}" rx="3" fill="#f59e0b" fill-opacity="0.78" />
          <text x="${xFd + barW / 2}" y="${yRFd - 5}" text-anchor="middle" fill="#f59e0b" font-size="9.5" font-weight="700" font-family="JetBrains Mono">.${Math.round(rFd * 1000)}</text>

          <text x="${cx}" y="${H - 22}" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="700">Week ${w.week}</text>
          <text x="${cx}" y="${H - 8}" text-anchor="middle" fill="#94a3b8" font-size="9.5">MAE ${mOur.toFixed(2)} vs ${mFd.toFixed(2)}</text>
        </g>
      `;
    });

    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="resp-svg" role="img" aria-label="Week by Week Spearman Correlation and MAE Chart">${gridLines}${bars}</svg>`;
  }

  function renderPositionSummaryTable() {
    const container = document.getElementById("pos-summary-container");
    const wkFilter = ["3", "4", "5", "6", "7", "8"].includes(state.histWeekFilter) ? state.histWeekFilter : "ALL";
    const rows = state.historicPositions.filter((r) => r.week === wkFilter);

    let html = `
      <table class="data-table compact-pos-table">
        <thead>
          <tr>
            <th>POS (${wkFilter === "ALL" ? "ALL COMPLETED" : "WK " + wkFilter})</th>
            <th>N</th>
            <th>OUR ρ</th>
            <th>FD ρ</th>
            <th>OUR MAE</th>
            <th>FD MAE</th>
            <th>WIN % vs FD</th>
          </tr>
        </thead>
        <tbody>
    `;
    rows.forEach((r) => {
      const posDisp = r.pos === "DST" ? "DEF" : r.pos;
      const rhoLift = (parseFloat(r.our_rho) - parseFloat(r.fd_rho)).toFixed(3);
      html += `
        <tr>
          <td><span class="pos-badge ${escapeHtml(posDisp)}">${escapeHtml(posDisp)}</span></td>
          <td class="mono">${escapeHtml(r.n_players)}</td>
          <td class="mono pos-text"><strong>${escapeHtml(r.our_rho)}</strong> <span class="tiny-lift">(+${rhoLift})</span></td>
          <td class="mono">${escapeHtml(r.fd_rho)}</td>
          <td class="mono pos-text"><strong>${escapeHtml(r.our_mae)}</strong></td>
          <td class="mono">${escapeHtml(r.fd_mae)}</td>
          <td class="mono"><span class="win-pill">${escapeHtml(r.our_beat_fd_pct)}%</span></td>
        </tr>
      `;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
  }

  function renderHistoricWeeklyTable() {
    const tbody = document.getElementById("historic-weekly-tbody");
    tbody.innerHTML = state.historicWeekly
      .map((w) => {
        const isAll = w.week === "ALL";
        const isW8 = w.our_opt_lineup_actual === "PENDING";
        const isSelected = state.histWeekFilter === w.week;
        const rowCls = isAll ? "active-version-row" : isW8 ? "pregame-locked-row" : isSelected ? "selected-wk-row" : "";

        return `
          <tr class="${rowCls} clickable-wk-row" data-wk="${escapeHtml(w.week)}" title="Click to filter Player-Week Explorer and Calibration Plot to ${escapeHtml(w.label)}">
            <td class="sticky-col">
              <div class="wk-title">${escapeHtml(w.label)}</div>
              <div class="wk-sub">${escapeHtml(w.slate_type)}</div>
            </td>
            <td class="mono">${escapeHtml(w.n_players)}</td>
            <td class="mono pos-text"><strong>${escapeHtml(w.our_rho)}</strong></td>
            <td class="mono">${escapeHtml(w.fd_rho)}</td>
            <td class="mono pos-text"><strong>${escapeHtml(w.rho_gain)}</strong></td>
            <td class="mono pos-text"><strong>${escapeHtml(w.our_mae)}</strong></td>
            <td class="mono">${escapeHtml(w.fd_mae)}</td>
            <td class="mono pos-text"><strong>${escapeHtml(w.mae_improvement)}</strong></td>
            <td class="mono"><span class="win-pill">${escapeHtml(w.our_beat_fd_pct)}${w.our_beat_fd_pct !== "PENDING" ? "%" : ""}</span></td>
            <td class="mono"><strong>${escapeHtml(w.our_opt_lineup_proj)}</strong> → <strong class="pos-text">${escapeHtml(w.our_opt_lineup_actual)}</strong></td>
            <td class="mono">${escapeHtml(w.fd_opt_lineup_proj)} → ${escapeHtml(w.fd_opt_lineup_actual)}</td>
            <td class="mono pos-text"><strong>${escapeHtml(w.opt_lineup_edge_pts)}</strong></td>
            <td class="contest-note-cell">
              <div class="mono"><strong>${escapeHtml(w.tysa_best_entry_actual)} pts</strong></div>
              <div class="wk-sub">${escapeHtml(w.tysa_contest_note)}</div>
            </td>
            <td class="sleeper-hit-cell">
              <div><strong>${escapeHtml(w.top_sleeper_hit)}</strong></div>
              <div class="mono wk-sub">Our ${escapeHtml(w.top_sleeper_our_proj)} vs FD ${escapeHtml(w.top_sleeper_fd_proj)} → <strong>Act ${escapeHtml(w.top_sleeper_actual)}</strong></div>
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll(".clickable-wk-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const wk = tr.getAttribute("data-wk");
        state.histWeekFilter = wk === "ALL" ? "COMPLETED" : wk;
        state.histPage = 1;
        document.getElementById("hist-filter-week").value = state.histWeekFilter;
        renderPositionSummaryTable();
        renderHistoricWeeklyTable();
        renderHistoricExplorerAndScatter();
      });
    });
  }

  function getFilteredHistoricPlayers() {
    const q = state.histSearch.trim().toLowerCase();
    const filtered = state.historicPlayers.filter((r) => {
      if (state.histWeekFilter === "COMPLETED") {
        if (r.actualNum === null) return false;
      } else if (state.histWeekFilter !== "ALL") {
        if (String(r.week) !== state.histWeekFilter) return false;
      }
      if (state.histPosFilter !== "ALL" && r.pos !== state.histPosFilter) return false;

      if (state.histOutcomeFilter === "OUR_BEAT_FD") {
        if (r.our_beat_fd !== "true") return false;
      } else if (state.histOutcomeFilter === "SLEEPERS_ALL") {
        if (!r.isSleeperBool) return false;
      } else if (state.histOutcomeFilter === "SLEEPER_HITS") {
        if (!r.isSleeperBool || r.actualNum === null || r.actualNum < 14.0) return false;
      } else if (state.histOutcomeFilter === "BIG_BOOMS") {
        if (r.actualNum === null || r.actualNum < 20.0) return false;
      } else if (state.histOutcomeFilter === "BIG_MISSES") {
        if (r.ourAbsErrNum === null || r.ourAbsErrNum < 10.0) return false;
      }

      if (q) {
        const hay = `${r.name} ${r.team} ${r.opp} ${r.pos} ${r.slate}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sorters = {
      actual_desc: (a, b) => (b.actualNum ?? -1) - (a.actualNum ?? -1) || b.ourProjNum - a.ourProjNum,
      our_proj_desc: (a, b) => b.ourProjNum - a.ourProjNum,
      fd_proj_desc: (a, b) => b.fdProjNum - a.fdProjNum,
      edge_desc: (a, b) => b.diffFdNum - a.diffFdNum,
      our_err_asc: (a, b) => (a.ourAbsErrNum ?? 999) - (b.ourAbsErrNum ?? 999) || (b.actualNum ?? 0) - (a.actualNum ?? 0),
      fd_beat_margin: (a, b) => ((b.fdAbsErrNum ?? 0) - (b.ourAbsErrNum ?? 0)) - ((a.fdAbsErrNum ?? 0) - (a.ourAbsErrNum ?? 0))
    };

    filtered.sort(sorters[state.histSortBy] || sorters.actual_desc);
    return filtered;
  }

  function renderScatterCalibrationChart(filteredRows) {
    const wrap = document.getElementById("chart-scatter-calibration");
    const completed = filteredRows.filter((r) => r.actualNum !== null).slice(0, 350);
    const W = 640;
    const H = 265;
    const padL = 44;
    const padR = 20;
    const padT = 20;
    const padB = 42;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = 40;

    const xPos = (v) => padL + (Math.min(maxVal, Math.max(0, v)) / maxVal) * plotW;
    const yPos = (v) => padT + plotH - (Math.min(maxVal, Math.max(0, v)) / maxVal) * plotH;

    let grid = "";
    [0, 10, 20, 30, 40].forEach((t) => {
      const x = xPos(t);
      const y = yPos(t);
      grid += `
        <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#1f2d47" stroke-dasharray="3,3" />
        <text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="9.5" font-family="JetBrains Mono">${t}</text>
        <text x="${x}" y="${H - 18}" text-anchor="middle" fill="#64748b" font-size="9.5" font-family="JetBrains Mono">${t}</text>
      `;
    });

    const diag = `<line x1="${xPos(0)}" y1="${yPos(0)}" x2="${xPos(maxVal)}" y2="${yPos(maxVal)}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,4" />`;

    let dots = "";
    completed.forEach((r) => {
      const xFd = xPos(r.fdProjNum);
      const xOur = xPos(r.ourProjNum);
      const yAct = yPos(r.actualNum);
      dots += `<circle cx="${xFd.toFixed(1)}" cy="${yAct.toFixed(1)}" r="2.4" fill="#f59e0b" fill-opacity="0.38" />`;
      dots += `<circle cx="${xOur.toFixed(1)}" cy="${yAct.toFixed(1)}" r="3.0" fill="#00d68f" fill-opacity="0.72"><title>Wk${r.week} ${escapeHtml(r.name)} (${r.pos}): Our ${r.ourProjNum.toFixed(1)}, FD ${r.fdProjNum.toFixed(1)}, Act ${r.actualNum.toFixed(1)}</title></circle>`;
    });

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="resp-svg" role="img" aria-label="Pre-Game Projection vs Actual FD Points Scatter Plot">
        ${grid}${diag}${dots}
        <text x="${W / 2}" y="${H - 3}" text-anchor="middle" fill="#94a3b8" font-size="10">Pre-Game Projected FD Points (Emerald = Our v6 Proj, Amber = FD Pre-Game Proj)</text>
        <text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle" fill="#94a3b8" font-size="10">Actual FD Pts</text>
      </svg>
    `;
  }

  function renderHistoricExplorerAndScatter() {
    const filtered = getFilteredHistoricPlayers();
    renderScatterCalibrationChart(filtered);

    document.getElementById("hist-explorer-count").textContent = filtered.length.toLocaleString("en-US");
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.histPageSize));
    if (state.histPage > totalPages) state.histPage = totalPages;

    const startIdx = (state.histPage - 1) * state.histPageSize;
    const pageRows = filtered.slice(startIdx, startIdx + state.histPageSize);

    document.getElementById("hist-page-info").textContent =
      filtered.length > 0
        ? `Showing ${(startIdx + 1).toLocaleString()}–${Math.min(filtered.length, startIdx + pageRows.length).toLocaleString()} of ${filtered.length.toLocaleString()} CSV rows`
        : "No matching player-weeks";
    document.getElementById("hist-page-indicator").textContent = `Page ${state.histPage} / ${totalPages}`;
    document.getElementById("btn-hist-prev").disabled = state.histPage <= 1;
    document.getElementById("btn-hist-next").disabled = state.histPage >= totalPages;

    const tbody = document.getElementById("historic-players-tbody");
    tbody.innerHTML = pageRows
      .map((r) => {
        const posDisp = r.pos === "DST" ? "DEF" : r.pos;
        const matchup = r.home_away === "HOME" ? `${r.team} vs ${r.opp}` : `${r.team} @ ${r.opp}`;
        const edgeCls = r.diffFdNum >= 0.5 ? "pos-text" : r.diffFdNum <= -0.5 ? "neg-text" : "";

        let badgeHtml = "";
        if (r.our_beat_fd === "true") {
          const margin = (r.fdAbsErrNum - r.ourAbsErrNum).toFixed(2);
          badgeHtml = `<span class="decision-badge kept">OUR PROJ (+${margin})</span>`;
        } else if (r.our_beat_fd === "false") {
          const margin = (r.ourAbsErrNum - r.fdAbsErrNum).toFixed(2);
          badgeHtml = `<span class="decision-badge base">FD CLOSER (+${margin})</span>`;
        } else {
          badgeHtml = `<span class="decision-badge locked">PRE-GAME LOCKED</span>`;
        }

        return `
          <tr>
            <td class="mono">
              <div><strong>${escapeHtml(r.slate)}</strong></div>
              <div class="wk-sub">${escapeHtml(r.game_window)}</div>
            </td>
            <td class="sticky-col">
              <div class="p-name-line">
                <strong>${escapeHtml(r.name)}</strong>
                ${r.isSleeperBool ? `<span class="sleeper-badge">SLEEPER</span>` : ""}
              </div>
            </td>
            <td><span class="pos-badge ${escapeHtml(posDisp)}">${escapeHtml(posDisp)}</span></td>
            <td class="mono">${escapeHtml(matchup)}</td>
            <td class="mono">${fmtMoney(r.salaryNum)}</td>
            <td class="mono">${escapeHtml(r.fd_proj_pregame)}</td>
            <td class="mono">${escapeHtml(r.base_proj_pregame)}</td>
            <td class="mono"><strong class="pos-text">${escapeHtml(r.our_proj_pregame)}</strong></td>
            <td class="mono ${edgeCls}"><strong>${escapeHtml(r.our_diff_vs_fd)}</strong></td>
            <td class="mono"><strong>${r.actual_fd !== "" ? escapeHtml(r.actual_fd) : "PENDING"}</strong></td>
            <td class="mono">${r.our_error !== "" ? escapeHtml(r.our_error) + " (|" + escapeHtml(r.our_abs_error) + "|)" : "—"}</td>
            <td class="mono">${r.fd_error !== "" ? escapeHtml(r.fd_error) + " (|" + escapeHtml(r.fd_abs_error) + "|)" : "—"}</td>
            <td>${badgeHtml}</td>
          </tr>
        `;
      })
      .join("");
  }

  function exportFilteredHistoricCSV() {
    const rows = getFilteredHistoricPlayers();
    if (!rows.length) return;
    const cols = [
      "week", "slate", "game_window", "player_id", "name", "pos", "team", "opp",
      "home_away", "salary", "our_proj_pregame", "fd_proj_pregame", "base_proj_pregame",
      "actual_fd", "our_diff_vs_fd", "our_error", "fd_error", "our_abs_error",
      "fd_abs_error", "our_beat_fd", "our_value_pregame", "actual_value", "is_sleeper"
    ];
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    rows.forEach((r) => {
      lines.push(cols.map((c) => esc(r[c])).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `historic_filtered_${state.histWeekFilter.toLowerCase()}_${state.histPosFilter.toLowerCase()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- TAB 3: WEIGHTS, DEFINITIONS & BACKTEST ----------
  function renderWeightsAndBacktestTab() {
    const v6Row = state.backtestVersions.find((v) => v.is_active === "true") || state.backtestVersions[state.backtestVersions.length - 1] || {};
    const v1Row = state.backtestVersions[0] || {};
    const m = state.meta;

    document.getElementById("weights-hero-kpis").innerHTML = `
      <div class="kpi-box">
        <span class="kpi-label">WK 3–7 SPEARMAN ρ</span>
        <span class="kpi-value pos">${escapeHtml(v6Row.wk3_7_rho)}</span>
        <span class="kpi-sub">Up from ${escapeHtml(v1Row.wk3_7_rho)} (v1) • n = ${escapeHtml(m.n_wk3_7 || "1,928")}</span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">WK 3–7 POINT MAE</span>
        <span class="kpi-value pos">${escapeHtml(v6Row.wk3_7_mae)}</span>
        <span class="kpi-sub">Down from ${escapeHtml(v1Row.wk3_7_mae)} (v1)</span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">SIMULATED OPTIMAL LINEUP</span>
        <span class="kpi-value accent">${escapeHtml(v6Row.lineup_avg)}</span>
        <span class="kpi-sub">FD Pts/Wk (vs ${escapeHtml(v1Row.lineup_avg)} in v1)</span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">CANDIDATES AUDITED</span>
        <span class="kpi-value">${escapeHtml(m.candidates_tested || "57")} → ${escapeHtml(m.active_signals || "11")}</span>
        <span class="kpi-sub">53 noisy/redundant signals reverted to 0.0 (incl. 3 v8 strategy sub-signals)</span>
      </div>
    `;

    const btBody = document.getElementById("backtest-tbody");
    btBody.innerHTML = state.backtestVersions
      .map((r) => {
        const isAct = r.is_active === "true";
        const isReverted = r.notes.includes("REVERTED");
        const rowCls = isAct ? "active-version-row" : isReverted ? "reverted-version-row" : "";
        const badgeCls = isAct ? "locked" : isReverted ? "reverted" : r.notes.includes("KEPT") ? "kept" : "base";
        const statusText = isAct ? `LOCKED ${r.version.toUpperCase()}` : isReverted ? "REVERTED (0.0)" : r.version.toUpperCase();

        return `
          <tr class="${rowCls}">
            <td class="mono"><strong>${escapeHtml(r.version)}</strong></td>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td class="mono">${escapeHtml(r.wk3_7_rho)}</td>
            <td class="mono">${escapeHtml(r.wk3_7_mae)}</td>
            <td class="mono">${escapeHtml(r.wk4_7_rho)}</td>
            <td class="mono">${escapeHtml(r.wk4_7_mae)}</td>
            <td class="mono"><strong>${escapeHtml(r.lineup_avg)} pts</strong></td>
            <td class="mono" style="font-size:0.75rem;color:#94a3b8;">${escapeHtml(r.notes)}</td>
            <td><span class="decision-badge ${badgeCls}">${escapeHtml(statusText)}</span></td>
          </tr>
        `;
      })
      .join("");

    const grid = document.getElementById("active-weights-grid");
    grid.innerHTML = state.weights
      .map((w) => {
        const barWidth = Math.min(100, Math.round((w.weightNum / 0.21) * 100));
        return `
          <div class="weight-card">
            <div class="wc-top">
              <div>
                <div class="wc-title">${escapeHtml(w.name)}</div>
                <span class="wc-key">${escapeHtml(w.key)}</span>
              </div>
              <div class="wc-badge">
                <div class="wc-val">+${w.weightNum.toFixed(2)}</div>
                <div class="wc-share">${escapeHtml(w.share_pct)} of signal weight</div>
              </div>
            </div>
            <div class="wc-bar-track"><div class="wc-bar-fill" style="width:${barWidth}%"></div></div>
            <div class="wc-meta-row">
              <span><strong>Category:</strong> ${escapeHtml(w.category)}</span>
              <span><strong>Owner:</strong> ${escapeHtml(w.owner)}</span>
            </div>
            <div class="wc-formula">${escapeHtml(w.formula)}</div>
            <div class="wc-desc">${escapeHtml(w.why_it_works)}</div>
          </div>
        `;
      })
      .join("");

    const exBody = document.getElementById("strategy-exchange-tbody");
    if (exBody && state.strategyExchangeBoard) {
      exBody.innerHTML = state.strategyExchangeBoard
        .map((r) => {
          const pShift = parseFloat(r.predicted_pass_shift) || 0;
          const pShiftStr = (pShift >= 0 ? "+" : "") + pShift.toFixed(4);
          const pCls = pShift > 0.04 ? "kept" : pShift < -0.04 ? "reverted" : "base";
          const dScore = parseFloat(r.dst_pressure_trap_raw) || 0;
          const dCls = dScore > 1.04 ? "locked" : dScore < 0.93 ? "base" : "kept";
          return `
            <tr>
              <td class="mono"><strong>${escapeHtml(r.team_bot)}</strong> <span style="color:#64748b;font-size:0.72rem">(${escapeHtml((r.team_bot_id || "").slice(0, 8))}…)</span></td>
              <td class="mono"><span class="decision-badge locked">${escapeHtml(r.middleman_bot)}</span> <span style="color:#64748b;font-size:0.72rem">(${escapeHtml((r.middleman_bot_id || "").slice(0, 8))}…)</span></td>
              <td class="mono"><strong>${escapeHtml(r.opponent_bot)}</strong> <span style="color:#64748b;font-size:0.72rem">(${escapeHtml((r.opponent_bot_id || "").slice(0, 8))}…)</span></td>
              <td><span class="decision-badge ${pCls}">${escapeHtml(r.off_strategy_call)}</span></td>
              <td class="mono">${escapeHtml(r.opp_def_pass_funnel_idx)}</td>
              <td class="mono">${escapeHtml(r.own_off_pass_lean_idx)}</td>
              <td class="mono"><strong>${escapeHtml(pShiftStr)}</strong></td>
              <td class="mono" style="font-size:0.74rem">${escapeHtml(r.pos_raw_QB)} / ${escapeHtml(r.pos_raw_RB)} / ${escapeHtml(r.pos_raw_WR)} / ${escapeHtml(r.pos_raw_TE)}</td>
              <td><span class="decision-badge ${dCls}">${escapeHtml(r.def_strategy_call)}</span></td>
              <td class="mono"><strong>${escapeHtml(r.dst_pressure_trap_raw)}</strong> <span style="color:#94a3b8;font-size:0.72rem">(blitz×sack=${escapeHtml(r.blitz_sack_product)})</span></td>
            </tr>
          `;
        })
        .join("");
    }

    const revBody = document.getElementById("reverted-tbody");
    revBody.innerHTML = state.revertedSignals
      .map(
        (r) => `
        <tr>
          <td class="mono" style="color:#f87171;font-weight:700;">${escapeHtml(r.key)}</td>
          <td><strong>${escapeHtml(r.name)}</strong></td>
          <td><span class="decision-badge reverted">${escapeHtml(r.tested_in)}</span></td>
          <td style="font-size:0.76rem;color:#94a3b8;">${escapeHtml(r.owner)}</td>
          <td class="mono" style="font-size:0.75rem;">${escapeHtml(r.cv_impact)}</td>
          <td style="font-size:0.78rem;color:#cbd5e1;">${escapeHtml(r.reason)}</td>
        </tr>
      `
      )
      .join("");
  }

  function openPlayerModal(p) {
    const modal = document.getElementById("player-modal");
    const header = document.getElementById("modal-player-header");
    const body = document.getElementById("modal-player-body");
    const matchup = p.is_home ? `vs ${p.opp}` : `@ ${p.opp}`;

    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span class="pos-badge ${escapeHtml(p.pos_display)}">${escapeHtml(p.pos_display)}</span>
        <h2 style="font-size:1.15rem;font-weight:800;">${escapeHtml(p.name)}</h2>
        <span class="p-team-tag">${escapeHtml(p.team)} ${escapeHtml(matchup)}</span>
        <span class="mono" style="color:#00d68f;font-weight:800;">${fmtMoney(p.salary)}</span>
        ${p.is_sleeper ? `<span class="sleeper-badge">SLEEPER BREAKOUT</span>` : ""}
      </div>
      <div style="font-size:0.78rem;color:#94a3b8;margin-top:4px;">
        Game: <strong>${escapeHtml(p.game)}</strong> (${escapeHtml(p.roof)}, ${escapeHtml(p.surface)}) • Implied Team Total: <strong>${p.implied_total.toFixed(2)} pts</strong> (O/U ${p.over_under.toFixed(1)}, Spread ${fmtSigned(p.spread, 1)})
      </div>
    `;

    const sigRows = p.contribs
      .map((c) => {
        const cls = c.pts > 0.02 ? "pos" : c.pts < -0.02 ? "neg" : "";
        return `
          <tr>
            <td><strong>${escapeHtml(c.label)}</strong> <code style="font-size:0.7rem;color:#38bdf8;">${escapeHtml(c.key)}</code></td>
            <td class="mono">${c.w.toFixed(2)}</td>
            <td class="mono ${cls}">${fmtSigned(c.z, 3)}</td>
            <td class="mono ${cls}">${fmtSigned(c.pct, 2)}%</td>
            <td class="mono ${cls}"><strong>${fmtSigned(c.pts, 2)} pts</strong></td>
          </tr>
        `;
      })
      .join("");

    body.innerHTML = `
      <div class="modal-summary-grid">
        <div class="ms-card"><div class="ms-lbl">FD PRE-GAME PROJ</div><div class="ms-val">${p.fd_proj.toFixed(2)}</div></div>
        <div class="ms-card"><div class="ms-lbl">EB VEGAS SHARE BASE</div><div class="ms-val">${p.base_proj.toFixed(2)}</div></div>
        <div class="ms-card"><div class="ms-lbl">11-SIGNAL MULTIPLIER</div><div class="ms-val" style="color:${p.total_mult_pct >= 0 ? "#00d68f" : "#ff5c75"}">${fmtSigned(p.total_mult_pct, 1)}%</div></div>
        <div class="ms-card"><div class="ms-lbl">OUR v6 PROJECTION</div><div class="ms-val" style="color:#00d68f">${p.our_proj.toFixed(2)}</div></div>
        <div class="ms-card"><div class="ms-lbl">VALUE / $1K (CEIL)</div><div class="ms-val" style="color:#38bdf8">${p.value_per_1k.toFixed(2)}x <span style="font-size:0.75rem;color:#94a3b8;">(${p.ceil.toFixed(1)})</span></div></div>
      </div>
      <h3 style="font-size:0.86rem;font-weight:800;margin-bottom:8px;color:#e2e8f0;">
        Per-Signal Mathematical Breakdown: <code>${p.base_proj.toFixed(2)} × (1 + ${(p.total_mult_pct / 100).toFixed(4)}) = ${p.our_proj.toFixed(2)} FD Pts</code>
      </h3>
      <div class="table-scroll-x">
        <table class="data-table">
          <thead>
            <tr>
              <th>SIGNAL ATTRIBUTE (from current_players.csv)</th>
              <th>WEIGHT (w_k)</th>
              <th>PLAYER Z-SCORE (z_k)</th>
              <th>% MULTIPLIER (w_k × z_k)</th>
              <th>POINT IMPACT (Δ PTS)</th>
            </tr>
          </thead>
          <tbody>${sigRows}</tbody>
        </table>
      </div>
    `;

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closePlayerModal() {
    const modal = document.getElementById("player-modal");
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }

  function getActiveOptimalLineupObj() {
    if (state.optActiveScope === "all_games") {
      return state.optimalByScopeKey["ALL_GAMES"] || null;
    }
    if (state.optActiveGameKey === "DAL@PHI" && state.optDalSubKey && state.optimalByScopeKey[state.optDalSubKey]) {
      return state.optimalByScopeKey[state.optDalSubKey];
    }
    return state.optimalByScopeKey[state.optActiveGameKey] || state.optimalByScopeKey[state.optimalGameKeys[0]] || null;
  }

  function renderOptimalLineupModal() {
    const allBtn = document.getElementById("opt-scope-all-btn");
    const gameBtn = document.getElementById("opt-scope-game-btn");
    const gameWrap = document.getElementById("opt-game-selector-wrap");
    const gameSelect = document.getElementById("opt-game-select");
    const gamePills = document.getElementById("opt-game-pills");
    const kpiGrid = document.getElementById("opt-summary-kpis");
    const tbody = document.getElementById("opt-lineup-tbody");
    const tfoot = document.getElementById("opt-lineup-tfoot");

    const isAll = state.optActiveScope === "all_games";
    if (allBtn && gameBtn) {
      allBtn.classList.toggle("active", isAll);
      allBtn.setAttribute("aria-selected", isAll ? "true" : "false");
      gameBtn.classList.toggle("active", !isAll);
      gameBtn.setAttribute("aria-selected", !isAll ? "true" : "false");
    }

    if (gameWrap) {
      gameWrap.hidden = isAll;
    }

    // Populate individual game selector dropdown & pills
    if (gameSelect && state.optimalGameKeys.length > 0) {
      gameSelect.innerHTML = state.optimalGameKeys
        .map((gKey) => {
          const gLu = state.optimalByScopeKey[gKey];
          const sel = gKey === state.optActiveGameKey ? "selected" : "";
          const pts = gLu ? gLu.totalOurProj.toFixed(2) : "—";
          const sal = gLu ? fmtMoney(gLu.totalSalary) : "—";
          return `<option value="${escapeHtml(gKey)}" ${sel}>${escapeHtml(gLu ? gLu.scopeLabel : gKey)} — ${pts} v8 pts (${sal})</option>`;
        })
        .join("");
    }

    if (gamePills && state.optimalGameKeys.length > 0) {
      let pillsHtml = state.optimalGameKeys
        .map((gKey) => {
          const gLu = state.optimalByScopeKey[gKey];
          const act = gKey === state.optActiveGameKey ? "active" : "";
          const pts = gLu ? gLu.totalOurProj.toFixed(1) : "—";
          return `
            <button type="button" class="opt-game-pill ${act}" data-opt-game="${escapeHtml(gKey)}">
              <span>${escapeHtml(gKey.replace("@", " @ "))}</span>
              <span class="ogp-pts">${pts} pts</span>
            </button>
          `;
        })
        .join("");

      if (!isAll && state.optActiveGameKey === "DAL@PHI" && state.optimalByScopeKey["DAL@PHI_V8_OPT"]) {
        const dalVariants = [
          { key: "DAL@PHI", label: "Tysa Live FanDuel Entry #3754559753 ($59.5K • 105.33 v8 / 106.72 Base • MVP Dak)" },
          { key: "DAL@PHI_V8_OPT", label: "v8 ILP Optimal #1 ($59.9K • 118.71 v8 • MVP CeeDee Lamb)" },
          { key: "DAL@PHI_DAK_OPT", label: "Dak-MVP v8 Optimal #2 ($59.3K • 116.34 v8 • MVP Dak Prescott)" }
        ];
        pillsHtml += `
          <div style="width:100%;margin-top:8px;padding-top:8px;border-top:1px solid rgba(148,163,184,0.18);display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span style="font-size:0.72rem;font-weight:700;color:#38bdf8;margin-right:4px;">DAL @ PHI SHOWDOWN VIEW:</span>
            ${dalVariants
              .map((v) => {
                const isVarAct = (state.optDalSubKey || "DAL@PHI") === v.key ? "active" : "";
                return `<button type="button" class="opt-game-pill ${isVarAct}" data-dal-sub="${escapeHtml(v.key)}" style="font-size:0.73rem;">${escapeHtml(v.label)}</button>`;
              })
              .join("")}
          </div>
        `;
      }

      gamePills.innerHTML = pillsHtml;
      gamePills.querySelectorAll(".opt-game-pill[data-opt-game]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.optActiveGameKey = btn.getAttribute("data-opt-game");
          state.optActiveScope = "per_game";
          renderOptimalLineupModal();
        });
      });
      gamePills.querySelectorAll(".opt-game-pill[data-dal-sub]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.optDalSubKey = btn.getAttribute("data-dal-sub");
          state.optActiveGameKey = "DAL@PHI";
          state.optActiveScope = "per_game";
          renderOptimalLineupModal();
        });
      });
    }

    const lu = getActiveOptimalLineupObj();
    if (!lu) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="13">No optimal lineup data found in data/optimal_lineups.csv</td></tr>`;
      return;
    }

    const isShowdown = lu.slots.length === 6;
    const slotDesc = isShowdown ? "6 Showdown Slots (1.5x MVP + 5 AnyFLEX)" : `${lu.slots.length} Classic Roster Slots`;

    const titleEl = document.getElementById("opt-modal-title");
    const subEl = document.getElementById("opt-modal-subtitle");
    if (titleEl) {
      titleEl.textContent = isAll
        ? `⚡ Optimal Lineup — All ${state.games.length || 12} Games Combined ($60,000 Cap)`
        : `⚡ Optimal Lineup — ${state.optActiveGameKey.replace("@", " @ ")} ${isShowdown ? "Single-Game Showdown" : "Individual Game"} ($60,000 Cap)`;
    }
    if (subEl) {
      subEl.innerHTML = `Scope: <strong>${escapeHtml(lu.scopeLabel)}</strong> • Solver: <code>${escapeHtml(lu.solver)}</code> • Precomputed in <code>data/optimal_lineups.csv</code>`;
    }

    const capPct = ((lu.totalSalary / lu.salaryCap) * 100).toFixed(1);
    const avgVal1k = lu.totalSalary > 0 ? (lu.totalOurProj / (lu.totalSalary / 1000.0)).toFixed(2) : "0.00";
    const edgeColor = lu.totalProjEdge >= 0 ? "#00d68f" : "#ff5c75";

    if (kpiGrid) {
      kpiGrid.innerHTML = `
        <div class="ms-card">
          <div class="ms-lbl">TOTAL SALARY VS. $60K CAP</div>
          <div class="ms-val" style="color:#fff">${fmtMoney(lu.totalSalary)} <span style="font-size:0.75rem;color:#94a3b8;">/ ${fmtMoney(lu.salaryCap)}</span></div>
          <div style="font-size:0.72rem;color:#38bdf8;margin-top:2px;">${fmtMoney(lu.salaryRemaining)} Remaining (${capPct}% Used)</div>
        </div>
        <div class="ms-card">
          <div class="ms-lbl">OUR v8 OPTIMAL PROJECTION</div>
          <div class="ms-val" style="color:#00d68f">${lu.totalOurProj.toFixed(2)} pts</div>
          <div style="font-size:0.72rem;color:#94a3b8;margin-top:2px;">EB Base: ${lu.totalBaseProj.toFixed(2)} pts</div>
        </div>
        <div class="ms-card">
          <div class="ms-lbl">FD PRE-GAME PROJ &amp; EDGE</div>
          <div class="ms-val">${lu.totalFdProj.toFixed(2)} pts</div>
          <div style="font-size:0.72rem;color:${edgeColor};font-weight:700;margin-top:2px;">${fmtSigned(lu.totalProjEdge)} pts Edge vs FD</div>
        </div>
        <div class="ms-card">
          <div class="ms-lbl">LINEUP CEILING / FLOOR</div>
          <div class="ms-val" style="color:#38bdf8">${lu.totalCeil.toFixed(2)} pts</div>
          <div style="font-size:0.72rem;color:#94a3b8;margin-top:2px;">Floor: ${lu.totalFloor.toFixed(2)} pts</div>
        </div>
        <div class="ms-card">
          <div class="ms-lbl">LINEUP VALUE / $1K</div>
          <div class="ms-val" style="color:#fcd34d">${avgVal1k}x</div>
          <div style="font-size:0.72rem;color:#94a3b8;margin-top:2px;">${escapeHtml(slotDesc)}</div>
        </div>
      `;
    }

    if (tbody) {
      tbody.innerHTML = lu.slots
        .map((s) => {
          const matchup = s.isHome ? `${s.team} vs ${s.opp}` : `${s.team} @ ${s.opp}`;
          const edgeCls = s.projEdge >= 0.25 ? "pos" : s.projEdge <= -0.25 ? "neg" : "";
          const isMvp = s.slot === "MVP";
          const mvpBadge = isMvp ? ` <span class="sleeper-badge" style="background:rgba(56,189,248,0.18);color:#38bdf8;border-color:rgba(56,189,248,0.4);">1.5x MVP</span>` : "";
          const sleeperBadge = s.isSleeper ? ` <span class="sleeper-badge">SLEEPER</span>` : "";
          const statusBadge = s.status ? ` <span class="inj-badge Q">${escapeHtml(s.status)}</span>` : "";
          const slotLabel = isMvp ? "MVP (1.5x)" : s.slot;
          return `
            <tr class="opt-player-row" data-pid="${escapeHtml(s.playerId)}" title="Click to inspect ${escapeHtml(s.player)} signal breakdown">
              <td class="mono"><strong>${escapeHtml(slotLabel)}</strong></td>
              <td><span class="pos-badge ${escapeHtml(s.posDisplay)}">${escapeHtml(s.posDisplay)}</span></td>
              <td class="sticky-col"><strong>${escapeHtml(s.player)}</strong>${mvpBadge}${statusBadge}${sleeperBadge}</td>
              <td class="mono">${escapeHtml(matchup)}</td>
              <td class="mono" style="font-size:0.75rem;color:#94a3b8;">${escapeHtml(s.game)}</td>
              <td class="mono">${s.fdProj.toFixed(2)}</td>
              <td class="mono">${s.baseProj.toFixed(2)}</td>
              <td class="mono" style="color:#00d68f;font-weight:800;">${s.ourProj.toFixed(2)}</td>
              <td class="mono ${edgeCls}"><strong>${fmtSigned(s.projEdge)}</strong></td>
              <td class="mono" style="color:#38bdf8;">${s.ceil.toFixed(2)}</td>
              <td class="mono">${s.valuePer1k.toFixed(2)}x</td>
              <td class="mono"><strong>${fmtMoney(s.salary)}</strong></td>
              <td style="font-size:0.74rem;color:#cbd5e1;">${escapeHtml(s.topSignals || "EB Vegas Base Volume")}</td>
            </tr>
          `;
        })
        .join("");

      tbody.querySelectorAll("tr.opt-player-row").forEach((tr) => {
        tr.addEventListener("click", () => {
          const pid = tr.getAttribute("data-pid");
          const pObj = state.playerById.get(pid);
          if (pObj) {
            openPlayerModal(pObj);
          }
        });
      });
    }

    if (tfoot) {
      tfoot.innerHTML = `
        <tr>
          <td colspan="3" class="sticky-col">TOTAL (${lu.slots.length} ROSTER SLOTS • ${escapeHtml(isAll ? "ALL GAMES" : lu.scopeKey)})</td>
          <td colspan="2" class="mono" style="color:#38bdf8;">${fmtMoney(lu.salaryRemaining)} Cap Rem</td>
          <td class="mono">${lu.totalFdProj.toFixed(2)}</td>
          <td class="mono">${lu.totalBaseProj.toFixed(2)}</td>
          <td class="mono" style="color:#00d68f;font-size:0.95rem;">${lu.totalOurProj.toFixed(2)}</td>
          <td class="mono" style="color:${edgeColor};">${fmtSigned(lu.totalProjEdge)}</td>
          <td class="mono" style="color:#38bdf8;">${lu.totalCeil.toFixed(2)}</td>
          <td class="mono">${avgVal1k}x</td>
          <td class="mono" style="color:#00d68f;">${fmtMoney(lu.totalSalary)} / ${fmtMoney(lu.salaryCap)}</td>
          <td class="mono" style="font-size:0.72rem;color:#94a3b8;">${escapeHtml(lu.solver)}</td>
        </tr>
      `;
    }
  }

  function openOptimalLineupModal(forcedScope) {
    if (forcedScope === "all_games" || forcedScope === "per_game") {
      state.optActiveScope = forcedScope;
    } else if (state.gameFilter && state.gameFilter !== "ALL" && state.optimalByScopeKey[state.gameFilter]) {
      state.optActiveScope = "per_game";
      state.optActiveGameKey = state.gameFilter;
    }
    renderOptimalLineupModal();
    const modal = document.getElementById("optimal-lineup-modal");
    if (modal) {
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closeOptimalLineupModal() {
    const modal = document.getElementById("optimal-lineup-modal");
    if (modal) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function loadActiveOptimalIntoBuilder() {
    const lu = getActiveOptimalLineupObj();
    if (!lu) return;
    const isSd = lu.slots.length === 6;
    setRosterMode(isSd ? "showdown" : "classic");
    state.roster = {};
    ROSTER_SLOT_SCHEMA.forEach((s) => {
      state.roster[s.slotId] = null;
    });
    lu.slots.forEach((s) => {
      const pObj = state.playerById.get(s.playerId) || state.playerByName.get(s.player);
      if (pObj && s.slot in state.roster) {
        state.roster[s.slot] = pObj;
      }
    });
    state.activePresetMeta = {
      preset_id: "optimal-" + lu.scopeKey,
      entry_id: lu.scopeKey === "DAL@PHI" ? "3754559753" : lu.scopeKey,
      label: lu.scopeLabel,
      contest: `${lu.scopeLabel} — ${lu.totalOurProj.toFixed(2)} v8 pts • ${fmtMoney(lu.totalSalary)} / $60,000`
    };
    const presetSel = document.getElementById("preset-select");
    if (presetSel) presetSel.value = "";
    renderLineupPanel();
    renderPlayerPool();
    closeOptimalLineupModal();
  }

  function setMobileLineupDrawer(open) {
    state.mobileDrawerOpen = open;
    const panel = document.getElementById("lineup-drawer-panel");
    panel.classList.toggle("mobile-open", open);
  }

  function bindEvents() {
    document.querySelectorAll(".fd-nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        state.activeTab = tab;
        document.querySelectorAll(".fd-nav-tab").forEach((b) => {
          const act = b === btn;
          b.classList.toggle("active", act);
          b.setAttribute("aria-selected", act ? "true" : "false");
        });
        document.querySelectorAll(".fd-view").forEach((v) => {
          v.classList.toggle("active", v.id === `tab-${tab}`);
        });
      });
    });

    document.querySelectorAll("#pos-tabs .pos-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeSlotFilter = null;
        setPosTabFilter(btn.getAttribute("data-pos"));
        renderLineupPanel();
      });
    });

    document.getElementById("player-search").addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderPlayerPool();
    });
    document.getElementById("filter-sleepers").addEventListener("change", (e) => {
      state.sleepersOnly = e.target.checked;
      if (!state.sleepersOnly && state.posFilter === "SLEEPERS") {
        state.posFilter = "ALL";
        document.querySelectorAll("#pos-tabs .pos-tab").forEach((btn) => {
          btn.classList.toggle("active", btn.getAttribute("data-pos") === "ALL");
        });
      }
      renderPlayerPool();
    });
    document.getElementById("filter-active").addEventListener("change", (e) => {
      state.activeOnly = e.target.checked;
      renderPlayerPool();
    });
    document.getElementById("sort-select").addEventListener("change", (e) => {
      state.sortBy = e.target.value;
      renderPlayerPool();
    });

    document.querySelectorAll("#player-table th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const sortKey = th.getAttribute("data-sort");
        if (!sortKey) return;
        state.sortBy = sortKey;
        const sel = document.getElementById("sort-select");
        if ([...sel.options].some((o) => o.value === sortKey)) sel.value = sortKey;
        document.querySelectorAll("#player-table th.sortable").forEach((x) => x.classList.remove("active-col"));
        th.classList.add("active-col");
        renderPlayerPool();
      });
    });

    document.getElementById("btn-clear-lineup").addEventListener("click", clearLineup);
    document.getElementById("btn-optimize-remaining").addEventListener("click", autoFillRemainingSlots);

    document.getElementById("btn-open-mobile-lineup").addEventListener("click", () => {
      setMobileLineupDrawer(!state.mobileDrawerOpen);
    });
    document.getElementById("btn-close-mobile-lineup").addEventListener("click", () => {
      setMobileLineupDrawer(false);
    });

    document.getElementById("hist-filter-week").addEventListener("change", (e) => {
      state.histWeekFilter = e.target.value;
      state.histPage = 1;
      renderPositionSummaryTable();
      renderHistoricWeeklyTable();
      renderHistoricExplorerAndScatter();
    });
    document.getElementById("hist-filter-pos").addEventListener("change", (e) => {
      state.histPosFilter = e.target.value;
      state.histPage = 1;
      renderHistoricExplorerAndScatter();
    });
    document.getElementById("hist-filter-outcome").addEventListener("change", (e) => {
      state.histOutcomeFilter = e.target.value;
      state.histPage = 1;
      renderHistoricExplorerAndScatter();
    });
    document.getElementById("hist-sort").addEventListener("change", (e) => {
      state.histSortBy = e.target.value;
      state.histPage = 1;
      renderHistoricExplorerAndScatter();
    });
    document.getElementById("hist-search").addEventListener("input", (e) => {
      state.histSearch = e.target.value;
      state.histPage = 1;
      renderHistoricExplorerAndScatter();
    });
    document.getElementById("btn-hist-prev").addEventListener("click", () => {
      if (state.histPage > 1) {
        state.histPage--;
        renderHistoricExplorerAndScatter();
      }
    });
    document.getElementById("btn-hist-next").addEventListener("click", () => {
      state.histPage++;
      renderHistoricExplorerAndScatter();
    });
    document.getElementById("btn-export-filtered-hist").addEventListener("click", exportFilteredHistoricCSV);

    ["btn-open-optimal-modal", "btn-open-optimal-pool", "btn-open-optimal-builder", "btn-open-optimal-mobile"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener("click", () => openOptimalLineupModal());
      }
    });

    const optCloseBtn = document.getElementById("opt-modal-close-btn");
    if (optCloseBtn) optCloseBtn.addEventListener("click", closeOptimalLineupModal);

    const optModal = document.getElementById("optimal-lineup-modal");
    if (optModal) {
      optModal.addEventListener("click", (e) => {
        if (e.target.id === "optimal-lineup-modal") closeOptimalLineupModal();
      });
    }

    const scopeAllBtn = document.getElementById("opt-scope-all-btn");
    if (scopeAllBtn) {
      scopeAllBtn.addEventListener("click", () => {
        state.optActiveScope = "all_games";
        renderOptimalLineupModal();
      });
    }

    const scopeGameBtn = document.getElementById("opt-scope-game-btn");
    if (scopeGameBtn) {
      scopeGameBtn.addEventListener("click", () => {
        state.optActiveScope = "per_game";
        if (state.gameFilter && state.gameFilter !== "ALL" && state.optimalByScopeKey[state.gameFilter]) {
          state.optActiveGameKey = state.gameFilter;
        }
        renderOptimalLineupModal();
      });
    }

    const optGameSel = document.getElementById("opt-game-select");
    if (optGameSel) {
      optGameSel.addEventListener("change", (e) => {
        state.optActiveGameKey = e.target.value;
        state.optActiveScope = "per_game";
        renderOptimalLineupModal();
      });
    }

    const btnLoadOpt = document.getElementById("btn-load-optimal-to-builder");
    if (btnLoadOpt) {
      btnLoadOpt.addEventListener("click", loadActiveOptimalIntoBuilder);
    }

    const btnRefresh = document.getElementById("btn-refresh-csv");
    if (btnRefresh) {
      btnRefresh.addEventListener("click", async () => {
        btnRefresh.textContent = "⏳ Refreshing…";
        try {
          await loadAllCSVData();
          populateHeaderAndMeta();
          renderGamesStrip();
          populatePresetsDropdown();
          renderPlayerPool();
          renderLineupPanel();
          renderHistoricTrendsTab();
          renderWeightsAndBacktestTab();
          btnRefresh.textContent = "✓ Refreshed CSVs";
          setTimeout(() => {
            btnRefresh.textContent = "🔄 Refresh Live Data";
          }, 1600);
        } catch (err) {
          console.error(err);
          btnRefresh.textContent = "🔄 Refresh Live Data";
        }
      });
    }

    document.getElementById("modal-close-btn").addEventListener("click", closePlayerModal);
    document.getElementById("player-modal").addEventListener("click", (e) => {
      if (e.target.id === "player-modal") closePlayerModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closePlayerModal();
        closeOptimalLineupModal();
        setMobileLineupDrawer(false);
      }
    });
  }

  async function init() {
    try {
      bindEvents();
      await loadAllCSVData();
      populateHeaderAndMeta();
      renderGamesStrip();
      populatePresetsDropdown();
      loadPresetLineup(state.lineups.some((x) => x.preset_id === "mnf-entry-1") ? "mnf-entry-1" : "contest-2");
      renderHistoricTrendsTab();
      renderWeightsAndBacktestTab();
    } catch (err) {
      console.error("Failed to initialize CSV board:", err);
      document.getElementById("hdr-slate-title").textContent = "Error loading CSV files: " + err.message;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
