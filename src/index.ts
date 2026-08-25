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
const RECENT_ACTIVE_HOURS = 36;
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

    if (request.method === "GET" && url.pathname === "/projects") {
      return handleProjects(request, env);
    }

    if (request.method === "POST" && url.pathname === "/project-settings") {
      return handleProjectSettings(request, env);
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

      await env.ANALYTICS_DB.prepare(
        `DELETE FROM installs WHERE last_seen < datetime('now', '-30 days')`
      ).run();
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

  const { project, install_id, version, arch, timestamp, channel, container_count, artist_count, album_count, song_count, os, dev } = body as {
    project?: unknown;
    install_id?: unknown;
    version?: unknown;
    arch?: unknown;
    timestamp?: unknown;
    channel?: unknown;
    container_count?: unknown;
    artist_count?: unknown;
    album_count?: unknown;
    song_count?: unknown;
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

  if (artist_count !== undefined && artist_count !== null && (typeof artist_count !== 'number' || !Number.isInteger(artist_count) || artist_count < 0)) {
    return new Response(
      JSON.stringify({ error: "Invalid artist_count field" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (album_count !== undefined && album_count !== null && (typeof album_count !== 'number' || !Number.isInteger(album_count) || album_count < 0)) {
    return new Response(
      JSON.stringify({ error: "Invalid album_count field" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (song_count !== undefined && song_count !== null && (typeof song_count !== 'number' || !Number.isInteger(song_count) || song_count < 0)) {
    return new Response(
      JSON.stringify({ error: "Invalid song_count field" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const isDev = dev ? 1 : 0;

  await env.ANALYTICS_DB.prepare(
    `INSERT INTO installs (project, install_id, version, arch, last_seen, first_seen, channel, container_count, artist_count, album_count, song_count, os, is_dev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, install_id) DO UPDATE SET
       version         = excluded.version,
       arch            = excluded.arch,
       last_seen       = excluded.last_seen,
       channel         = excluded.channel,
       container_count = excluded.container_count,
       artist_count    = excluded.artist_count,
       album_count     = excluded.album_count,
       song_count      = excluded.song_count,
       os              = excluded.os,
       is_dev          = excluded.is_dev`
  )
    .bind(
      project, install_id, version, arch, timestamp, timestamp,
      (typeof channel === 'string' ? channel : null),
      (typeof container_count === 'number' ? container_count : null),
      (typeof artist_count === 'number' ? artist_count : null),
      (typeof album_count === 'number' ? album_count : null),
      (typeof song_count === 'number' ? song_count : null),
      (typeof os === 'string' ? os : null),
      isDev
    )
    .run();

  await env.ANALYTICS_DB.prepare(
    `INSERT OR IGNORE INTO install_lifetime (project, install_id, first_seen) VALUES (?, ?, ?)`
  )
    .bind(project, install_id, timestamp)
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
  const recentActiveStart = new Date(now - RECENT_ACTIVE_HOURS * 60 * 60 * 1000).toISOString();
  const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const activeStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleEnd = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const pacificMidnightUtc = `${pacificDateString()}T${String(Math.abs(PACIFIC_OFFSET_HOURS)).padStart(2, "0")}:00:00.000Z`;
  const devFilter = excludeDev ? " AND is_dev = 0" : "";

  let recentActiveResult: { count: number } | null;
  let activeResult: { count: number } | null;
  let weekResult: { count: number } | null;
  let retainedResult: { count: number } | null;
  let totalResult: { count: number } | null;
  let staleResult: { count: number } | null;
  let newTodayResult: { count: number } | null;

  if (filterProject) {
    recentActiveResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND project = ?${devFilter}`
    ).bind(recentActiveStart, filterProject).first<{ count: number }>();
    activeResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND project = ?${devFilter}`
    ).bind(activeStart, filterProject).first<{ count: number }>();
    weekResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND project = ?${devFilter}`
    ).bind(weekStart, filterProject).first<{ count: number }>();
    retainedResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE project = ?${devFilter}`
    ).bind(filterProject).first<{ count: number }>();
    totalResult = excludeDev
      ? await env.ANALYTICS_DB.prepare(
          `SELECT COUNT(*) AS count FROM install_lifetime il
           WHERE il.project = ?
           AND NOT EXISTS (
             SELECT 1 FROM installs i
             WHERE i.project = il.project AND i.install_id = il.install_id AND i.is_dev = 1
           )`
        ).bind(filterProject).first<{ count: number }>()
      : await env.ANALYTICS_DB.prepare(
          `SELECT COUNT(*) AS count FROM install_lifetime WHERE project = ?`
        ).bind(filterProject).first<{ count: number }>();
    staleResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ? AND last_seen < ? AND project = ?${devFilter}`
    ).bind(staleStart, staleEnd, filterProject).first<{ count: number }>();
    newTodayResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE first_seen >= ? AND project = ?${devFilter}`
    ).bind(pacificMidnightUtc, filterProject).first<{ count: number }>();
  } else {
    recentActiveResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ?${devFilter}`
    ).bind(recentActiveStart).first<{ count: number }>();
    activeResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ?${devFilter}`
    ).bind(activeStart).first<{ count: number }>();
    weekResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE last_seen >= ?${devFilter}`
    ).bind(weekStart).first<{ count: number }>();
    retainedResult = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS count FROM installs WHERE 1=1${devFilter}`
    ).first<{ count: number }>();
    totalResult = excludeDev
      ? await env.ANALYTICS_DB.prepare(
          `SELECT COUNT(*) AS count FROM install_lifetime il
           WHERE NOT EXISTS (
             SELECT 1 FROM installs i
             WHERE i.project = il.project AND i.install_id = il.install_id AND i.is_dev = 1
           )`
        ).first<{ count: number }>()
      : await env.ANALYTICS_DB.prepare(
          `SELECT COUNT(*) AS count FROM install_lifetime`
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
      active_recent: recentActiveResult?.count ?? 0,
      active: activeResult?.count ?? 0,
      active_30d: activeResult?.count ?? 0,
      active_week: weekResult?.count ?? 0,
      retained: retainedResult?.count ?? 0,
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
    artist_count: number | null;
    album_count: number | null;
    song_count: number | null;
    os: string | null;
    is_dev: number;
  };

  let rows: InstallRow[];

  if (filterProject) {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, install_id, version, arch, last_seen, first_seen, channel, container_count, artist_count, album_count, song_count, os, is_dev
       FROM installs WHERE project = ? ORDER BY project, last_seen DESC`
    )
      .bind(filterProject)
      .all<InstallRow>();
    rows = result.results;
  } else {
    const result = await env.ANALYTICS_DB.prepare(
      `SELECT project, install_id, version, arch, last_seen, first_seen, channel, container_count, artist_count, album_count, song_count, os, is_dev
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
    artist_count: row.artist_count,
    album_count: row.album_count,
    song_count: row.song_count,
    os: row.os,
    is_dev: row.is_dev === 1,
  }));

  return new Response(JSON.stringify({ installs }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleProjects(request: Request, env: Env): Promise<Response> {
  if (!await verifyBearerJWT(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await env.ANALYTICS_DB.prepare(
    `SELECT p.project, ps.display_name, ps.icon FROM (
       SELECT project FROM installs
       UNION
       SELECT project FROM install_lifetime
       UNION
       SELECT project FROM install_history
     ) p
     LEFT JOIN project_settings ps ON ps.project = p.project
     ORDER BY p.project ASC`
  ).all<{ project: string; display_name: string | null; icon: string | null }>();

  return new Response(JSON.stringify({
    projects: result.results,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const PROJECT_ICONS = new Set([
  "ti-chart-dots-3", "ti-box", "ti-device-desktop", "ti-music", "ti-server",
  "ti-radio", "ti-code", "ti-app-window",
]);

async function handleProjectSettings(request: Request, env: Env): Promise<Response> {
  if (!await verifyBearerJWT(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { project?: unknown; display_name?: unknown; icon?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const project = typeof body.project === "string" ? body.project.trim() : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const icon = typeof body.icon === "string" ? body.icon : "";
  if (!project || project.length > MAX_FIELD_LENGTH || !displayName || displayName.length > 64 || !PROJECT_ICONS.has(icon)) {
    return new Response(JSON.stringify({ error: "Invalid project settings" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const knownProject = await env.ANALYTICS_DB.prepare(
    `SELECT 1 AS found FROM installs WHERE project = ?
     UNION SELECT 1 AS found FROM install_lifetime WHERE project = ?
     UNION SELECT 1 AS found FROM install_history WHERE project = ? LIMIT 1`
  ).bind(project, project, project).first<{ found: number }>();
  if (!knownProject) {
    return new Response(JSON.stringify({ error: "Unknown project" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  await env.ANALYTICS_DB.prepare(
    `INSERT INTO project_settings (project, display_name, icon, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(project) DO UPDATE SET
       display_name = excluded.display_name,
       icon = excluded.icon,
       updated_at = excluded.updated_at`
  ).bind(project, displayName, icon).run();

  return new Response(JSON.stringify({ project, display_name: displayName, icon }), {
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
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
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

    /* ---- App shell ---- */
    .app-shell { min-height: 100vh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
    .sidebar { background: #10161f; border-right: 1px solid #21293a; padding: 1.35rem 1rem; display: flex; flex-direction: column; gap: 1.35rem; }
    .sidebar-logo { display: flex; align-items: center; gap: 0.5rem; padding: 0 0.5rem; }
    .sidebar-section-label { color: #64748b; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 0 0.5rem; margin-bottom: 0.5rem; }
    .project-nav { display: grid; gap: 0.25rem; }
    .overview-nav { margin-bottom: 0.35rem; }
    .project-nav-group { display: grid; gap: 0.2rem; }
    .project-subnav { display: grid; gap: 0.15rem; margin: 0 0 0.2rem 1.55rem; padding-left: 0.7rem; border-left: 1px solid #263244; }
    .project-subnav-item { border: 0; background: transparent; color: #64748b; cursor: pointer; font-size: 0.78rem; padding: 0.35rem 0.25rem; text-align: left; }
    .project-subnav-item:hover, .project-subnav-item.active { color: #67e8f9; }
    .project-nav-chevron { margin-left: auto; color: #64748b; font-size: 0.75rem; }
    .project-nav-item { display: flex; align-items: center; width: 100%; gap: 0.65rem; border: 1px solid transparent; border-radius: 7px; padding: 0.62rem 0.7rem; color: #94a3b8; background: transparent; cursor: pointer; font-size: 0.9rem; text-align: left; }
    .project-nav-item:hover { background: rgba(148,163,184,0.08); color: #e2e8f0; }
    .project-nav-item.active { background: rgba(34,211,238,0.1); border-color: rgba(34,211,238,0.18); color: #67e8f9; }
    .project-nav-icon { color: #22d3ee; font-size: 1rem; }
    .sidebar-controls { padding: 0 0.25rem; }
    .sidebar-controls .pill-btn { width: 100%; justify-content: center; }
    .content { min-width: 0; }
    .content-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.25rem 2rem; border-bottom: 1px solid #21293a; }
    .page-title { font-size: 1.1rem; font-weight: 650; color: #f1f5f9; }
    .page-subtitle { color: #64748b; font-size: 0.82rem; margin-top: 0.22rem; }
    .header-actions { display: inline-flex; align-items: center; gap: 0.6rem; }
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
    main { max-width: 1320px; width: 100%; margin: 0 auto; padding: 2rem; }

    /* ---- All projects overview ---- */
    .overview-intro { color: #94a3b8; font-size: 0.92rem; margin: 0 0 1.5rem; }
    .overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
    .overview-card { appearance: none; width: 100%; text-align: left; color: inherit; cursor: pointer; background: #161b22; border: 1px solid #21293a; border-radius: 10px; padding: 1.2rem; transition: background 0.15s, border-color 0.15s, transform 0.15s; }
    .overview-card:hover { background: rgba(34,211,238,0.04); border-color: rgba(34,211,238,0.38); transform: translateY(-1px); }
    .overview-card-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 1.1rem; }
    .overview-card-title { color: #f1f5f9; font-size: 1rem; font-weight: 650; }
    .overview-status { color: #67e8f9; background: rgba(34,211,238,0.1); border-radius: 20px; padding: 0.2rem 0.5rem; font-size: 0.7rem; font-weight: 600; white-space: nowrap; }
    .overview-status.quiet { color: #94a3b8; background: rgba(148,163,184,0.1); }
    .overview-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .overview-value { color: #f1f5f9; font-size: 1.75rem; font-weight: 700; line-height: 1; margin-bottom: 0.35rem; }
    .overview-label { color: #64748b; font-size: 0.77rem; }

    /* ---- Stat cards ---- */
    .stat-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
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

    /* ---- Project health ---- */
    .project-health { background: #161b22; border: 1px solid #21293a; border-radius: 8px; padding: 1.15rem 1.25rem; margin-bottom: 1.5rem; }
    .project-health-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .project-health-title { color: #94a3b8; font-size: 0.78rem; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
    .project-health-note { color: #64748b; font-size: 0.76rem; }
    .project-health-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
    .health-item { min-width: 0; }
    .health-value { color: #f1f5f9; font-size: 1.05rem; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .health-value--good { color: #67e8f9; }
    .health-label { color: #64748b; font-size: 0.75rem; margin-top: 0.28rem; }
    @media (max-width: 700px) { .project-health-grid { grid-template-columns: 1fr 1fr; } }

    /* ---- Breakdowns ---- */
    .breakdown-wrap {
      background: #161b22; border: 1px solid #21293a; border-radius: 8px;
      padding: 1.25rem; margin-bottom: 1.5rem;
    }
    .breakdown-wrap-header { margin-bottom: 1rem; }
    .breakdown-wrap-title { font-size: 0.82rem; color: #64748b; }
    .breakdown-section { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    @media (max-width: 980px) { .breakdown-section { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 700px) { .breakdown-section { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 460px) { .breakdown-section { grid-template-columns: 1fr; } }
    .breakdown-card { min-width: 0; }
    .breakdown-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-bottom: 0.75rem; }
    .running-tags { display: flex; flex-wrap: wrap; gap: 0.45rem; }
    .running-tag { display: inline-flex; align-items: center; gap: 0.4rem; max-width: 100%; color: #cbd5e1; background: #1c2230; border: 1px solid #293244; border-radius: 6px; padding: 0.32rem 0.48rem; font-size: 0.78rem; }
    .running-tag-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .running-tag-count { color: #67e8f9; font-size: 0.72rem; }
    .empty-text { font-size: 0.8rem; color: #64748b; }

    /* ---- Project settings ---- */
    .settings-card { max-width: 620px; background: #161b22; border: 1px solid #21293a; border-radius: 8px; padding: 1.25rem; }
    .settings-card-title { color: #f1f5f9; font-size: 1rem; font-weight: 650; margin-bottom: 0.35rem; }
    .settings-card-note { color: #64748b; font-size: 0.82rem; margin-bottom: 1.5rem; }
    .settings-field { display: grid; gap: 0.5rem; margin-bottom: 1.2rem; }
    .settings-label { color: #94a3b8; font-size: 0.8rem; font-weight: 600; }
    .settings-input { width: 100%; background: #0d1117; color: #e2e8f0; border: 1px solid #293244; border-radius: 6px; padding: 0.65rem 0.75rem; font: inherit; font-size: 0.9rem; outline: none; }
    .settings-input:focus { border-color: #22d3ee; }
    .icon-picker { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .icon-choice { width: 2.45rem; height: 2.25rem; display: inline-flex; align-items: center; justify-content: center; background: #111822; color: #94a3b8; border: 1px solid #293244; border-radius: 6px; cursor: pointer; font-size: 1rem; }
    .icon-choice:hover, .icon-choice.active { color: #67e8f9; border-color: #22d3ee; background: rgba(34,211,238,0.08); }
    .settings-actions { display: flex; align-items: center; gap: 0.75rem; margin-top: 1.5rem; }
    .settings-save { border: 0; background: #22d3ee; color: #0d1117; border-radius: 6px; padding: 0.58rem 0.85rem; font-size: 0.85rem; font-weight: 650; cursor: pointer; }
    .settings-save:disabled { opacity: 0.55; cursor: default; }
    .settings-status { color: #64748b; font-size: 0.8rem; }
    .settings-status.error { color: #f87171; }

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
    .install-table-wrap { overflow: visible; }
    .install-list-header { display: grid; grid-template-columns: 18px minmax(0, 1fr) 7rem 8rem; gap: 1.25rem; align-items: center; padding: 0 0.9rem 0.55rem; color: #64748b; font-size: 0.68rem; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
    .install-sort-btn { appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; letter-spacing: inherit; text-transform: inherit; padding: 0; text-align: right; }
    .install-sort-btn:hover, .install-sort-btn.active { color: #67e8f9; }
    .install-table, .install-table tbody { display: block; width: 100%; }
    .install-table thead, .install-table colgroup { display: none; }
    .install-table tbody { display: grid; gap: 0.6rem; }
    .install-table tbody tr.install-data-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) 7rem 8rem; grid-template-areas: 'chevron install version seen'; align-items: center; gap: 1.25rem; cursor: pointer; background: #111822; border: 1px solid #21293a; border-radius: 8px; padding: 0.8rem 0.9rem; }
    .install-table tbody tr.install-data-row:hover, .install-table tbody tr.row-expanded { border-color: rgba(34,211,238,0.45); background: rgba(34,211,238,0.04); }
    .install-table td { padding: 0; border: 0; min-width: 0; font-size: 0.82rem; color: #cbd5e1; }
    .install-table td.col-chevron { grid-area: chevron; color: #64748b; font-size: 0.65rem; }
    .install-table td.col-installid { grid-area: install; }
    .install-table td.col-version { grid-area: version; color: #67e8f9; text-align: right; }
    .install-table td.col-lastseen { grid-area: seen; color: #94a3b8; text-align: right; }
    .install-table td.col-os, .install-table td.col-arch, .install-table td.col-firstseen { display: none; }
    .install-table tbody tr.install-detail-row { display: block; }
    .install-table tbody tr.install-detail-row > td { display: block; padding: 0; cursor: default; }
    .install-id-cell { font-family: monospace; font-size: 0.85rem; color: #22d3ee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .install-detail-panel { background: #161d28; border-top: 1px solid #293244; padding: 0.9rem; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
    .detail-field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; padding: 0.65rem 0.7rem; background: #111822; border: 1px solid #263244; border-radius: 6px; }
    .detail-field--wide { grid-column: 1 / -1; }
    .detail-key { font-size: 0.67rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
    .detail-val { font-size: 0.84rem; color: #e2e8f0; overflow-wrap: anywhere; }
    .detail-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; color: #67e8f9; }
    @media (max-width: 540px) { .detail-grid { grid-template-columns: 1fr; } .detail-field--wide { grid-column: auto; } }
    @media (max-width: 640px) {
      .install-list-header, .install-table tbody tr.install-data-row { grid-template-columns: 16px minmax(0, 1fr) 4.25rem 4.75rem; gap: 0.5rem; padding-left: 0.7rem; padding-right: 0.7rem; }
    }
    .empty-row { font-size: 0.85rem; color: #64748b; padding: 1rem 0.6rem; }
    .pagination { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0 0; justify-content: center; }
    .pagination-btn { display: inline-flex; align-items: center; background: transparent; border: 1px solid #21293a; color: #64748b; border-radius: 20px; padding: 0.3rem 0.75rem; font-size: 0.82rem; cursor: pointer; }
    .pagination-btn:hover:not([disabled]) { border-color: #475569; color: #e2e8f0; }
    .pagination-btn[disabled] { opacity: 0.4; cursor: default; }
    .pagination-info { font-size: 0.82rem; color: #64748b; }
    @media (max-width: 640px) { .install-list-header { grid-template-columns: 18px minmax(0, 1fr) auto; } .install-list-header .version-header { display: none; } .install-table tbody tr.install-data-row { grid-template-columns: 18px minmax(0, 1fr) auto; grid-template-areas: 'chevron install seen' 'chevron version version'; } }
    .dev-badge {
      display: inline-flex; align-items: center;
      background: rgba(251,191,36,0.12); border: 1px solid rgba(251,191,36,0.3);
      color: #fbbf24; border-radius: 20px; padding: 0.1rem 0.45rem;
      font-size: 0.7rem; font-weight: 600; margin-left: 0.35rem; vertical-align: middle;
    }
    @media (max-width: 800px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid #21293a; padding: 0.9rem 1rem; gap: 0.9rem; }
      .sidebar-section-label { display: none; }
      .sidebar-logo { padding: 0; }
      .sidebar-controls { padding: 0; }
      .sidebar-controls .pill-btn { width: auto; }
      .project-nav { display: flex; overflow-x: auto; }
      .project-nav-item { width: auto; white-space: nowrap; }
      .content-header { padding: 1rem 1.25rem; }
      main { padding: 1.25rem; }
    }
    @media (max-width: 520px) { .content-header { align-items: flex-start; } .page-subtitle { display: none; } }
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

<div id="dashboard-page" style="display:none" class="app-shell">
  <aside class="sidebar">
    <div class="sidebar-logo">
      <span class="logo-dot"></span>
      <span class="logo-text">beacon</span>
    </div>
    <div class="sidebar-controls">
      <button class="pill-btn" id="dev-toggle"></button>
    </div>
    <nav class="project-nav overview-nav">
      <button class="project-nav-item" id="overview-nav-item">
        <i class="ti ti-layout-dashboard project-nav-icon"></i>All projects
      </button>
    </nav>
    <div>
      <div class="sidebar-section-label">Projects</div>
      <nav class="project-nav" id="project-nav"></nav>
    </div>
  </aside>

  <div class="content">
    <header class="content-header">
      <div>
        <div class="page-title" id="project-heading">Nestview</div>
        <div class="page-subtitle" id="project-subtitle">Installation telemetry and project health</div>
      </div>
      <div class="header-actions">
        <span class="pill-badge">Live data</span>
      </div>
    </header>
    <main>
    <section id="overview-page" hidden>
      <p class="overview-intro">A live readout of every project reporting to Beacon.</p>
      <div class="overview-grid" id="overview-grid"></div>
    </section>
    <div id="project-dashboard">
    <div id="project-overview-content">
    <div class="stat-cards">
      <div class="stat-card" data-filter="recent">
        <div class="stat-value" id="stat-active">-</div>
        <div class="stat-label">Seen this week</div>
      </div>
      <div class="stat-card" data-filter="inactive">
        <div class="stat-value" id="stat-retained">-</div>
        <div class="stat-label">Inactive 7–30d</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-total">-</div>
        <div class="stat-label">All-time installs</div>
      </div>
      <div class="stat-card" data-filter="new_week">
        <div class="stat-value stat-value--new" id="stat-new">-</div>
        <div class="stat-label">New this week</div>
      </div>
    </div>

    <section class="project-health">
      <div class="project-health-header">
        <span class="project-health-title">Project health</span>
        <span class="project-health-note" id="project-health-note"></span>
      </div>
      <div class="project-health-grid" id="project-health-grid"></div>
    </section>

    <div class="breakdown-wrap">
      <div class="breakdown-wrap-header">
        <span class="breakdown-wrap-title">What’s running</span>
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
        <div class="breakdown-card" id="breakdown-project-stats-card" hidden>
          <div class="breakdown-title">Library Size</div>
          <div id="breakdown-project-stats"></div>
        </div>
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
            <button class="fs-btn fs-btn--active" data-filter-opt="all">Reporting (30d)</button>
            <button class="fs-btn" data-filter-opt="recent">Seen this week</button>
            <button class="fs-btn" data-filter-opt="new_week">New this week</button>
            <button class="fs-btn" data-filter-opt="inactive">Inactive 7–30d</button>
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
        <div class="install-list-header" id="install-list-header">
          <span></span><span>Install</span>
          <button class="install-sort-btn version-header" data-sort="version">Version</button>
          <button class="install-sort-btn" data-sort="last_seen">Last seen</button>
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
    <section id="settings-section" hidden>
      <div class="settings-card">
        <div class="settings-card-title">Project settings</div>
        <p class="settings-card-note">Choose how this project appears throughout Beacon. Telemetry stays tied to its original project ID.</p>
        <form id="project-settings-form">
          <label class="settings-field">
            <span class="settings-label">Friendly name</span>
            <input class="settings-input" id="project-display-name" maxlength="64" required>
          </label>
          <div class="settings-field">
            <span class="settings-label">Sidebar icon</span>
            <div class="icon-picker" id="project-icon-picker"></div>
          </div>
          <div class="settings-actions">
            <button class="settings-save" id="project-settings-save" type="submit">Save changes</button>
            <span class="settings-status" id="project-settings-status" aria-live="polite"></span>
          </div>
        </form>
      </div>
    </section>
    </div>
    </main>
  </div>
</div>

<script>
(function () {
  var token = sessionStorage.getItem('beacon_token');
  var allInstalls = [];
  var summary = {};
  var summaryExcludeDev = {};
  var projectSummaries = {};
  var projectSettings = {};
  var availableProjects = [];
  var selectedProject = localStorage.getItem('beacon_project') || 'nestview';
  var selectedView = localStorage.getItem('beacon_view') || 'overview';
  var projectPage = localStorage.getItem('beacon_project_page') || 'overview';
  var excludeDev = localStorage.getItem('beacon_exclude_dev') !== 'false';
  var cardFilter = 'all';
  var detailFilters = { version: null, arch: null, os: null, channel: null };
  var expandedInstallId = null;
  var currentPage = 1;
  var pageSize = 10;
  var currentFiltered = [];
  var sortCol = 'first_seen';
  var sortDir = 'desc';

  var RECENT_MS = 7 * 24 * 3600000;
  var MIN_COL_WIDTH = 48;
  var projectProfiles = {
    nestview: {
      detailFields: [
        ['container_count', 'Containers']
      ]
    },
    prism: {
      breakdownTitle: 'Library Size',
      breakdownFields: [
        ['artist_count', 'Artists'],
        ['album_count', 'Albums'],
        ['song_count', 'Songs']
      ],
      detailFields: [
        ['artist_count', 'artist_count'],
        ['album_count', 'album_count'],
        ['song_count', 'song_count']
      ]
    }
  };
  var projectIconChoices = [
    'ti-chart-dots-3', 'ti-box', 'ti-device-desktop', 'ti-music',
    'ti-server', 'ti-radio', 'ti-code', 'ti-app-window'
  ];

  function projectProfile() {
    return projectProfiles[selectedProject] || null;
  }

  function isActiveAt(install, refTime) {
    return refTime - new Date(install.last_seen).getTime() <= RECENT_MS;
  }
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
      return Date.now() - new Date(firstSeen).getTime() <= RECENT_MS;
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

  function projectLabel(project) {
    var settings = projectSettings[project];
    return (settings && settings.display_name) || project || 'unknown';
  }

  function projectIcon(project) {
    var settings = projectSettings[project];
    return (settings && settings.icon) || 'ti-chart-dots-3';
  }

  // ---- Auth ----

  function showLogin() {
    el('login-page').style.display = 'flex';
    el('dashboard-page').style.display = 'none';
  }
  function showDashboard() {
    el('login-page').style.display = 'none';
    el('dashboard-page').style.display = 'grid';
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
    fetch('/projects', { headers: authHeaders }).then(function (response) {
      if (!response.ok) {
        sessionStorage.removeItem('beacon_token'); showLogin(); return null;
      }
      return response.json();
    }).then(function (data) {
      if (!data) return;
      var projectRows = data.projects || [];
      var projects = projectRows.map(function (row) {
        return typeof row === 'string' ? row : row.project;
      }).filter(Boolean);
      projectSettings = {};
      projectRows.forEach(function (row) {
        if (typeof row !== 'string' && row.project) {
          projectSettings[row.project] = { display_name: row.display_name || null, icon: row.icon || null };
        }
      });
      availableProjects = projects;
      if (projects.length && projects.indexOf(selectedProject) < 0) {
        selectedProject = projects.indexOf('nestview') >= 0 ? 'nestview' : projects[0];
        localStorage.setItem('beacon_project', selectedProject);
      }
      renderProjectPicker(projects);
      if (selectedView === 'overview') {
        return Promise.all(projects.map(function (project) {
          var projectParam = encodeURIComponent(project);
          return Promise.all([
            fetch('/summary?project=' + projectParam, { headers: authHeaders }),
            fetch('/summary?project=' + projectParam + '&exclude_dev=true', { headers: authHeaders })
          ]);
        })).then(function (responseGroups) {
          var responses = responseGroups.flat();
          if (responses.some(function (response) { return !response.ok; })) return null;
          return Promise.all(responseGroups.map(function (group) {
            return Promise.all([group[0].json(), group[1].json()]);
          })).then(function (summaries) { return { overview: true, projects: projects, summaries: summaries }; });
        });
      }
      var projectParam = encodeURIComponent(selectedProject);
      return Promise.all([
        fetch('/installs?project=' + projectParam, { headers: authHeaders }),
        fetch('/summary?project=' + projectParam, { headers: authHeaders }),
        fetch('/summary?project=' + projectParam + '&exclude_dev=true', { headers: authHeaders })
      ]);
    }).then(function (responses) {
      if (!responses) return null;
      if (responses.overview) return responses;
      if (!responses[0].ok || !responses[1].ok || !responses[2].ok) {
        sessionStorage.removeItem('beacon_token'); showLogin(); return null;
      }
      return Promise.all([responses[0].json(), responses[1].json(), responses[2].json()])
        .then(function (results) { return { overview: false, results: results }; });
    }).then(function (data) {
      if (!data) return;
      if (data.overview) {
        projectSummaries = {};
        data.projects.forEach(function (project, index) {
          projectSummaries[project] = { all: data.summaries[index][0] || {}, excludeDev: data.summaries[index][1] || {} };
        });
      } else {
        allInstalls = data.results[0].installs || [];
        summary = data.results[1] || {};
        summaryExcludeDev = data.results[2] || {};
      }
      render();
    }).catch(function () { sessionStorage.removeItem('beacon_token'); showLogin(); });
  }

  // ---- Render ----

  function render() {
    renderDevToggle();
    if (selectedView === 'overview') {
      renderOverview();
      return;
    }
    el('overview-page').hidden = true;
    el('project-dashboard').hidden = false;
    var showingInstalls = projectPage === 'installs';
    var showingSettings = projectPage === 'settings';
    el('project-heading').textContent = projectLabel(selectedProject);
    el('project-subtitle').textContent = showingSettings ? 'Display settings for this project' : (showingInstalls ? 'Installation details and reporting history' : 'Installation telemetry and project health');
    el('project-overview-content').hidden = showingInstalls || showingSettings;
    el('details-section').hidden = !showingInstalls;
    el('settings-section').hidden = !showingSettings;
    if (showingInstalls) {
      renderInstallDetails();
      renderFilterSelector();
    } else if (showingSettings) {
      renderProjectSettings();
    } else {
      renderStatCards();
      renderProjectHealth();
      renderBreakdowns();
    }
  }

  function renderDevToggle() {
    var btn = el('dev-toggle');
    btn.textContent = excludeDev ? 'Excluding dev' : 'All installs';
  }

  function renderProjectPicker(projects) {
    var available = projects.length ? projects : ['nestview'];
    el('overview-nav-item').classList.toggle('active', selectedView === 'overview');
    el('overview-nav-item').onclick = function () {
      selectedView = 'overview';
      localStorage.setItem('beacon_view', selectedView);
      loadData(token);
    };
    el('project-nav').innerHTML = available.map(function (project) {
      var active = selectedView === 'project' && project === selectedProject ? ' active' : '';
      var expanded = selectedView === 'project' && project === selectedProject;
      return '<div class="project-nav-group"><button class="project-nav-item' + active + '" data-project="' + esc(project) + '">' +
        '<i class="ti ' + esc(projectIcon(project)) + ' project-nav-icon"></i>' + esc(projectLabel(project)) +
        '<i class="ti ti-chevron-' + (expanded ? 'down' : 'right') + ' project-nav-chevron"></i></button>' +
        (expanded ? '<div class="project-subnav">' +
          '<button class="project-subnav-item' + (projectPage === 'overview' ? ' active' : '') + '" data-project="' + esc(project) + '" data-page="overview">Overview</button>' +
          '<button class="project-subnav-item' + (projectPage === 'installs' ? ' active' : '') + '" data-project="' + esc(project) + '" data-page="installs">Installs</button>' +
          '<button class="project-subnav-item' + (projectPage === 'settings' ? ' active' : '') + '" data-project="' + esc(project) + '" data-page="settings">Settings</button>' +
        '</div>' : '') + '</div>';
    }).join('');

    el('project-nav').querySelectorAll('.project-nav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        selectedProject = item.dataset.project || 'nestview';
        selectedView = 'project';
        projectPage = 'overview';
        localStorage.setItem('beacon_project', selectedProject);
        localStorage.setItem('beacon_view', selectedView);
        localStorage.setItem('beacon_project_page', projectPage);
        cardFilter = 'all';
        detailFilters = { version: null, arch: null, os: null, channel: null };
        expandedInstallId = null;
        currentPage = 1;
        closeDropdowns();
        loadData(token);
      });
    });
    el('project-nav').querySelectorAll('.project-subnav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        selectedProject = item.dataset.project || 'nestview';
        selectedView = 'project';
        projectPage = item.dataset.page || 'overview';
        localStorage.setItem('beacon_project', selectedProject);
        localStorage.setItem('beacon_view', selectedView);
        localStorage.setItem('beacon_project_page', projectPage);
        loadData(token);
      });
    });
  }

  function renderOverview() {
    el('overview-page').hidden = false;
    el('project-dashboard').hidden = true;
    el('project-heading').textContent = 'All projects';
    el('project-subtitle').textContent = 'Installation telemetry across your apps';
    var projects = Object.keys(projectSummaries).sort();
    el('overview-grid').innerHTML = projects.length ? projects.map(function (project) {
      var stats = projectSummaries[project][excludeDev ? 'excludeDev' : 'all'] || {};
      var active = Number(stats.active_week || 0);
      var total = Number(stats.total || 0);
      return '<button class="overview-card" data-project="' + esc(project) + '">' +
        '<div class="overview-card-header"><span class="overview-card-title"><i class="ti ' + esc(projectIcon(project)) + ' project-nav-icon"></i> ' + esc(projectLabel(project)) + '</span>' +
        '<span class="overview-status' + (active ? '' : ' quiet') + '">' + (active ? 'Seen this week' : 'No recent check-ins') + '</span></div>' +
        '<div class="overview-stats"><div><div class="overview-value">' + active.toLocaleString() + '</div><div class="overview-label">Seen this week</div></div>' +
        '<div><div class="overview-value">' + total.toLocaleString() + '</div><div class="overview-label">All-time installs</div></div></div></button>';
    }).join('') : '<span class="empty-text">No projects have reported telemetry yet.</span>';
    el('overview-grid').querySelectorAll('.overview-card').forEach(function (card) {
      card.addEventListener('click', function () {
        selectedProject = card.dataset.project || 'nestview';
        selectedView = 'project';
        projectPage = 'overview';
        localStorage.setItem('beacon_project', selectedProject);
        localStorage.setItem('beacon_view', selectedView);
        localStorage.setItem('beacon_project_page', projectPage);
        loadData(token);
      });
    });
  }

  function renderProjectSettings() {
    var settings = projectSettings[selectedProject] || {};
    var selectedIcon = settings.icon || 'ti-chart-dots-3';
    el('project-display-name').value = settings.display_name || selectedProject;
    el('project-icon-picker').innerHTML = projectIconChoices.map(function (icon) {
      return '<button class="icon-choice' + (icon === selectedIcon ? ' active' : '') + '" type="button" data-icon="' + icon + '" aria-label="Choose icon"><i class="ti ' + icon + '"></i></button>';
    }).join('');

    el('project-icon-picker').querySelectorAll('.icon-choice').forEach(function (button) {
      button.addEventListener('click', function () {
        selectedIcon = button.dataset.icon || 'ti-chart-dots-3';
        el('project-icon-picker').querySelectorAll('.icon-choice').forEach(function (item) {
          item.classList.toggle('active', item === button);
        });
      });
    });

    el('project-settings-form').onsubmit = function (event) {
      event.preventDefault();
      var saveButton = el('project-settings-save');
      var status = el('project-settings-status');
      var displayName = el('project-display-name').value.trim();
      if (!displayName) {
        status.textContent = 'Enter a friendly name.';
        status.classList.add('error');
        return;
      }
      saveButton.disabled = true;
      status.textContent = 'Saving...';
      status.classList.remove('error');
      fetch('/project-settings', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: selectedProject, display_name: displayName, icon: selectedIcon })
      }).then(function (response) {
        if (!response.ok) throw new Error('Unable to save settings');
        return response.json();
      }).then(function (saved) {
        projectSettings[selectedProject] = { display_name: saved.display_name, icon: saved.icon };
        renderProjectPicker(availableProjects);
        render();
        status.textContent = 'Saved.';
      }).catch(function () {
        status.textContent = 'Could not save changes. Try again.';
        status.classList.add('error');
      }).finally(function () {
        saveButton.disabled = false;
      });
    };
  }

  function renderFilterSelector() {
    var active = cardFilter || 'all';
    document.querySelectorAll('#filter-selector .fs-btn').forEach(function (btn) {
      btn.classList.toggle('fs-btn--active', btn.dataset.filterOpt === active);
    });
  }

  function renderStatCards() {
    var now = Date.now();
    var activeCount = 0, staleCount = 0, newTodayCount = 0;
    var counted = excludeDev ? allInstalls.filter(function (i) { return !i.is_dev; }) : allInstalls;
    var selectedSummary = excludeDev ? summaryExcludeDev : summary;
    counted.forEach(function (i) {
      if (isActiveAt(i, now)) activeCount++;
      else staleCount++;
      if (isNewToday(i.first_seen)) newTodayCount++;
    });
    el('stat-active').textContent = activeCount.toLocaleString();
    el('stat-retained').textContent = staleCount.toLocaleString();
    el('stat-total').textContent = (selectedSummary.total ?? counted.length).toLocaleString();
    el('stat-new').textContent = newTodayCount.toLocaleString();
    document.querySelectorAll('.stat-card').forEach(function (card) {
      card.classList.toggle('stat-card--active', card.dataset.filter === cardFilter);
    });
  }

  function renderProjectHealth() {
    var source = excludeDev ? allInstalls.filter(function (i) { return !i.is_dev; }) : allInstalls.slice();
    var active = source.filter(function (i) { return isActiveAt(i, Date.now()); });
    var latest = source.slice().sort(function (a, b) {
      return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
    })[0];
    var latestVersion = latest && latest.version ? latest.version : '—';
    var latestCheckIn = latest && latest.last_seen ? relTime(latest.last_seen) : 'No check-ins';
    var latestTitle = latest && latest.last_seen ? fmtDate(latest.last_seen) : '';

    el('project-health-note').textContent = source.length ? (excludeDev ? 'Production telemetry' : 'All telemetry') : 'No telemetry yet';
    el('project-health-grid').innerHTML =
      '<div class="health-item"><div class="health-value health-value--good" title="' + esc(latestTitle) + '">' + esc(latestCheckIn) + '</div><div class="health-label">Latest check-in</div></div>' +
      '<div class="health-item"><div class="health-value" title="Latest reporting install">' + esc(latestVersion) + '</div><div class="health-label">Latest version</div></div>' +
      '<div class="health-item"><div class="health-value">' + active.length.toLocaleString() + ' / ' + source.length.toLocaleString() + '</div><div class="health-label">Seen this week / reporting installs</div></div>';
  }

  function renderChart() {
    var windowLabel = windowDays === 1 ? 'last 24h' : 'last ' + windowDays + 'd';
    var cardLabel = cardFilter === 'all' ? 'Seen 30d'
      : cardFilter === 'stale' ? 'Quiet 36h+'
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
            if (hEndMs - ls <= ACTIVE_MS) cnt++;
          }
        }
        var hh = new Date(hStartMs).getUTCHours();
        labels.push((hh < 10 ? '0' : '') + hh + ':00');
        chartData.push(cnt);
      }
    } else if (cardFilter === 'all') {
      var projectHistory = allHistory[selectedProject] || [];
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
            if (dayEndMs - ls <= ACTIVE_MS) cnt++;
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

    var tooltipNoun = cardFilter === 'stale' ? 'quiet' : 'installs';

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
    var now = Date.now();
    var source = excludeDev ? allInstalls.filter(function (i) { return !i.is_dev; }) : allInstalls;
    var active = source.filter(function (i) { return isActiveAt(i, now); });
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
    renderProjectStats(active);
  }

  function renderProjectStats(installs) {
    var profile = projectProfile();
    var card = el('breakdown-project-stats-card');
    var container = el('breakdown-project-stats');
    card.hidden = !profile || !profile.breakdownFields;
    if (!profile || !profile.breakdownFields) {
      container.innerHTML = '';
      return;
    }

    card.querySelector('.breakdown-title').textContent = profile.breakdownTitle;
    var fields = profile.breakdownFields;
    var rows = fields.map(function (field) {
      var values = installs
        .map(function (i) { return i[field[0]]; })
        .filter(function (v) { return typeof v === 'number' && isFinite(v); });
      if (values.length === 0) return null;
      var avg = Math.round(values.reduce(function (sum, v) { return sum + v; }, 0) / values.length);
      return '<span class="running-tag"><span class="running-tag-label">' + esc(field[1]) + '</span><span class="running-tag-count">' + avg.toLocaleString() + '</span></span>';
    }).filter(Boolean);
    container.innerHTML = rows.length ? '<div class="running-tags">' + rows.join('') + '</div>' : '<span class="empty-text">No data</span>';
  }

  function renderDist(containerId, dist, total, sortByVersion) {
    var container = el(containerId);
    var entries = Object.keys(dist).map(function (k) { return [k, dist[k]]; });
    if (sortByVersion) entries.sort(function (a, b) { return semverSort(a[0], b[0]); });
    else entries.sort(function (a, b) { return b[1] - a[1]; });
    if (entries.length === 0) { container.innerHTML = '<span class="empty-text">No data</span>'; return; }
    container.innerHTML = '<div class="running-tags">' + entries.map(function (pair) {
      return '<span class="running-tag" title="' + esc(pair[0]) + '"><span class="running-tag-label">' + esc(pair[0]) + '</span><span class="running-tag-count">' + pair[1] + '</span></span>';
    }).join('') + '</div>';
  }

  function renderInstallDetails() {
    var now = Date.now();
    var source = excludeDev ? allInstalls.filter(function (i) { return !i.is_dev; }) : allInstalls;
    var base;
    if (cardFilter === 'recent') {
      base = source.filter(function (i) { return isActiveAt(i, now); });
    } else if (cardFilter === 'inactive') {
      base = source.filter(function (i) { return !isActiveAt(i, now); });
    } else if (cardFilter === 'new_week') {
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
    el('install-list-header').querySelectorAll('[data-sort]').forEach(function (button) {
      var key = button.dataset.sort;
      var label = key === 'last_seen' ? 'Last seen' : 'Version';
      button.textContent = label + (sortCol === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
      button.classList.toggle('active', sortCol === key);
      button.onclick = function () {
        if (sortCol === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortCol = key; sortDir = key === 'last_seen' ? 'desc' : 'asc'; }
        currentPage = 1;
        renderInstallTable(currentFiltered);
      };
    });

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
        var profile = projectProfile();
        var projectDetailFields = profile ? profile.detailFields.map(function (field) {
          var value = i[field[0]];
          return '<div class="detail-field"><span class="detail-key">' + esc(field[1]) + '</span><span class="detail-val">' +
            (value != null ? (typeof value === 'number' ? value.toLocaleString() : esc(value)) : '-') +
            '</span></div>';
        }).join('') : '';
        detailRow = '<tr class="install-detail-row"><td colspan="7"><div class="install-detail-panel"><div class="detail-grid">' +
          '<div class="detail-field detail-field--wide"><span class="detail-key">Install ID</span><span class="detail-val detail-mono">' + esc(i.install_id || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">Version</span><span class="detail-val">' + esc(i.version || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">Architecture</span><span class="detail-val">' + esc(i.arch || '') + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">Operating system</span><span class="detail-val">' + esc(osLabel) + '</span></div>' +
          projectDetailFields +
          '<div class="detail-field"><span class="detail-key">First seen</span><span class="detail-val">' + esc(fmtDate(i.first_seen)) + '</span></div>' +
          '<div class="detail-field"><span class="detail-key">Last seen</span><span class="detail-val">' + esc(fmtDate(i.last_seen)) + '</span></div>' +
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
      projectPage = 'installs';
      localStorage.setItem('beacon_project_page', projectPage);
      document.querySelectorAll('.project-subnav-item').forEach(function (item) {
        item.classList.toggle('active', item.dataset.page === 'installs');
      });
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
