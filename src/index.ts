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

    return new Response("Not Found", { status: 404 });
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
