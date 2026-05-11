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

  const { project, install_id, version, arch, timestamp, channel, container_count, os } = body as {
    project?: string;
    install_id?: string;
    version?: string;
    arch?: string;
    timestamp?: string;
    channel?: string;
    container_count?: number;
    os?: string;
  };

  if (!project || !install_id || !version || !arch || !timestamp) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: project, install_id, version, arch, timestamp" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  await env.ANALYTICS_DB.prepare(
    `INSERT INTO installs (project, install_id, version, arch, last_seen, first_seen, channel, container_count, os)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, install_id) DO UPDATE SET
       version         = excluded.version,
       arch            = excluded.arch,
       last_seen       = excluded.last_seen,
       channel         = excluded.channel,
       container_count = excluded.container_count,
       os              = excluded.os`
  )
    .bind(project, install_id, version, arch, timestamp, timestamp,
          channel ?? null, container_count ?? null, os ?? null)
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
  const pacificMidnightUtc = `${pacificDateString()}T${String(Math.abs(PACIFIC_OFFSET_HOURS)).padStart(2, "0")}:00:00.000Z`;

  let activeResult: { count: number } | null;
  let totalResult: { count: number } | null;
  let staleResult: { count: number } | null;
  let newTodayResult: { count: number } | null;

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
    newTodayResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE first_seen >= ? AND project = ?`
    ).bind(pacificMidnightUtc, filterProject).first<{ count: number }>();
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
    newTodayResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE first_seen >= ?`
    ).bind(pacificMidnightUtc).first<{ count: number }>();
  }

  return new Response(
    JSON.stringify({
      active: activeResult?.count ?? 0,
      total: totalResult?.count ?? 0,
      stale: staleResult?.count ?? 0,
      new_today: newTodayResult?.count ?? 0,
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

  type InstallRow = {
    project: string;
    install_id: string;
    version: string;
    arch: string;
    last_seen: string;
    first_seen: string | null;
    channel: string | null;
    container_count: number | null;
    os: string | null;
  };

  let rows: InstallRow[];

  if (filterProject) {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, install_id, version, arch, last_seen, first_seen, channel, container_count, os
       FROM installs WHERE project = ? ORDER BY project, last_seen DESC`
    )
      .bind(filterProject)
      .all<InstallRow>();
    rows = result.results;
  } else {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, install_id, version, arch, last_seen, first_seen, channel, container_count, os
       FROM installs ORDER BY project, last_seen DESC`
    )
      .all<InstallRow>();
    rows = result.results;
  }

  const installs = rows.map((row) => ({
    project: row.project,
    install_id: row.install_id,
    version: row.version,
    arch: row.arch,
    last_seen: toPacificISOString(row.last_seen),
    first_seen: row.first_seen ? toPacificISOString(row.first_seen) : null,
    channel: row.channel,
    container_count: row.container_count,
    os: row.os,
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
  <title>Beacon</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }

    /* ---- Login ---- */
    #login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-card { background: #161b22; border: 1px solid #21293a; border-radius: 12px; padding: 2rem; width: 340px; max-width: 90vw; }
    .login-logo { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.75rem; }
    .logo-dot { width: 8px; height: 8px; background: #22d3ee; border-radius: 50%; flex-shrink: 0; }
    .logo-text { font-size: 1rem; font-weight: 700; color: #22d3ee; letter-spacing: 0.08em; }
    .login-card input[type="password"] {
      width: 100%; padding: 0.65rem 0.85rem; background: #0d1117; border: 1px solid #21293a;
      border-radius: 6px; color: #e2e8f0; font-size: 0.95rem; outline: none; margin-bottom: 0.75rem;
    }
    .login-card input[type="password"]:focus { border-color: #22d3ee; }
    .login-card button[type="submit"] {
      width: 100%; padding: 0.65rem; background: #22d3ee; border: none; border-radius: 6px;
      color: #0d1117; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    }
    .login-card button[type="submit"]:hover { opacity: 0.9; }
    #login-error { color: #f87171; font-size: 0.85rem; margin-top: 0.6rem; display: none; }

    /* ---- Header ---- */
    header { display: flex; align-items: center; padding: 1rem 1.5rem; border-bottom: 1px solid #21293a; }
    .header-logo { display: flex; align-items: center; gap: 0.5rem; }
    .pill-btn {
      display: inline-flex; align-items: center; gap: 0.4rem;
      background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.2);
      color: #22d3ee; border-radius: 20px; padding: 0.35rem 0.8rem;
      font-size: 0.85rem; cursor: pointer;
    }
    .pill-btn:hover { background: rgba(34,211,238,0.13); }
    .pill-badge {
      display: inline-flex; align-items: center;
      background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.2);
      color: #22d3ee; border-radius: 20px; padding: 0.35rem 0.8rem; font-size: 0.85rem;
    }

    /* ---- Main ---- */
    main { max-width: 960px; width: 100%; margin: 0 auto; padding: 1.5rem; }

    /* ---- Stat cards ---- */
    .stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
    @media (max-width: 800px) { .stat-cards { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 420px) { .stat-cards { grid-template-columns: 1fr; } }
    .stat-card {
      background: #161b22; border: 1px solid #21293a; border-radius: 8px;
      padding: 1.25rem; cursor: pointer; transition: background 0.15s, border-color 0.15s;
    }
    .stat-card:hover { background: rgba(34,211,238,0.03); }
    .stat-card--active { background: rgba(34,211,238,0.05); border-color: #22d3ee; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #e2e8f0; line-height: 1; margin-bottom: 0.4rem; }
    .stat-value--stale { color: #f87171; }
    .stat-value--new { color: #22d3ee; }
    .stat-label { font-size: 0.82rem; color: #64748b; }

    /* ---- Chart ---- */
    .chart-section {
      background: #161b22; border: 1px solid #21293a; border-radius: 8px;
      padding: 1.25rem 1.25rem 2rem; margin-bottom: 1.5rem;
    }
    .chart-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
    .chart-title { font-size: 0.82rem; color: #64748b; }
    .chart-section canvas { display: block; width: 100% !important; height: 180px !important; }

    /* ---- Breakdowns ---- */
    .breakdown-wrap {
      background: #161b22; border: 1px solid #21293a; border-radius: 8px;
      padding: 1.25rem; margin-bottom: 1.5rem;
    }
    .breakdown-wrap-header { margin-bottom: 0.75rem; }
    .breakdown-wrap-title { font-size: 0.82rem; color: #64748b; }
    .breakdown-section { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 1rem; }
    @media (max-width: 700px) { .breakdown-section { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 460px) { .breakdown-section { grid-template-columns: 1fr; } }
    .breakdown-card { background: #161b22; border: 1px solid #21293a; border-radius: 8px; padding: 1rem; }
    .breakdown-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-bottom: 0.75rem; }
    .breakdown-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
    .breakdown-label { min-width: 52px; font-size: 0.8rem; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
    .breakdown-bar-track { flex: 1; height: 3px; background: #21293a; border-radius: 2px; overflow: hidden; }
    .breakdown-bar { height: 100%; background: #22d3ee; border-radius: 2px; transition: width 0.3s ease; }
    .breakdown-pct { font-size: 0.75rem; color: #64748b; width: 32px; text-align: right; flex-shrink: 0; }
    .empty-text { font-size: 0.8rem; color: #64748b; }

    /* ---- Details section ---- */
    .details-section { background: #161b22; border: 1px solid #21293a; border-radius: 8px; }
    .details-header { display: flex; align-items: center; padding: 1rem 1.25rem; font-size: 0.9rem; color: #e2e8f0; }
    #details-body { padding: 0 1.25rem 1.25rem; }

    /* ---- Filter bar ---- */
    .filter-bar { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .card-filter-pill-wrap { margin-bottom: 0.75rem; }
    .filter-pill {
      display: inline-flex; align-items: center; gap: 0.4rem;
      background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.2);
      color: #22d3ee; border-radius: 20px; padding: 0.25rem 0.65rem; font-size: 0.82rem;
    }
    .pill-dismiss { background: none; border: none; color: #22d3ee; cursor: pointer; padding: 0; font-size: 0.8rem; line-height: 1; opacity: 0.7; display: inline-flex; align-items: center; }
    .pill-dismiss:hover { opacity: 1; }

    /* ---- Custom dropdowns ---- */
    .dropdown-wrap { position: relative; }
    .dropdown-btn {
      display: inline-flex; align-items: center; gap: 0.35rem; background: transparent;
      border: 1px solid #21293a; color: #64748b; border-radius: 20px;
      padding: 0.3rem 0.7rem; font-size: 0.8rem; cursor: pointer; white-space: nowrap;
    }
    .dropdown-btn:hover { border-color: #475569; }
    .dropdown-btn--active { border-color: #22d3ee; color: #22d3ee; background: rgba(34,211,238,0.06); }
    .dropdown-menu {
      position: absolute; top: calc(100% + 4px); left: 0;
      background: #1c2230; border: 1px solid #21293a; border-radius: 8px;
      padding: 0.35rem 0; min-width: 120px; z-index: 50;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .dropdown-menu.hidden { display: none; }
    .dropdown-item { padding: 0.45rem 0.85rem; font-size: 0.85rem; color: #e2e8f0; cursor: pointer; }
    .dropdown-item:hover { background: rgba(34,211,238,0.06); color: #22d3ee; }
    .dropdown-item.active { color: #22d3ee; }

    /* ---- Install rows ---- */
    #install-rows { display: flex; flex-direction: column; }
    .install-row { border-top: 1px solid #21293a; cursor: pointer; }
    .install-row:first-child { border-top: none; }
    .install-row-main { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0; }
    .install-row:hover .install-row-main { background: rgba(255,255,255,0.02); }
    .install-row--expanded .install-row-main { background: rgba(34,211,238,0.03); }
    .install-id { font-family: monospace; font-size: 0.85rem; color: #22d3ee; flex-shrink: 0; width: 84px; }
    .install-chips { display: flex; gap: 0.35rem; flex-wrap: wrap; flex: 1; }
    .chip { display: inline-flex; align-items: center; font-size: 0.72rem; padding: 0.15rem 0.45rem; border-radius: 4px; font-weight: 500; }
    .chip--indigo { background: rgba(99,102,241,0.15); color: #a5b4fc; }
    .chip--purple { background: rgba(168,85,247,0.15); color: #d8b4fe; }
    .chip--cyan { background: rgba(34,211,238,0.12); color: #67e8f9; }
    .chip--amber { background: rgba(251,191,36,0.12); color: #fde68a; }
    .chip--neutral { background: rgba(100,116,139,0.15); color: #94a3b8; }
    .install-right { display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0; }
    .install-version { font-size: 0.82rem; color: #e2e8f0; }
    .install-time { font-size: 0.75rem; color: #64748b; }
    .install-detail-panel { background: #1c2230; border-top: 1px solid #21293a; padding: 0.85rem 0; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.75rem 1rem; }
    @media (max-width: 640px) { .detail-grid { grid-template-columns: 1fr 1fr; } }
    .detail-field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
    .detail-key { font-size: 0.68rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
    .detail-val { font-size: 0.82rem; color: #e2e8f0; word-break: break-all; overflow-wrap: anywhere; }
    .detail-mono { font-family: monospace; font-size: 0.76rem; }
    .empty-row { font-size: 0.85rem; color: #64748b; padding: 1rem 0; }
  </style>
</head>
<body>

<div id="login-page">
  <div class="login-card">
    <div class="login-logo">
      <span class="logo-dot"></span>
      <span class="logo-text">beacon</span>
    </div>
    <form id="login-form" autocomplete="off">
      <input type="password" id="password-input" placeholder="Password" autocomplete="current-password">
      <button type="submit">Sign in</button>
      <p id="login-error">Invalid password. Try again.</p>
    </form>
  </div>
</div>

<div id="dashboard-page" style="display:none">
  <header>
    <div class="header-logo">
      <span class="logo-dot"></span>
      <span class="logo-text">beacon</span>
      <span class="pill-badge">nestview</span>
    </div>
  </header>

  <main>
    <div class="stat-cards">
      <div class="stat-card" data-filter="active">
        <div class="stat-value" id="stat-active">-</div>
        <div class="stat-label">Active installs</div>
      </div>
      <div class="stat-card" data-filter="all">
        <div class="stat-value" id="stat-total">-</div>
        <div class="stat-label">All-time installs</div>
      </div>
      <div class="stat-card" data-filter="new_today">
        <div class="stat-value stat-value--new" id="stat-new">-</div>
        <div class="stat-label">New today</div>
      </div>
      <div class="stat-card" data-filter="stale">
        <div class="stat-value stat-value--stale" id="stat-stale">-</div>
        <div class="stat-label">Stale installs</div>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-header">
        <span class="chart-title" id="chart-title">Active installs - last 24h</span>
        <div class="dropdown-wrap">
          <button class="pill-btn" id="window-btn">
            <span id="window-btn-label">1d</span>
            <i class="ti ti-chevron-down"></i>
          </button>
          <div class="dropdown-menu hidden" id="window-menu">
            <div class="dropdown-item" data-value="1">1d</div>
            <div class="dropdown-item" data-value="7">7d</div>
            <div class="dropdown-item" data-value="14">14d</div>
            <div class="dropdown-item" data-value="30">30d</div>
            <div class="dropdown-item" data-value="90">90d</div>
          </div>
        </div>
      </div>
      <canvas id="history-chart"></canvas>
    </div>

    <div class="breakdown-wrap">
      <div class="breakdown-wrap-header">
        <span class="breakdown-wrap-title">Breakdown</span>
      </div>
      <div class="breakdown-section">
        <div class="breakdown-card">
          <div class="breakdown-title">Version</div>
          <div id="breakdown-version"></div>
        </div>
        <div class="breakdown-card">
          <div class="breakdown-title">Architecture</div>
          <div id="breakdown-arch"></div>
        </div>
        <div class="breakdown-card">
          <div class="breakdown-title">OS</div>
          <div id="breakdown-os"></div>
        </div>
        <div class="breakdown-card">
          <div class="breakdown-title">Channel</div>
          <div id="breakdown-channel"></div>
        </div>
      </div>
    </div>

    <div id="details-section" class="details-section">
      <div class="details-header">
        <span>Install details (<span id="details-count">0</span>)</span>
      </div>
      <div id="details-body">
        <div id="card-filter-pill" class="card-filter-pill-wrap" style="display:none"></div>
        <div class="filter-bar">
          <div class="dropdown-wrap">
            <button class="dropdown-btn" id="filter-version">
              <span class="dropdown-btn-label">Version</span>
              <i class="ti ti-chevron-down"></i>
            </button>
            <div class="dropdown-menu hidden" id="filter-version-menu"></div>
          </div>
          <div class="dropdown-wrap">
            <button class="dropdown-btn" id="filter-arch">
              <span class="dropdown-btn-label">Arch</span>
              <i class="ti ti-chevron-down"></i>
            </button>
            <div class="dropdown-menu hidden" id="filter-arch-menu"></div>
          </div>
          <div class="dropdown-wrap">
            <button class="dropdown-btn" id="filter-os">
              <span class="dropdown-btn-label">OS</span>
              <i class="ti ti-chevron-down"></i>
            </button>
            <div class="dropdown-menu hidden" id="filter-os-menu"></div>
          </div>
          <div class="dropdown-wrap">
            <button class="dropdown-btn" id="filter-channel">
              <span class="dropdown-btn-label">Channel</span>
              <i class="ti ti-chevron-down"></i>
            </button>
            <div class="dropdown-menu hidden" id="filter-channel-menu"></div>
          </div>
        </div>
        <div id="install-rows"></div>
      </div>
    </div>
  </main>
</div>

<script>
(function () {
  var token = sessionStorage.getItem('beacon_token');
  var allInstalls = [];
  var allHistory = {};
  var validWindows = [1, 7, 14, 30, 90];
  var storedWindow = parseInt(localStorage.getItem('beacon_window_days') || '1', 10);
  var windowDays = validWindows.indexOf(storedWindow) >= 0 ? storedWindow : 1;
  var cardFilter = null;
  var detailFilters = { version: null, arch: null, os: null, channel: null };
  var expandedInstallId = null;
  var histChart = null;

  var ACTIVE_MS = 36 * 3600000;
  var STALE_MS = 3 * 86400000;

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function relTime(dateStr) {
    var diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 2592000000) return Math.floor(diff / 86400000) + 'd ago';
    return Math.floor(diff / 2592000000) + 'mo ago';
  }

  function fmtDate(dateStr) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short',
        day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
      }).format(new Date(dateStr));
    } catch (e) { return dateStr || ''; }
  }

  function pacificDateStr(date) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date);
      var p = {};
      parts.forEach(function (part) { p[part.type] = part.value; });
      return p.year + '-' + p.month + '-' + p.day;
    } catch (e) { return ''; }
  }

  function isNewToday(firstSeen) {
    if (!firstSeen) return false;
    try {
      return pacificDateStr(new Date(firstSeen)) === pacificDateStr(new Date());
    } catch (e) { return false; }
  }

  function semverSort(a, b) {
    var pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var d = (pb[i] || 0) - (pa[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  function windowCutoff() {
    return Date.now() - windowDays * 86400000;
  }

  // ---- Auth ----

  function showLogin() {
    el('login-page').style.display = 'flex';
    el('dashboard-page').style.display = 'none';
  }
  function showDashboard() {
    el('login-page').style.display = 'none';
    el('dashboard-page').style.display = 'block';
  }

  if (token) { showDashboard(); loadData(token); }

  el('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    fetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: el('password-input').value })
    }).then(function (res) {
      if (!res.ok) { el('login-error').style.display = 'block'; return null; }
      return res.json();
    }).then(function (data) {
      if (!data) return;
      token = data.token;
      sessionStorage.setItem('beacon_token', token);
      el('login-error').style.display = 'none';
      showDashboard();
      loadData(token);
    }).catch(function () { el('login-error').style.display = 'block'; });
  });

  // ---- Data ----

  function loadData(t) {
    Promise.all([
      fetch('/installs?key=' + encodeURIComponent(t)),
      fetch('/history?key=' + encodeURIComponent(t))
    ]).then(function (responses) {
      if (!responses[0].ok || !responses[1].ok) {
        sessionStorage.removeItem('beacon_token'); showLogin(); return null;
      }
      return Promise.all([responses[0].json(), responses[1].json()]);
    }).then(function (data) {
      if (!data) return;
      allInstalls = (data[0].installs || []).filter(function (i) { return i.project === 'nestview'; });
      allHistory = data[1].history || {};
      render();
    }).catch(function () { sessionStorage.removeItem('beacon_token'); showLogin(); });
  }

  // ---- Render ----

  function render() {
    renderWindowPicker();
    renderStatCards();
    renderChart();
    renderBreakdowns();
    renderInstallDetails();
  }

  function renderWindowPicker() {
    el('window-btn-label').textContent = windowDays + 'd';
    document.querySelectorAll('#window-menu .dropdown-item').forEach(function (item) {
      item.classList.toggle('active', parseInt(item.dataset.value, 10) === windowDays);
    });
  }

  function renderStatCards() {
    var now = Date.now();
    var activeCount = 0, staleCount = 0, newTodayCount = 0;
    allInstalls.forEach(function (i) {
      var ls = new Date(i.last_seen).getTime();
      if (now - ls <= ACTIVE_MS) activeCount++;
      if (now - ls >= STALE_MS) staleCount++;
      if (isNewToday(i.first_seen)) newTodayCount++;
    });
    el('stat-active').textContent = activeCount.toLocaleString();
    el('stat-total').textContent = allInstalls.length.toLocaleString();
    el('stat-new').textContent = newTodayCount.toLocaleString();
    el('stat-stale').textContent = staleCount.toLocaleString();
    document.querySelectorAll('.stat-card').forEach(function (card) {
      card.classList.toggle('stat-card--active', card.dataset.filter === cardFilter);
    });
  }

  function renderChart() {
    var windowLabel = windowDays === 1 ? 'last 24h' : 'last ' + windowDays + 'd';
    var cardLabel = cardFilter === 'all' ? 'All installs'
      : cardFilter === 'stale' ? 'Stale installs'
      : cardFilter === 'new_today' ? 'New installs'
      : 'Active installs';
    el('chart-title').textContent = cardLabel + ' - ' + windowLabel;

    var canvas = el('history-chart');
    var ctx = canvas.getContext('2d');
    if (histChart) { histChart.destroy(); histChart = null; }

    var labels = [], chartData = [];
    var nowTs = Date.now();
    var i, cnt, ls, fs;

    if (windowDays === 1) {
      for (var h = 23; h >= 0; h--) {
        var hEndMs = nowTs - h * 3600000;
        var hStartMs = hEndMs - 3600000;
        cnt = 0;
        for (i = 0; i < allInstalls.length; i++) {
          ls = new Date(allInstalls[i].last_seen).getTime();
          if (cardFilter === 'stale') {
            if (hEndMs - ls >= STALE_MS) cnt++;
          } else if (cardFilter === 'all') {
            if (ls >= hStartMs && ls < hEndMs) cnt++;
          } else if (cardFilter === 'new_today') {
            fs = allInstalls[i].first_seen;
            if (fs) { var fsMs = new Date(fs).getTime(); if (fsMs >= hStartMs && fsMs < hEndMs) cnt++; }
          } else {
            if (hEndMs - ls <= ACTIVE_MS && ls < hEndMs) cnt++;
          }
        }
        var hh = new Date(hStartMs).getUTCHours();
        labels.push((hh < 10 ? '0' : '') + hh + ':00');
        chartData.push(cnt);
      }
    } else if (cardFilter === 'all') {
      var projectHistory = allHistory['nestview'] || [];
      var histMap = {};
      for (i = 0; i < projectHistory.length; i++) {
        histMap[projectHistory[i].date] = projectHistory[i].count;
      }
      for (var di = windowDays - 1; di >= 0; di--) {
        var dateStr = new Date(nowTs - di * 86400000).toISOString().slice(0, 10);
        labels.push(dateStr.slice(5));
        chartData.push(histMap[dateStr] !== undefined ? histMap[dateStr] : null);
      }
    } else {
      for (var dj = windowDays - 1; dj >= 0; dj--) {
        var dayEndMs = nowTs - dj * 86400000;
        var dayStartMs = dayEndMs - 86400000;
        cnt = 0;
        for (i = 0; i < allInstalls.length; i++) {
          ls = new Date(allInstalls[i].last_seen).getTime();
          if (cardFilter === 'stale') {
            if (dayEndMs - ls >= STALE_MS) cnt++;
          } else if (cardFilter === 'new_today') {
            fs = allInstalls[i].first_seen;
            if (fs) { var fsDayMs = new Date(fs).getTime(); if (fsDayMs >= dayStartMs && fsDayMs < dayEndMs) cnt++; }
          } else {
            if (dayEndMs - ls <= ACTIVE_MS && ls < dayEndMs) cnt++;
          }
        }
        labels.push(new Date(dayEndMs).toISOString().slice(5, 10));
        chartData.push(cnt);
      }
    }

    var nonNull = chartData.filter(function (v) { return v !== null; });
    var dataMax = nonNull.length > 0 ? Math.max.apply(null, nonNull) : 0;
    var dataMin = nonNull.length > 0 ? Math.min.apply(null, nonNull) : 0;
    var yStep = dataMax <= 5 ? 1 : dataMax <= 20 ? 5 : 10;
    var beginAtZero = dataMax === 0 || dataMin === 0 || (dataMax > 0 && dataMin / dataMax < 0.2);

    var gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, 'rgba(34,211,238,0.18)');
    gradient.addColorStop(1, 'rgba(34,211,238,0)');

    var tooltipNoun = cardFilter === 'stale' ? 'stale' : 'installs';

    histChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: chartData, borderColor: '#22d3ee', borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 3,
          fill: true, backgroundColor: gradient, tension: 0.3, spanGaps: true
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1c2230', borderColor: '#21293a', borderWidth: 1,
            titleColor: '#64748b', bodyColor: '#e2e8f0',
            callbacks: { label: function (c) { return ' ' + (c.parsed.y !== null ? c.parsed.y : '-') + ' ' + tooltipNoun; } }
          }
        },
        scales: {
          x: { grid: { color: '#21293a' }, ticks: { color: '#64748b', maxTicksLimit: 10, font: { size: 11 } } },
          y: { grid: { color: '#21293a' }, ticks: { color: '#64748b', font: { size: 11 }, stepSize: yStep, precision: 0 }, beginAtZero: beginAtZero }
        }
      }
    });
  }

  function renderBreakdowns() {
    var cutoff = windowCutoff();
    var active = allInstalls.filter(function (i) { return new Date(i.last_seen).getTime() >= cutoff; });
    var total = active.length;

    function buildDist(field) {
      var dist = {};
      active.forEach(function (i) {
        var v = (i[field] != null && i[field] !== '') ? i[field] : '-';
        dist[v] = (dist[v] || 0) + 1;
      });
      return dist;
    }

    renderDist('breakdown-version', buildDist('version'), total, true);
    renderDist('breakdown-arch', buildDist('arch'), total, false);
    renderDist('breakdown-os', buildDist('os'), total, false);
    renderDist('breakdown-channel', buildDist('channel'), total, false);
  }

  function renderDist(containerId, dist, total, sortByVersion) {
    var container = el(containerId);
    var entries = Object.keys(dist).map(function (k) { return [k, dist[k]]; });
    if (sortByVersion) entries.sort(function (a, b) { return semverSort(a[0], b[0]); });
    else entries.sort(function (a, b) { return b[1] - a[1]; });
    if (entries.length === 0) { container.innerHTML = '<span class="empty-text">No data</span>'; return; }
    container.innerHTML = entries.map(function (pair) {
      var pct = total > 0 ? Math.round(pair[1] / total * 100) : 0;
      return '<div class="breakdown-row">' +
        '<span class="breakdown-label" title="' + esc(pair[0]) + '">' + esc(pair[0]) + '</span>' +
        '<div class="breakdown-bar-track"><div class="breakdown-bar" style="width:' + pct + '%"></div></div>' +
        '<span class="breakdown-pct">' + pct + '%</span></div>';
    }).join('');
  }

  function renderInstallDetails() {
    var now = Date.now();
    var base;
    if (cardFilter === 'active') {
      base = allInstalls.filter(function (i) { return now - new Date(i.last_seen).getTime() <= ACTIVE_MS; });
    } else if (cardFilter === 'stale') {
      base = allInstalls.filter(function (i) { return now - new Date(i.last_seen).getTime() >= STALE_MS; });
    } else if (cardFilter === 'new_today') {
      base = allInstalls.filter(function (i) { return isNewToday(i.first_seen); });
    } else {
      base = allInstalls.slice();
    }

    var filtered = base.filter(function (i) {
      if (detailFilters.version && i.version !== detailFilters.version) return false;
      if (detailFilters.arch && i.arch !== detailFilters.arch) return false;
      var osVal = (i.os != null && i.os !== '') ? i.os : '-';
      if (detailFilters.os && osVal !== detailFilters.os) return false;
      var chanVal = (i.channel != null && i.channel !== '') ? i.channel : '-';
      if (detailFilters.channel && chanVal !== detailFilters.channel) return false;
      return true;
    });

    el('details-count').textContent = filtered.length;

    var pillWrap = el('card-filter-pill');
    if (cardFilter === 'active' || cardFilter === 'stale' || cardFilter === 'new_today') {
      var pillLabel = cardFilter === 'active' ? 'Active (36h)' : cardFilter === 'stale' ? 'Stale (3d+)' : 'New today';
      pillWrap.style.display = 'block';
      pillWrap.innerHTML = '<span class="filter-pill">' + esc(pillLabel) +
        ' <button class="pill-dismiss" id="dismiss-card-filter"><i class="ti ti-x"></i></button></span>';
      el('dismiss-card-filter').addEventListener('click', function (e) {
        e.stopPropagation();
        cardFilter = null;
        render();
      });
    } else {
      pillWrap.style.display = 'none';
      pillWrap.innerHTML = '';
    }

    populateDropdown('filter-version', 'version', base);
    populateDropdown('filter-arch', 'arch', base);
    populateDropdown('filter-os', 'os', base);
    populateDropdown('filter-channel', 'channel', base);
    renderInstallRows(filtered);
  }

  function populateDropdown(btnId, field, base) {
    var btn = el(btnId);
    var menu = el(btnId + '-menu');
    var selected = detailFilters[field];

    btn.querySelector('.dropdown-btn-label').textContent =
      selected != null ? selected : (field.charAt(0).toUpperCase() + field.slice(1));
    btn.classList.toggle('dropdown-btn--active', selected != null);

    var vals = {};
    base.forEach(function (i) {
      var v = (i[field] != null && i[field] !== '') ? i[field] : '-';
      vals[v] = true;
    });

    menu.innerHTML =
      '<div class="dropdown-item' + (selected == null ? ' active' : '') + '" data-value="">All</div>' +
      Object.keys(vals).sort().map(function (v) {
        return '<div class="dropdown-item' + (v === selected ? ' active' : '') + '" data-value="' + esc(v) + '">' + esc(v) + '</div>';
      }).join('');

    menu.querySelectorAll('.dropdown-item').forEach(function (item) {
      item.addEventListener('click', function () {
        detailFilters[field] = item.dataset.value || null;
        closeDropdowns();
        renderInstallDetails();
      });
    });
  }

  function renderInstallRows(installs) {
    var container = el('install-rows');
    if (installs.length === 0) {
      container.innerHTML = '<div class="empty-row">No installs match the current filters.</div>';
      return;
    }
    container.innerHTML = installs.map(function (i) {
      var shortId = i.install_id ? (i.install_id.slice(0, 8) + '…') : 'unknown';
      var osLabel = (i.os != null && i.os !== '') ? i.os : '-';
      var chanVal = (i.channel != null && i.channel !== '') ? i.channel : null;
      var chanLabel = chanVal || '-';
      var osClass = osLabel === 'Darwin' ? 'chip--purple' : 'chip--indigo';
      var chanClass = chanVal === 'stable' ? 'chip--cyan' : chanVal ? 'chip--amber' : 'chip--neutral';
      var isExpanded = expandedInstallId === i.install_id;

      var chips = '<span class="chip ' + osClass + '">' + esc(osLabel) + '</span>' +
        '<span class="chip ' + chanClass + '">' + esc(chanLabel) + '</span>' +
        '<span class="chip chip--neutral">' + esc(i.arch || 'unknown') + '</span>';
      if (i.container_count != null) chips += '<span class="chip chip--neutral">' + i.container_count + '</span>';

      var panel = '';
      if (isExpanded) {
        panel = '<div class="install-detail-panel"><div class="detail-grid">' +
          '<div class="detail-field"><span class="detail-key">install_id</span><span class="detail-val detail-mono">' + esc(i.install_id || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">version</span><span class="detail-val">' + esc(i.version || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">arch</span><span class="detail-val">' + esc(i.arch || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">os</span><span class="detail-val">' + esc(osLabel) + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">channel</span><span class="detail-val">' + esc(chanLabel) + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">containers</span><span class="detail-val">' + (i.container_count != null ? i.container_count : '-') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">project</span><span class="detail-val">' + esc(i.project || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">last_seen</span><span class="detail-val">' + esc(fmtDate(i.last_seen)) + '</span></div>' +
          '</div></div>';
      }

      return '<div class="install-row' + (isExpanded ? ' install-row--expanded' : '') + '" data-id="' + esc(i.install_id || '') + '">' +
        '<div class="install-row-main">' +
        '<span class="install-id">' + esc(shortId) + '</span>' +
        '<div class="install-chips">' + chips + '</div>' +
        '<div class="install-right"><span class="install-version">' + esc(i.version || '') + '</span><span class="install-time">' + esc(relTime(i.last_seen)) + '</span></div>' +
        '</div>' + panel + '</div>';
    }).join('');

    container.querySelectorAll('.install-row').forEach(function (row) {
      row.querySelector('.install-row-main').addEventListener('click', function () {
        var id = row.dataset.id;
        expandedInstallId = expandedInstallId === id ? null : id;
        renderInstallRows(installs);
      });
    });
  }

  // ---- Dropdowns ----

  function closeDropdowns() {
    document.querySelectorAll('.dropdown-menu').forEach(function (m) { m.classList.add('hidden'); });
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.dropdown-wrap')) closeDropdowns();
  });

  el('window-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    var menu = el('window-menu');
    var wasOpen = !menu.classList.contains('hidden');
    closeDropdowns();
    if (!wasOpen) menu.classList.remove('hidden');
  });

  el('window-menu').querySelectorAll('.dropdown-item').forEach(function (item) {
    item.addEventListener('click', function () {
      windowDays = parseInt(item.dataset.value, 10);
      localStorage.setItem('beacon_window_days', String(windowDays));
      closeDropdowns();
      render();
    });
  });

  ['filter-version', 'filter-arch', 'filter-os', 'filter-channel'].forEach(function (id) {
    el(id).addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = el(id + '-menu');
      var wasOpen = !menu.classList.contains('hidden');
      closeDropdowns();
      if (!wasOpen) menu.classList.remove('hidden');
    });
  });

  // ---- Stat card clicks ----

  document.querySelectorAll('.stat-card').forEach(function (card) {
    card.addEventListener('click', function () {
      var filter = card.dataset.filter;
      if (cardFilter === filter) {
        cardFilter = null;
      } else {
        cardFilter = filter;
        setTimeout(function () {
          el('details-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
      }
      render();
    });
  });
})();
<\/script>
</body>
</html>`;
}
