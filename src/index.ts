export interface Env {
  ANALYTICS_DB: D1Database;
  STATS_SECRET: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ACTIVE_WINDOW_DAYS = 30;
const HISTORY_DAYS = 90;
// Pacific offset: UTC-7 (PDT). Adjust to -8 during PST if needed.
const PACIFIC_OFFSET_HOURS = -7;

function pacificDateString(date: Date = new Date()): string {
  const pacific = new Date(date.getTime() + PACIFIC_OFFSET_HOURS * 60 * 60 * 1000);
  return pacific.toISOString().slice(0, 10);
}

function checkSecret(request: Request, url: URL, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryKey = url.searchParams.get("key");
  const provided = bearerToken ?? queryKey;
  return provided === env.STATS_SECRET;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/ping") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/ping") {
      return handlePing(request, env);
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return handleStats(request, env);
    }

    if (request.method === "GET" && url.pathname === "/history") {
      return handleHistory(request, env);
    }

    if (request.method === "GET" && url.pathname === "/summary") {
      return handleSummary(request, env);
    }

    if (request.method === "POST" && url.pathname === "/auth") {
      return handleAuth(request, env);
    }

    if (request.method === "GET" && url.pathname === "/installs") {
      return handleInstalls(request, env);
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return handleDashboard();
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const windowStart = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const today = pacificDateString();

      const result = await env.ANALYTICS_DB.prepare(
        `SELECT project, COUNT(*) AS count FROM installs WHERE last_seen >= ? GROUP BY project`
      )
        .bind(windowStart)
        .all<{ project: string; count: number }>();

      for (const row of result.results) {
        await env.ANALYTICS_DB.prepare(
          `INSERT OR REPLACE INTO install_history (project, snapshot_date, count) VALUES (?, ?, ?)`
        )
          .bind(row.project, today, row.count)
          .run();
      }
    } catch {
      // cron failure must not affect /ping or /stats
    }
  },
};

async function handlePing(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS });
  }

  const { project, install_id, version, arch, timestamp } = body as {
    project?: string;
    install_id?: string;
    version?: string;
    arch?: string;
    timestamp?: string;
  };

  if (!project || !install_id || !version || !arch || !timestamp) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: project, install_id, version, arch, timestamp" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  await env.ANALYTICS_DB.prepare(
    `INSERT INTO installs (project, install_id, version, arch, last_seen, first_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, install_id) DO UPDATE SET
       version   = excluded.version,
       arch      = excluded.arch,
       last_seen = excluded.last_seen`
  )
    .bind(project, install_id, version, arch, timestamp, timestamp)
    .run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!checkSecret(request, url, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const windowStart = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const filterProject = url.searchParams.get("project");

  let rows: { project: string; count: number }[];

  if (filterProject) {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, COUNT(*) AS count FROM installs WHERE last_seen >= ? AND project = ? GROUP BY project`
    )
      .bind(windowStart, filterProject)
      .all<{ project: string; count: number }>();
    rows = result.results;
  } else {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, COUNT(*) AS count FROM installs WHERE last_seen >= ? GROUP BY project`
    )
      .bind(windowStart)
      .all<{ project: string; count: number }>();
    rows = result.results;
  }

  const projects: Record<string, number> = {};
  for (const row of rows) {
    projects[row.project] = row.count;
  }

  return new Response(
    JSON.stringify({ window_days: ACTIVE_WINDOW_DAYS, projects }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function handleHistory(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!checkSecret(request, url, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cutoff = pacificDateString(new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000));
  const filterProject = url.searchParams.get("project");

  let rows: { project: string; snapshot_date: string; count: number }[];

  if (filterProject) {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, snapshot_date, count FROM install_history
       WHERE snapshot_date >= ? AND project = ?
       ORDER BY project, snapshot_date ASC`
    )
      .bind(cutoff, filterProject)
      .all<{ project: string; snapshot_date: string; count: number }>();
    rows = result.results;
  } else {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, snapshot_date, count FROM install_history
       WHERE snapshot_date >= ?
       ORDER BY project, snapshot_date ASC`
    )
      .bind(cutoff)
      .all<{ project: string; snapshot_date: string; count: number }>();
    rows = result.results;
  }

  const history: Record<string, { date: string; count: number }[]> = {};
  for (const row of rows) {
    if (!history[row.project]) history[row.project] = [];
    history[row.project].push({ date: row.snapshot_date, count: row.count });
  }

  return new Response(JSON.stringify({ history }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleSummary(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!checkSecret(request, url, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const filterProject = url.searchParams.get("project");
  const now = Date.now();
  const activeStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleEnd = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  let activeResult: { count: number } | null;
  let totalResult: { count: number } | null;
  let staleResult: { count: number } | null;

  if (filterProject) {
    activeResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND project = ?`
    ).bind(activeStart, filterProject).first<{ count: number }>();
    totalResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE project = ?`
    ).bind(filterProject).first<{ count: number }>();
    staleResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND last_seen < ? AND project = ?`
    ).bind(staleStart, staleEnd, filterProject).first<{ count: number }>();
  } else {
    activeResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ?`
    ).bind(activeStart).first<{ count: number }>();
    totalResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs`
    ).first<{ count: number }>();
    staleResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND last_seen < ?`
    ).bind(staleStart, staleEnd).first<{ count: number }>();
  }

  return new Response(
    JSON.stringify({
      active: activeResult?.count ?? 0,
      total: totalResult?.count ?? 0,
      stale: staleResult?.count ?? 0,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function handleAuth(request: Request, env: Env): Promise<Response> {
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.password || body.password !== env.STATS_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ token: env.STATS_SECRET }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleInstalls(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!checkSecret(request, url, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const filterProject = url.searchParams.get("project");

  let rows: { project: string; version: string; arch: string; last_seen: string }[];

  if (filterProject) {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, version, arch, last_seen FROM installs WHERE project = ? ORDER BY project, last_seen DESC`
    )
      .bind(filterProject)
      .all<{ project: string; version: string; arch: string; last_seen: string }>();
    rows = result.results;
  } else {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, version, arch, last_seen FROM installs ORDER BY project, last_seen DESC`
    )
      .all<{ project: string; version: string; arch: string; last_seen: string }>();
    rows = result.results;
  }

  const installs = rows.map((row) => ({
    project: row.project,
    version: row.version,
    arch: row.arch,
    last_seen: toPacificISOString(row.last_seen),
  }));

  return new Response(JSON.stringify({ installs }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function toPacificISOString(utcString: string): string {
  const date = new Date(utcString);
  const pacific = new Date(date.getTime() + PACIFIC_OFFSET_HOURS * 60 * 60 * 1000);
  return pacific.toISOString().replace("Z", "-07:00");
}

function handleDashboard(): Response {
  const html = dashboardHtml();
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Beacon Dashboard</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body { background: #111; color: #e5e5e5; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; }

    /* Login overlay */
    #login-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.75);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center; z-index: 100;
    }
    #login-overlay.hidden { display: none; }
    #login-modal {
      background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 12px;
      padding: 2rem; width: 340px; max-width: 90vw;
    }
    #login-modal h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1.5rem; color: #fff; }
    #login-modal input[type="password"] {
      width: 100%; padding: 0.65rem 0.85rem; background: #242424; border: 1px solid #333;
      border-radius: 6px; color: #e5e5e5; font-size: 0.95rem; outline: none;
      margin-bottom: 0.75rem;
    }
    #login-modal input[type="password"]:focus { border-color: #22c55e; }
    #login-modal button {
      width: 100%; padding: 0.65rem; background: #22c55e; border: none; border-radius: 6px;
      color: #000; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    }
    #login-modal button:hover { background: #16a34a; }
    #login-error { color: #ef4444; font-size: 0.85rem; margin-top: 0.6rem; }
    #login-error.hidden { display: none; }

    /* Dashboard layout */
    #dashboard { display: none; flex-direction: column; flex: 1; min-height: 0; }
    #dashboard.visible { display: flex; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.25rem 1.5rem; border-bottom: 1px solid #222; flex-shrink: 0;
    }
    header h1 { font-size: 1.1rem; font-weight: 700; color: #22c55e; letter-spacing: 0.05em; }
    .header-controls { display: flex; gap: 0.75rem; align-items: center; }
    select {
      background: #1a1a1a; border: 1px solid #2e2e2e; color: #e5e5e5;
      padding: 0.45rem 0.75rem; border-radius: 6px; font-size: 0.875rem; cursor: pointer;
      outline: none;
    }
    select:focus { border-color: #22c55e; }

    main {
      flex: 1; min-height: 0; display: flex; flex-direction: column;
      padding: 1.25rem 1.5rem 1.5rem; max-width: 960px; width: 100%; margin: 0 auto;
    }

    /* Summary stat cards */
    .stat-cards {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1.25rem;
      margin-bottom: 1.25rem; flex-shrink: 0;
    }
    @media (max-width: 600px) { .stat-cards { grid-template-columns: 1fr; } }
    .stat-card {
      background: #1a1a1a; border: 1px solid #2e2e2e;
      border-top: 3px solid var(--accent, #e5e5e5);
      border-radius: 10px; padding: 1.1rem 1.25rem;
    }
    .stat-card-value { font-size: 2.5rem; font-weight: 700; color: var(--accent, #e5e5e5); line-height: 1; }
    .stat-card-label { font-size: 0.85rem; font-weight: 600; color: #ccc; margin-top: 0.4rem; }
    .stat-card-sub { font-size: 0.75rem; color: #666; margin-top: 0.2rem; }

    /* Distribution cards */
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; margin-bottom: 1.25rem; flex-shrink: 0; }
    @media (max-width: 540px) { .cards { grid-template-columns: 1fr; } }
    .card {
      background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 10px; padding: 1.25rem;
    }
    .card h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.07em; color: #555; margin-bottom: 1rem; }

    /* Distribution rows */
    .dist-row { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; font-size: 0.85rem; }
    .dist-label { width: 90px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ccc; flex-shrink: 0; }
    .dist-bar-wrap { flex: 1; background: #242424; border-radius: 3px; height: 6px; overflow: hidden; }
    .dist-bar { height: 100%; background: #22c55e; border-radius: 3px; transition: width 0.3s ease; }
    .dist-pct { width: 36px; text-align: right; color: #888; flex-shrink: 0; }

    /* Chart card */
    .chart-card {
      background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 10px; padding: 1.25rem;
      flex: 1; min-height: 0; display: flex; flex-direction: column;
    }
    .chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-shrink: 0; }
    .chart-header h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.07em; color: #555; }
    .chart-wrap { flex: 1; min-height: 0; position: relative; }
    canvas { display: block; }

    /* Placeholder */
    .empty { color: #555; font-size: 0.85rem; }
  </style>
</head>
<body>

<div id="login-overlay">
  <div id="login-modal">
    <h2>Beacon Dashboard</h2>
    <form id="login-form" autocomplete="off">
      <input type="password" id="password-input" placeholder="Password" autocomplete="current-password">
      <button type="submit">Sign in</button>
      <p id="login-error" class="hidden">Invalid password. Try again.</p>
    </form>
  </div>
</div>

<div id="dashboard">
  <header>
    <h1>beacon</h1>
    <div class="header-controls">
      <select id="project-select">
        <option value="">All Projects</option>
      </select>
    </div>
  </header>

  <main>
    <div class="stat-cards">
      <div class="stat-card" style="--accent:#22c55e">
        <div class="stat-card-value" id="stat-active">-</div>
        <div class="stat-card-label">Active Installs</div>
        <div class="stat-card-sub">Last 30 days</div>
      </div>
      <div class="stat-card" style="--accent:#e5e5e5">
        <div class="stat-card-value" id="stat-total">-</div>
        <div class="stat-card-label">Total All-Time</div>
        <div class="stat-card-sub">Unique installs</div>
      </div>
      <div class="stat-card" style="--accent:#f59e0b">
        <div class="stat-card-value" id="stat-stale">-</div>
        <div class="stat-card-label">Stale</div>
        <div class="stat-card-sub">No ping in 7+ days</div>
      </div>
    </div>

    <div class="cards">
      <div class="card">
        <h3>Versions</h3>
        <div id="version-list"><p class="empty">No data</p></div>
      </div>
      <div class="card">
        <h3>Architecture</h3>
        <div id="arch-list"><p class="empty">No data</p></div>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-header">
        <h3>Install History</h3>
        <select id="time-window">
          <option value="7" selected>7 days</option>
          <option value="30">30 days</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
        </select>
      </div>
      <div class="chart-wrap">
        <canvas id="history-chart"></canvas>
      </div>
    </div>
  </main>
</div>

<script>
(function () {
  var allInstalls = [];
  var allHistory = {};
  var histChart = null;

  function $(id) { return document.getElementById(id); }

  // ---- Auth ----

  var token = sessionStorage.getItem('beacon_token');
  if (token) {
    loadDashboard(token);
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = $('password-input').value;
    fetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    }).then(function (res) {
      if (!res.ok) {
        $('login-error').classList.remove('hidden');
        return;
      }
      res.json().then(function (data) {
        token = data.token;
        sessionStorage.setItem('beacon_token', token);
        $('login-error').classList.add('hidden');
        $('login-overlay').classList.add('hidden');
        $('dashboard').classList.add('visible');
        loadDashboard(token);
      });
    }).catch(function () {
      $('login-error').classList.remove('hidden');
    });
  });

  // ---- Data loading ----

  function loadDashboard(t) {
    Promise.all([
      fetch('/installs?key=' + encodeURIComponent(t)),
      fetch('/history?key=' + encodeURIComponent(t))
    ]).then(function (responses) {
      if (!responses[0].ok || !responses[1].ok) {
        sessionStorage.removeItem('beacon_token');
        $('login-overlay').classList.remove('hidden');
        $('dashboard').classList.remove('visible');
        return;
      }
      Promise.all([responses[0].json(), responses[1].json()]).then(function (data) {
        var rawRows = data[0].installs || [];
        var projectMap = {};
        rawRows.forEach(function (row) {
          var p = row.project;
          if (!projectMap[p]) projectMap[p] = { count: 0, versions: {}, archs: {} };
          projectMap[p].count++;
          projectMap[p].versions[row.version] = (projectMap[p].versions[row.version] || 0) + 1;
          projectMap[p].archs[row.arch] = (projectMap[p].archs[row.arch] || 0) + 1;
        });
        allInstalls = Object.keys(projectMap).map(function (p) {
          return { project: p, count: projectMap[p].count, versions: projectMap[p].versions, archs: projectMap[p].archs };
        });
        allHistory = data[1].history || {};

        var sel = $('project-select');
        while (sel.options.length > 1) sel.remove(1);
        allInstalls.forEach(function (inst) {
          var opt = document.createElement('option');
          opt.value = inst.project;
          opt.textContent = inst.project.charAt(0).toUpperCase() + inst.project.slice(1);
          sel.appendChild(opt);
        });

        $('login-overlay').classList.add('hidden');
        $('dashboard').classList.add('visible');
        renderDashboard(null);
      });
    }).catch(function () {
      sessionStorage.removeItem('beacon_token');
      $('login-overlay').classList.remove('hidden');
      $('dashboard').classList.remove('visible');
    });
  }

  // ---- Rendering ----

  function renderDashboard(project) {
    var summaryUrl = '/summary?key=' + encodeURIComponent(token);
    if (project) summaryUrl += '&project=' + encodeURIComponent(project);
    fetch(summaryUrl).then(function (res) {
      return res.json();
    }).then(function (data) {
      $('stat-active').textContent = (data.active || 0).toLocaleString();
      $('stat-total').textContent = (data.total || 0).toLocaleString();
      $('stat-stale').textContent = (data.stale || 0).toLocaleString();
    }).catch(function () {});

    var filtered = project
      ? allInstalls.filter(function (i) { return i.project === project; })
      : allInstalls;

    var total = filtered.reduce(function (s, i) { return s + i.count; }, 0);

    var versions = {};
    var archs = {};
    filtered.forEach(function (inst) {
      Object.keys(inst.versions).forEach(function (v) {
        versions[v] = (versions[v] || 0) + inst.versions[v];
      });
      Object.keys(inst.archs).forEach(function (a) {
        archs[a] = (archs[a] || 0) + inst.archs[a];
      });
    });

    renderDist('version-list', versions, total, true);
    renderDist('arch-list', archs, total, false);
    renderChart(project);
  }

  function semverCompare(a, b) {
    var pa = a.split('.').map(Number);
    var pb = b.split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var diff = (pb[i] || 0) - (pa[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function renderDist(containerId, dist, total, sortByVersion) {
    var el = $(containerId);
    var entries = Object.keys(dist).map(function (k) { return [k, dist[k]]; });
    if (sortByVersion) {
      entries.sort(function (a, b) { return semverCompare(a[0], b[0]); });
    } else {
      entries.sort(function (a, b) { return b[1] - a[1]; });
    }
    if (entries.length === 0) {
      el.innerHTML = '<p class="empty">No data</p>';
      return;
    }
    el.innerHTML = entries.map(function (pair) {
      var label = pair[0];
      var count = pair[1];
      var pct = total > 0 ? Math.round(count / total * 100) : 0;
      return '<div class="dist-row">' +
        '<span class="dist-label" title="' + label + '">' + label + '</span>' +
        '<div class="dist-bar-wrap"><div class="dist-bar" style="width:' + pct + '%"></div></div>' +
        '<span class="dist-pct">' + pct + '%</span>' +
        '</div>';
    }).join('');
  }

  function renderChart(project) {
    var days = parseInt($('time-window').value, 10);
    var now = new Date();
    var pacificOffset = -7 * 60;
    var dates = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(now.getTime() - i * 86400000 + pacificOffset * 60000);
      dates.push(d.toISOString().slice(0, 10));
    }
    var cutoff = dates[0];

    var countsByDate = {};
    var projects = project ? [project] : Object.keys(allHistory);
    projects.forEach(function (p) {
      var entries = allHistory[p];
      if (!entries) return;
      entries.forEach(function (e) {
        if (e.date >= cutoff) {
          countsByDate[e.date] = (countsByDate[e.date] || 0) + e.count;
        }
      });
    });

    var chartData = dates.map(function (d) {
      return countsByDate[d] !== undefined ? countsByDate[d] : null;
    });

    var wrap = document.querySelector('.chart-wrap');
    var canvas = $('history-chart');
    canvas.width = wrap.offsetWidth;
    canvas.height = wrap.offsetHeight;

    var ctx = canvas.getContext('2d');
    if (histChart) histChart.destroy();
    histChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [{
          data: chartData,
          borderColor: '#22c55e',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          fill: false,
          tension: 0.3,
          spanGaps: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a1a1a',
            borderColor: '#2e2e2e',
            borderWidth: 1,
            titleColor: '#888',
            bodyColor: '#22c55e',
            callbacks: {
              label: function (ctx) { return ' ' + (ctx.parsed.y !== null ? ctx.parsed.y : '-') + ' installs'; }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#2a2a2a' },
            ticks: { color: '#555', maxTicksLimit: 10, font: { size: 11 } }
          },
          y: {
            grid: { color: '#2a2a2a' },
            ticks: { color: '#555', font: { size: 11 } },
            beginAtZero: true
          }
        }
      }
    });
  }

  // ---- Event listeners ----

  $('project-select').addEventListener('change', function () {
    renderDashboard(this.value || null);
  });

  $('time-window').addEventListener('change', function () {
    var project = $('project-select').value || null;
    renderChart(project);
  });
})();
</script>
</body>
</html>`;
}
