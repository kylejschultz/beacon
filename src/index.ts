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
    `INSERT INTO installs (project, install_id, version, arch, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project, install_id) DO UPDATE SET
       version   = excluded.version,
       arch      = excluded.arch,
       last_seen = excluded.last_seen`
  )
    .bind(project, install_id, version, arch, timestamp)
    .run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryKey = url.searchParams.get("key");
  const providedSecret = bearerToken ?? queryKey;

  if (!providedSecret || providedSecret !== env.STATS_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const windowStart = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // last_seen stored as UTC — convert to America/Los_Angeles for display in dashboard
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

  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryKey = url.searchParams.get("key");
  const providedSecret = bearerToken ?? queryKey;

  if (!providedSecret || providedSecret !== env.STATS_SECRET) {
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
