export interface Env {
  ANALYTICS_DB: D1Database;
  STATS_SECRET: string;
  API_SECRET: string;
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
const MAX_FIELD_LENGTH = 255;

function pacificDateString(date: Date = new Date()): string {
  const pacific = new Date(date.getTime() + PACIFIC_OFFSET_HOURS * 60 * 60 * 1000);
  return pacific.toISOString().slice(0, 10);
}

function base64urlEncode(data: ArrayBuffer | string): string {
  let binary = '';
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(pad));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64urlEncode(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${base64urlEncode(sig)}`;
}

async function verifyJWT(token: string, secret: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sig = base64urlDecode(parts[2]);
    const valid = await crypto.subtle.verify(
      'HMAC', key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
    return typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) < payload.exp;
  } catch {
    return false;
  }
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const aArr = new Uint8Array(aDigest);
  const bArr = new Uint8Array(bDigest);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i] ^ bArr[i];
  return diff === 0;
}

async function verifyBearerJWT(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  return verifyJWT(authHeader.slice(7), env.STATS_SECRET);
}

async function verifySummaryAuth(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  if (await verifyJWT(token, env.STATS_SECRET)) return true;
  return timingSafeEqual(token, env.API_SECRET);
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
      // cron failure must not affect /ping
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

  const { project, install_id, version, arch, timestamp, channel, container_count, os, dev } = body as {
    project?: unknown;
    install_id?: unknown;
    version?: unknown;
    arch?: unknown;
    timestamp?: unknown;
    channel?: unknown;
    container_count?: unknown;
    os?: unknown;
    dev?: unknown;
  };

  if (
    typeof project !== 'string' || !project ||
    typeof install_id !== 'string' || !install_id ||
    typeof version !== 'string' || !version ||
    typeof arch !== 'string' || !arch ||
    typeof timestamp !== 'string' || !timestamp
  ) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: project, install_id, version, arch, timestamp" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (
    project.length > MAX_FIELD_LENGTH ||
    install_id.length > MAX_FIELD_LENGTH ||
    version.length > MAX_FIELD_LENGTH ||
    arch.length > MAX_FIELD_LENGTH ||
    timestamp.length > MAX_FIELD_LENGTH
  ) {
    return new Response(
      JSON.stringify({ error: "Field value too long" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (channel !== undefined && channel !== null && (typeof channel !== 'string' || channel.length > MAX_FIELD_LENGTH)) {
    return new Response(
      JSON.stringify({ error: "Invalid channel field" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (os !== undefined && os !== null && (typeof os !== 'string' || os.length > MAX_FIELD_LENGTH)) {
    return new Response(
      JSON.stringify({ error: "Invalid os field" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (container_count !== undefined && container_count !== null && (typeof container_count !== 'number' || !Number.isFinite(container_count))) {
    return new Response(
      JSON.stringify({ error: "Invalid container_count field" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const isDev = dev ? 1 : 0;

  await env.ANALYTICS_DB.prepare(
    `INSERT INTO installs (project, install_id, version, arch, last_seen, first_seen, channel, container_count, os, is_dev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, install_id) DO UPDATE SET
       version         = excluded.version,
       arch            = excluded.arch,
       last_seen       = excluded.last_seen,
       channel         = excluded.channel,
       container_count = excluded.container_count,
       os              = excluded.os,
       is_dev          = excluded.is_dev`
  )
    .bind(
      project, install_id, version, arch, timestamp, timestamp,
      (typeof channel === 'string' ? channel : null),
      (typeof container_count === 'number' ? container_count : null),
      (typeof os === 'string' ? os : null),
      isDev
    )
    .run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function handleHistory(request: Request, env: Env): Promise<Response> {
  if (!await verifyBearerJWT(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
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
  if (!await verifySummaryAuth(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const filterProject = url.searchParams.get("project");
  const excludeDev = url.searchParams.get("exclude_dev") === "true";
  const now = Date.now();
  const activeStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleEnd = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const pacificMidnightUtc = `${pacificDateString()}T${String(Math.abs(PACIFIC_OFFSET_HOURS)).padStart(2, "0")}:00:00.000Z`;
  const devFilter = excludeDev ? " AND is_dev = 0" : "";

  let activeResult: { count: number } | null;
  let totalResult: { count: number } | null;
  let staleResult: { count: number } | null;
  let newTodayResult: { count: number } | null;

  if (filterProject) {
    activeResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND project = ?${devFilter}`
    ).bind(activeStart, filterProject).first<{ count: number }>();
    totalResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE project = ?${devFilter}`
    ).bind(filterProject).first<{ count: number }>();
    staleResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND last_seen < ? AND project = ?${devFilter}`
    ).bind(staleStart, staleEnd, filterProject).first<{ count: number }>();
    newTodayResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE first_seen >= ? AND project = ?${devFilter}`
    ).bind(pacificMidnightUtc, filterProject).first<{ count: number }>();
  } else {
    activeResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ?${devFilter}`
    ).bind(activeStart).first<{ count: number }>();
    totalResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE 1=1${devFilter}`
    ).first<{ count: number }>();
    staleResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND last_seen < ?${devFilter}`
    ).bind(staleStart, staleEnd).first<{ count: number }>();
    newTodayResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE first_seen >= ?${devFilter}`
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

  if (!body.password || !await timingSafeEqual(body.password, env.STATS_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJWT({ iat: now, exp: now + 86400 }, env.STATS_SECRET);

  return new Response(JSON.stringify({ token: jwt }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleInstalls(request: Request, env: Env): Promise<Response> {
  if (!await verifyBearerJWT(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
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
    is_dev: number;
  };

  let rows: InstallRow[];

  if (filterProject) {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, install_id, version, arch, last_seen, first_seen, channel, container_count, os, is_dev
       FROM installs WHERE project = ? ORDER BY project, last_seen DESC`
    )
      .bind(filterProject)
      .all<InstallRow>();
    rows = result.results;
  } else {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, install_id, version, arch, last_seen, first_seen, channel, container_count, os, is_dev
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
    is_dev: row.is_dev === 1,
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
    body { background: #0d1117; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; overflow-x: hidden; }

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
    .filter-bar { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; align-items: center; }
    .filter-selector-group { display: inline-flex; gap: 0.25rem; flex-wrap: wrap; }
    .fs-btn {
      display: inline-flex; align-items: center;
      background: transparent; border: 1px solid #21293a; color: #64748b;
      border-radius: 20px; padding: 0.3rem 0.7rem; font-size: 0.8rem; cursor: pointer; white-space: nowrap;
    }
    .fs-btn:hover { border-color: #475569; color: #94a3b8; }
    .fs-btn--active { border-color: #22d3ee; color: #22d3ee; background: rgba(34,211,238,0.08); }

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

    /* ---- Install table ---- */
    .install-table-wrap { overflow-x: auto; }
    .install-table { width: 100%; table-layout: fixed; border-collapse: collapse; }
    .install-table th {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: #64748b; padding: 0 0.6rem 0.6rem; text-align: left; font-weight: 500;
      white-space: nowrap; border-bottom: 1px solid #21293a;
      position: relative; overflow: hidden;
    }
    .th-resize-handle {
      position: absolute; top: 0; right: 0; width: 2px; height: 100%;
      cursor: col-resize; background: #21293a; z-index: 1;
    }
    .th-resize-handle:hover, .th-resize-handle.dragging { background: #22d3ee; }
    @media (max-width: 640px) { .th-resize-handle { display: none; } }
    .install-table th.th-sortable { cursor: pointer; user-select: none; }
    .install-table th.th-sortable:hover { color: #94a3b8; }
    .install-table th.col-chevron { width: 32px; padding-right: 0; }
    .sort-active { color: #22d3ee; }
    .sort-inactive { opacity: 0.3; font-size: 0.8em; }
    .install-table td {
      padding: 0.7rem 0.6rem; border-top: 1px solid #21293a;
      font-size: 0.85rem; color: #e2e8f0; white-space: nowrap;
    }
    .install-table td.col-chevron { color: #64748b; font-size: 0.7rem; text-align: center; padding-right: 0; }
    .install-table tbody tr.install-data-row { cursor: pointer; }
    .install-table tbody tr.install-data-row:hover td { background: rgba(255,255,255,0.02); }
    .install-table tbody tr.row-expanded td { background: rgba(34,211,238,0.03); }
    .install-table tbody tr.install-detail-row > td { padding: 0; cursor: default; background: none !important; border-top: none; }
    .install-id-cell { font-family: monospace; font-size: 0.85rem; color: #22d3ee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .install-detail-panel { background: #1c2230; border-top: 1px solid #21293a; padding: 0.85rem 1rem; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.75rem 1rem; }
    @media (max-width: 640px) { .detail-grid { grid-template-columns: 1fr 1fr; } }
    .detail-field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
    .detail-key { font-size: 0.68rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
    .detail-val { font-size: 0.82rem; color: #e2e8f0; word-break: break-all; overflow-wrap: anywhere; }
    .detail-mono { font-family: monospace; font-size: 0.76rem; }
    .empty-row { font-size: 0.85rem; color: #64748b; padding: 1rem 0.6rem; }
    .pagination { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0 0; justify-content: center; }
    .pagination-btn { display: inline-flex; align-items: center; background: transparent; border: 1px solid #21293a; color: #64748b; border-radius: 20px; padding: 0.3rem 0.75rem; font-size: 0.82rem; cursor: pointer; }
    .pagination-btn:hover:not([disabled]) { border-color: #475569; color: #e2e8f0; }
    .pagination-btn[disabled] { opacity: 0.4; cursor: default; }
    .pagination-info { font-size: 0.82rem; color: #64748b; }
    @media (max-width: 640px) {
      .col-os, .col-arch, .col-lastseen { display: none; }
    }
    .dev-badge {
      display: inline-flex; align-items: center;
      background: rgba(251,191,36,0.12); border: 1px solid rgba(251,191,36,0.3);
      color: #fbbf24; border-radius: 20px; padding: 0.1rem 0.45rem;
      font-size: 0.7rem; font-weight: 600; margin-left: 0.35rem; vertical-align: middle;
    }
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
    <div style="margin-left:1rem">
      <button class="pill-btn" id="dev-toggle"></button>
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
        <div class="filter-bar">
          <div class="filter-selector-group" id="filter-selector">
            <button class="fs-btn fs-btn--active" data-filter-opt="all">All installs</button>
            <button class="fs-btn" data-filter-opt="active">Active (36h)</button>
            <button class="fs-btn" data-filter-opt="new_today">New today</button>
            <button class="fs-btn" data-filter-opt="stale">Stale</button>
          </div>
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
          <div class="dropdown-wrap">
            <button class="dropdown-btn" id="filter-perpage">
              <span class="dropdown-btn-label">Per page: 10</span>
              <i class="ti ti-chevron-down"></i>
            </button>
            <div class="dropdown-menu hidden" id="filter-perpage-menu">
              <div class="dropdown-item active" data-value="10">10</div>
              <div class="dropdown-item" data-value="25">25</div>
              <div class="dropdown-item" data-value="50">50</div>
              <div class="dropdown-item" data-value="all">All</div>
            </div>
          </div>
        </div>
        <div class="install-table-wrap">
          <table class="install-table">
            <colgroup id="install-colgroup">
              <col style="width:32px">
              <col style="width:120px">
              <col style="width:80px">
              <col style="width:80px">
              <col style="width:80px">
              <col style="width:120px">
              <col style="width:120px">
            </colgroup>
            <thead><tr id="install-thead"></tr></thead>
            <tbody id="install-tbody"></tbody>
          </table>
        </div>
        <div id="pagination-bar"></div>
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
  var excludeDev = localStorage.getItem('beacon_exclude_dev') !== 'false';
  var cardFilter = 'all';
  var detailFilters = { version: null, arch: null, os: null, channel: null };
  var expandedInstallId = null;
  var currentPage = 1;
  var pageSize = 10;
  var currentFiltered = [];
  var histChart = null;
  var sortCol = 'first_seen';
  var sortDir = 'desc';

  var ACTIVE_MS = 36 * 3600000;
  var MIN_COL_WIDTH = 48;
  var colWidths = [32, 120, 80, 80, 80, 120, 120];

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

  if (token) { showDashboard(); loadData(token); renderDevToggle(); }

  el('dev-toggle').addEventListener('click', function () {
    excludeDev = !excludeDev;
    localStorage.setItem('beacon_exclude_dev', String(excludeDev));
    currentPage = 1;
    render();
  });

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
    var authHeaders = { 'Authorization': 'Bearer ' + t };
    Promise.all([
      fetch('/installs', { headers: authHeaders }),
      fetch('/history', { headers: authHeaders })
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
    renderDevToggle();
    renderWindowPicker();
    renderStatCards();
    renderChart();
    renderBreakdowns();
    renderInstallDetails();
    renderFilterSelector();
  }

  function renderDevToggle() {
    var btn = el('dev-toggle');
    btn.textContent = excludeDev ? 'Excluding dev' : 'All installs';
  }

  function renderFilterSelector() {
    var active = cardFilter || 'all';
    document.querySelectorAll('#filter-selector .fs-btn').forEach(function (btn) {
      btn.classList.toggle('fs-btn--active', btn.dataset.filterOpt === active);
    });
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
    var counted = excludeDev ? allInstalls.filter(function (i) { return !i.is_dev; }) : allInstalls;
    counted.forEach(function (i) {
      var ls = new Date(i.last_seen).getTime();
      if (now - ls <= ACTIVE_MS) activeCount++;
      if (now - ls > ACTIVE_MS) staleCount++;
      if (isNewToday(i.first_seen)) newTodayCount++;
    });
    el('stat-active').textContent = activeCount.toLocaleString();
    el('stat-total').textContent = counted.length.toLocaleString();
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
    var chartInstalls = excludeDev ? allInstalls.filter(function (x) { return !x.is_dev; }) : allInstalls;

    if (windowDays === 1) {
      for (var h = 23; h >= 0; h--) {
        var hEndMs = nowTs - h * 3600000;
        var hStartMs = hEndMs - 3600000;
        cnt = 0;
        for (i = 0; i < chartInstalls.length; i++) {
          ls = new Date(chartInstalls[i].last_seen).getTime();
          if (cardFilter === 'stale') {
            if (hEndMs - ls > ACTIVE_MS) cnt++;
          } else if (cardFilter === 'all') {
            if (ls >= hStartMs && ls < hEndMs) cnt++;
          } else if (cardFilter === 'new_today') {
            fs = chartInstalls[i].first_seen;
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
        for (i = 0; i < chartInstalls.length; i++) {
          ls = new Date(chartInstalls[i].last_seen).getTime();
          if (cardFilter === 'stale') {
            if (dayEndMs - ls > ACTIVE_MS) cnt++;
          } else if (cardFilter === 'new_today') {
            fs = chartInstalls[i].first_seen;
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
    var source = excludeDev ? allInstalls.filter(function (i) { return !i.is_dev; }) : allInstalls;
    var active = source.filter(function (i) { return new Date(i.last_seen).getTime() >= cutoff; });
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
    var source = excludeDev ? allInstalls.filter(function (i) { return !i.is_dev; }) : allInstalls;
    var base;
    if (cardFilter === 'active') {
      base = source.filter(function (i) { return now - new Date(i.last_seen).getTime() <= ACTIVE_MS; });
    } else if (cardFilter === 'stale') {
      base = source.filter(function (i) { return now - new Date(i.last_seen).getTime() > ACTIVE_MS; });
    } else if (cardFilter === 'new_today') {
      base = source.filter(function (i) { return isNewToday(i.first_seen); });
    } else {
      base = source.slice();
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

    currentFiltered = filtered;
    el('details-count').textContent = filtered.length;

    populateDropdown('filter-version', 'version', base);
    populateDropdown('filter-arch', 'arch', base);
    populateDropdown('filter-os', 'os', base);
    populateDropdown('filter-channel', 'channel', base);
    renderInstallTable(filtered);
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
        currentPage = 1;
        closeDropdowns();
        renderInstallDetails();
      });
    });
  }

  function sortInstalls(arr) {
    return arr.slice().sort(function (a, b) {
      var av, bv, cmp;
      if (sortCol === 'version') {
        cmp = semverSort(a.version || '0', b.version || '0');
        return sortDir === 'asc' ? -cmp : cmp;
      }
      if (sortCol === 'first_seen') {
        av = a.first_seen ? new Date(a.first_seen).getTime() : 0;
        bv = b.first_seen ? new Date(b.first_seen).getTime() : 0;
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      if (sortCol === 'last_seen') {
        av = new Date(a.last_seen).getTime();
        bv = new Date(b.last_seen).getTime();
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      av = ((a[sortCol] != null && a[sortCol] !== '') ? String(a[sortCol]) : '-').toLowerCase();
      bv = ((b[sortCol] != null && b[sortCol] !== '') ? String(b[sortCol]) : '-').toLowerCase();
      cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  function renderInstallTable(installs) {
    var thead = el('install-thead');
    var tbody = el('install-tbody');
    var paginationBar = el('pagination-bar');
    var total = installs.length;

    var cols = [
      { key: null, label: '', cls: 'col-chevron', sortable: false },
      { key: null, label: 'Install ID', cls: 'col-installid', sortable: false },
      { key: 'os', label: 'OS', cls: 'col-os', sortable: true },
      { key: 'arch', label: 'Arch', cls: 'col-arch', sortable: true },
      { key: 'version', label: 'Version', cls: 'col-version', sortable: true },
      { key: 'first_seen', label: 'First Seen', cls: 'col-firstseen', sortable: true },
      { key: 'last_seen', label: 'Last Seen', cls: 'col-lastseen', sortable: true }
    ];

    thead.innerHTML = cols.map(function (col) {
      var indicator = '';
      if (col.sortable) {
        if (sortCol === col.key) {
          indicator = '<span class="sort-active">' + (sortDir === 'asc' ? ' ▲' : ' ▼') + '</span>';
        } else {
          indicator = '<span class="sort-inactive"> ⇅</span>';
        }
      }
      var style = col.align === 'right' ? ' style="text-align:right"' : '';
      var thCls = (col.sortable ? 'th-sortable' : 'th-plain') + ' ' + col.cls;
      var dataAttr = col.sortable ? ' data-sort="' + col.key + '"' : '';
      return '<th class="' + thCls + '"' + dataAttr + style + '>' + esc(col.label) + indicator + '</th>';
    }).join('');

    thead.querySelectorAll('[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var col = th.dataset.sort;
        if (sortCol === col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col;
          sortDir = 'asc';
        }
        currentPage = 1;
        renderInstallTable(currentFiltered);
      });
    });

    var cgCols = el('install-colgroup').querySelectorAll('col');
    colWidths.forEach(function (w, i) { if (cgCols[i]) cgCols[i].style.width = w + 'px'; });
    attachResizeHandles();

    if (total === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No installs match the current filters.</td></tr>';
      paginationBar.innerHTML = '';
      return;
    }

    var sorted = sortInstalls(installs);
    var pageRows;
    if (pageSize === 'all') {
      pageRows = sorted;
      paginationBar.innerHTML = '';
    } else {
      var totalPages = Math.ceil(total / pageSize);
      if (currentPage > totalPages) currentPage = totalPages;
      var start = (currentPage - 1) * pageSize;
      pageRows = sorted.slice(start, start + pageSize);
      paginationBar.innerHTML =
        '<div class="pagination">' +
        '<button class="pagination-btn" id="prev-page"' + (currentPage <= 1 ? ' disabled' : '') + '>Prev</button>' +
        '<span class="pagination-info">Page ' + currentPage + ' of ' + totalPages + '</span>' +
        '<button class="pagination-btn" id="next-page"' + (currentPage >= totalPages ? ' disabled' : '') + '>Next</button>' +
        '</div>';
      if (currentPage > 1) {
        el('prev-page').addEventListener('click', function () {
          currentPage--;
          renderInstallTable(currentFiltered);
        });
      }
      if (currentPage < totalPages) {
        el('next-page').addEventListener('click', function () {
          currentPage++;
          renderInstallTable(currentFiltered);
        });
      }
    }

    tbody.innerHTML = pageRows.map(function (i) {
      var osLabel = (i.os != null && i.os !== '') ? i.os : '-';
      var chanLabel = (i.channel != null && i.channel !== '') ? i.channel : '-';
      var isExpanded = expandedInstallId === i.install_id;
      var firstSeenRel = i.first_seen ? relTime(i.first_seen) : '-';
      var lastSeenRel = i.last_seen ? relTime(i.last_seen) : '-';

      var devBadge = (!excludeDev && i.is_dev) ? '<span class="dev-badge">dev</span>' : '';
      var dataRow = '<tr class="install-data-row' + (isExpanded ? ' row-expanded' : '') + '" data-id="' + esc(i.install_id || '') + '">' +
        '<td class="col-chevron">' + (isExpanded ? '▼' : '▶') + '</td>' +
        '<td class="col-installid install-id-cell">' + esc(i.install_id || 'unknown') + devBadge + '</td>' +
        '<td class="col-os">' + esc(osLabel) + '</td>' +
        '<td class="col-arch">' + esc(i.arch || '-') + '</td>' +
        '<td class="col-version">' + esc(i.version || '-') + '</td>' +
        '<td class="col-firstseen">' + esc(firstSeenRel) + '</td>' +
        '<td class="col-lastseen">' + esc(lastSeenRel) + '</td>' +
        '</tr>';

      var detailRow = '';
      if (isExpanded) {
        detailRow = '<tr class="install-detail-row"><td colspan="7"><div class="install-detail-panel"><div class="detail-grid">' +
          '<div class="detail-field"><span class="detail-key">install_id</span><span class="detail-val detail-mono">' + esc(i.install_id || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">version</span><span class="detail-val">' + esc(i.version || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">arch</span><span class="detail-val">' + esc(i.arch || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">os</span><span class="detail-val">' + esc(osLabel) + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">channel</span><span class="detail-val">' + esc(chanLabel) + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">container_count</span><span class="detail-val">' + (i.container_count != null ? i.container_count : '-') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">project</span><span class="detail-val">' + esc(i.project || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">first_seen</span><span class="detail-val">' + esc(fmtDate(i.first_seen)) + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">last_seen</span><span class="detail-val">' + esc(fmtDate(i.last_seen)) + '</span></div>' +
          '</div></div></td></tr>';
      }

      return dataRow + detailRow;
    }).join('');

    tbody.querySelectorAll('.install-data-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.dataset.id;
        expandedInstallId = expandedInstallId === id ? null : id;
        renderInstallTable(currentFiltered);
      });
    });
  }

  function attachResizeHandles() {
    var ths = el('install-thead').querySelectorAll('th');
    var cgCols = el('install-colgroup').querySelectorAll('col');
    ths.forEach(function (th, idx) {
      var handle = document.createElement('span');
      handle.className = 'th-resize-handle';
      th.appendChild(handle);
      handle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var startX = e.clientX;
        var startW = colWidths[idx];
        handle.classList.add('dragging');
        function onMove(e) {
          var newW = Math.max(MIN_COL_WIDTH, startW + e.clientX - startX);
          colWidths[idx] = newW;
          if (cgCols[idx]) cgCols[idx].style.width = newW + 'px';
        }
        function onUp() {
          handle.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
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

  ['filter-version', 'filter-arch', 'filter-os', 'filter-channel', 'filter-perpage'].forEach(function (id) {
    el(id).addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = el(id + '-menu');
      var wasOpen = !menu.classList.contains('hidden');
      closeDropdowns();
      if (!wasOpen) menu.classList.remove('hidden');
    });
  });

  el('filter-perpage-menu').querySelectorAll('.dropdown-item').forEach(function (item) {
    item.addEventListener('click', function () {
      var val = item.dataset.value;
      pageSize = val === 'all' ? 'all' : parseInt(val, 10);
      currentPage = 1;
      var label = val === 'all' ? 'All' : val;
      el('filter-perpage').querySelector('.dropdown-btn-label').textContent = 'Per page: ' + label;
      el('filter-perpage-menu').querySelectorAll('.dropdown-item').forEach(function (it) {
        it.classList.toggle('active', it.dataset.value === val);
      });
      closeDropdowns();
      renderInstallTable(currentFiltered);
    });
  });

  // ---- Filter selector clicks ----

  document.querySelectorAll('#filter-selector .fs-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      cardFilter = btn.dataset.filterOpt;
      currentPage = 1;
      render();
    });
  });

  // ---- Stat card clicks ----

  document.querySelectorAll('.stat-card').forEach(function (card) {
    card.addEventListener('click', function () {
      cardFilter = card.dataset.filter;
      currentPage = 1;
      setTimeout(function () {
        el('details-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      render();
    });
  });
})();
<\/script>
</body>
</html>`;
}
