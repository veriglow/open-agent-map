/**
 * Open Agent Map — Cloudflare Worker
 *
 * Handles routing for agentmap.veri-glow.com:
 * 1. Accepts any URL path (mirroring original website URLs)
 * 2. Looks up the corresponding .json spec from GitHub Pages
 * 3. Returns HTML for browsers, JSON for agents
 * 4. Shows "request map" page on 404
 */

const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com/ChizhongWang/open-agent-map/main";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Request-map API
    if (path === "/api/request-map") {
      if (request.method === "POST") {
        return handleRequestMap(request, env, ctx);
      }
      if (request.method === "GET") {
        return listRequestMaps(env);
      }
    }

    // Root path — serve homepage
    if (path === "/" || path === "") {
      return serveHomepage(request);
    }


    // Strip trailing slash
    if (path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    // Strip common web suffixes that won't match our .json files
    path = path.replace(/\/index\.(s?html?|shtml)$/, "");

    // If already requesting .json, always return raw JSON (skip content negotiation)
    if (path.endsWith(".json")) {
      const specUrl = GITHUB_RAW_ORIGIN + path;
      const specResp = await fetch(specUrl, {
        headers: { "User-Agent": "Open-Agent-Map-Worker/1.0" },
        cf: { cacheTtl: 300 },
      });
      if (!specResp.ok) {
        return serve404(request, path);
      }
      return new Response(specResp.body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // Try fetching path + .json from GitHub Pages
    const specResp = await fetchAndServe(request, path + ".json");
    if (specResp.status !== 404) {
      return specResp;
    }

    // No exact match — try serving as a directory listing
    return serveDirectoryListing(request, path);
  },
};

async function fetchAndServe(request, jsonPath) {
  const specUrl = GITHUB_RAW_ORIGIN + jsonPath;

  try {
    const specResp = await fetch(specUrl, {
      headers: { "User-Agent": "Open-Agent-Map-Worker/1.0" },
      cf: { cacheTtl: 300 },
    });

    if (!specResp.ok) {
      return serve404(request, jsonPath);
    }

    const specJson = await specResp.text();
    let spec;
    try {
      spec = JSON.parse(specJson);
    } catch {
      return serve404(request, jsonPath);
    }

    // Content negotiation
    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html") && !accept.includes("application/json")) {
      return serveHTML(spec, jsonPath);
    }

    // Return JSON for agents
    return new Response(specJson, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function serveHTML(spec, jsonPath) {
  const html = renderSpecPage(spec, jsonPath);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function serve404(request, jsonPath) {
  const accept = request.headers.get("Accept") || "";
  const path = jsonPath.replace(".json", "");

  if (accept.includes("text/html")) {
    return new Response(render404Page(path), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(
    JSON.stringify({
      error: "map_not_found",
      path: path,
      message: "No agent map found for this URL.",
      report: {
        method: "POST",
        url: "https://agentmap.veri-glow.com/api/request-map",
        body: { path: path, type: "missing", user_query: "<what the user asked>" },
        note: "Report this missing URL so the team can prioritize adding it. Use type: 'incomplete' if map exists but data is missing, 'incorrect' if data is wrong.",
      },
    }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}


// ── Request Map API ──────────────────────────────────────────

async function handleRequestMap(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const path = (body.path || "").trim();
  if (!path) {
    return jsonResponse({ error: "Missing 'path' field" }, 400);
  }

  // Issue type: missing (URL not indexed), incomplete (map exists but data missing),
  // incorrect (map data is wrong), other
  const issueType = (body.type || "missing").trim();
  const detail = (body.detail || "").trim();
  const email = (body.email || "").trim();
  const userQuery = (body.user_query || "").trim();
  const now = new Date().toISOString();

  // Read existing record from KV (if any)
  const kvKey = `request:${path}`;
  let record = null;
  if (env.MAP_REQUESTS) {
    try {
      const existing = await env.MAP_REQUESTS.get(kvKey, "json");
      if (existing) record = existing;
    } catch {}
  }

  if (record) {
    record.request_count += 1;
    record.last_seen = now;
    if (email && !record.emails.includes(email)) record.emails.push(email);
    if (userQuery && !record.queries.includes(userQuery)) record.queries.push(userQuery);
    if (detail && !record.details.includes(detail)) record.details.push(detail);
    // Upgrade type: incomplete/incorrect take priority over missing
    if (issueType !== "missing") record.type = issueType;
  } else {
    record = {
      path,
      type: issueType,
      request_count: 1,
      emails: email ? [email] : [],
      queries: userQuery ? [userQuery] : [],
      details: detail ? [detail] : [],
      first_seen: now,
      last_seen: now,
    };
  }

  // Store in KV
  if (env.MAP_REQUESTS) {
    await env.MAP_REQUESTS.put(kvKey, JSON.stringify(record));
  }

  // Webhook notification (fire-and-forget)
  const typeLabels = { missing: "🆕 未收录", incomplete: "⚠️ 信息不完整", incorrect: "❌ 信息有误", other: "📋 其他" };
  const typeLabel = typeLabels[issueType] || issueType;
  const webhookUrl = env.FEISHU_WEBHOOK || env.SLACK_WEBHOOK || "";
  if (webhookUrl) {
    const msg = `🗺️ AgentMap 问题上报\n类型: ${typeLabel}\nURL: ${path}\n${detail ? "详情: " + detail + "\n" : ""}查询: ${userQuery || "(none)"}\n累计: ${record.request_count}`;
    try {
      const isFeishu = webhookUrl.includes("feishu.cn");
      const payload = isFeishu
        ? { msg_type: "text", content: { text: msg } }
        : { text: msg };
      const webhookPromise = fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(webhookPromise);
      }
    } catch {}
  }

  return jsonResponse({ status: "ok", path, type: issueType, total_requests: record.request_count });
}

async function listRequestMaps(env) {
  if (!env.MAP_REQUESTS) {
    return jsonResponse({ error: "KV not configured", requests: [] });
  }

  const list = await env.MAP_REQUESTS.list({ prefix: "request:" });
  const requests = [];

  for (const key of list.keys) {
    try {
      const record = await env.MAP_REQUESTS.get(key.name, "json");
      if (record) requests.push(record);
    } catch {}
  }

  // Sort by request_count descending
  requests.sort((a, b) => b.request_count - a.request_count);
  return jsonResponse({ total: requests.length, requests });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}


// ── Brand Components ──────────────────────────────────────────

const BRAND_FONTS = `<link rel="icon" href="https://brand.veri-glow.com/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@700&family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">`;

const BRAND_LOGO_SVG = `<svg viewBox="-6 -6 112 104" xmlns="http://www.w3.org/2000/svg" style="width:24px;height:24px">
  <path d="M 42.0,0.13 L 77.3,65.6 L 38.1,65.6 L 30.6,79.7 L 100,79.7 L 57.6,0 Z" fill="none" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 42.0,0.13 L 0,79.6 L 7.8,94.1 L 42.5,28.3 L 61.9,65.6 L 77.3,65.6 Z" fill="none" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 42.5,28.3 L 50.2,43.1 L 30.6,79.7 L 100,79.7 L 92.7,94.5 L 7.8,94.1 Z" fill="none" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 42.0,0.13 L 49.77,14.54 L 42.5,28.3 L 34.73,13.89 Z" fill="#10B981" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 42.0,0.13 L 57.6,0 L 65.27,14.41 L 49.77,14.54 Z" fill="#10B981" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 100,79.7 L 92.7,94.5 L 78.28,94.43 L 92.50,65.60 Z" fill="#10B981" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 100,79.7 L 92.50,65.60 L 77.3,65.6 L 84.80,79.70 Z" fill="#10B981" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 7.8,94.1 L 0,79.6 L 7.64,65.14 L 15.43,79.63 Z" fill="#10B981" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 7.8,94.1 L 15.43,79.63 L 30.6,79.7 L 22.97,94.17 Z" fill="#10B981" stroke="#10B981" stroke-width="3" stroke-linejoin="round"/>
</svg>`;

const BRAND_NAV = `<nav style="position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid #e5e7eb;height:56px;display:flex;align-items:center;padding:0 32px;">
  <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;">
    ${BRAND_LOGO_SVG}
    <span style="font-family:'Crimson Pro',Georgia,serif;font-weight:700;font-size:16px;letter-spacing:0.02em;line-height:1;"><span style="color:#94A3B8;">Veri</span><span style="color:#10B981;">Glow</span></span>
  </a>
  <span style="margin-left:8px;font-size:13px;color:#9CA3AF;font-family:'DM Sans',sans-serif;">Agent Map</span>
  <span style="margin-left:auto;"><a href="https://github.com/ChizhongWang/open-agent-map" target="_blank" style="color:#6B7280;text-decoration:none;font-size:13px;font-family:'DM Sans',sans-serif;">GitHub</a></span>
</nav>`;

const BRAND_FOOTER = `<div style="margin-top:3rem;padding-top:1.5rem;border-top:1px solid #e5e7eb;font-size:0.8rem;color:#6B7280;text-align:center;font-family:'DM Sans',sans-serif;">
  <a href="/" style="color:#10B981;text-decoration:none;">VeriGlow Agent Map</a> — crowdsourced web data maps for AI agents
</div>`;

const BRAND_BASE_STYLE = `
  :root { --bg: #ffffff; --card: #f9fafb; --border: #e5e7eb; --text: #111827; --muted: #6b7280; --accent: #10B981; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'DM Sans', 'Noto Sans SC', -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }
`;

// ── HTML Renderers ──────────────────────────────────────────

function renderSpecPage(spec, jsonPath) {
  // Signpost type — self-documented sites need a different template
  if (spec.type === "signpost") {
    return renderSignpostPage(spec, jsonPath);
  }

  const title = spec.title || "Agent Map";
  const url = spec.url || "";
  const summary = spec.summary || "";
  const endpoint = spec.endpoint || "";
  const method = spec.method || "GET";
  const confidence = spec.confidence || 0;
  const lastVerified = spec.last_verified || "unknown";
  const caveats = spec.caveats || [];

  // Determine if it's a multi-API spec (like company detail)
  const isMultiApi = !!spec.apis;

  let paramsHtml = "";
  let apisHtml = "";

  if (isMultiApi) {
    // Multi-API spec
    const commonParams = spec.params_common || {};
    paramsHtml = renderParams(commonParams, "Common Parameters");
    apisHtml = Object.entries(spec.apis)
      .map(
        ([name, api]) => `
      <div class="api-block">
        <h3>${escHtml(name)}</h3>
        <div class="endpoint">${escHtml(api.method || "GET")} ${escHtml(api.endpoint || endpoint)}</div>
        <div class="detail">sqlId: <code>${escHtml(api.sqlId || "N/A")}</code></div>
        ${api.paginated ? '<span class="badge">paginated</span>' : ""}
        ${renderParams(api.params || {})}
      </div>`
      )
      .join("");
  } else {
    // Single API spec
    paramsHtml = renderParams(spec.params || {});
  }

  const confidenceColor =
    confidence >= 0.9
      ? "#22c55e"
      : confidence >= 0.8
        ? "#84cc16"
        : confidence >= 0.7
          ? "#eab308"
          : "#ef4444";
  const confidencePct = Math.round(confidence * 100);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)} — VeriGlow Agent Map</title>
${BRAND_FONTS}
<style>
  ${BRAND_BASE_STYLE}
  .container { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
  .breadcrumb { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; word-break: break-all; }
  .breadcrumb a { color: var(--accent); text-decoration: none; }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  .meta { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; font-size: 0.85rem; color: var(--muted); }
  .meta a { color: var(--accent); text-decoration: none; word-break: break-all; }
  .confidence { display: inline-flex; align-items: center; gap: 0.35rem; }
  .confidence-dot { width: 8px; height: 8px; border-radius: 50%; }
  .summary { font-size: 1rem; color: var(--muted); margin-bottom: 2rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin-bottom: 1.25rem; }
  .card h2 { font-size: 1.1rem; margin-bottom: 0.75rem; }
  .endpoint { font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace; font-size: 0.9rem; background: #f0fdf4; padding: 0.6rem 0.8rem; border-radius: 6px; margin-bottom: 0.75rem; overflow-x: auto; }
  .method { color: #10B981; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 500; }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  td:first-child { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; white-space: nowrap; }
  code { background: #f0fdf4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.8rem; font-family: 'JetBrains Mono', monospace; }
  .badge { display: inline-block; font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 3px; background: rgba(16,185,129,0.08); color: #059669; margin-left: 0.5rem; }
  .required { color: #ef4444; font-size: 0.75rem; }
  .fixed { color: #10B981; font-size: 0.75rem; }
  .caveat { color: #f59e0b; font-size: 0.85rem; padding: 0.3rem 0; }
  .api-block { padding: 1rem 0; border-bottom: 1px solid var(--border); }
  .api-block:last-child { border-bottom: none; }
  .api-block h3 { font-size: 0.95rem; margin-bottom: 0.5rem; }
  .detail { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.5rem; }
  .json-link { display: inline-block; margin-top: 1.5rem; color: var(--accent); font-size: 0.85rem; text-decoration: none; cursor: pointer; }
  .json-link:hover { text-decoration: underline; }
  .report-link { color: var(--muted); font-size: 0.8rem; margin-top: 0.5rem; }
  .report-link a { color: #f59e0b; text-decoration: none; }
  .copied { color: #10B981 !important; }
  .view-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; font-size: 0.8rem; margin-bottom: 1.5rem; }
  .view-toggle button { padding: 0.35rem 0.85rem; border: none; background: var(--card); color: var(--muted); cursor: pointer; font-family: inherit; transition: all 0.15s; }
  .view-toggle button.active { background: #10B981; color: #fff; }
  .view-toggle button:hover:not(.active) { background: var(--border); }
  .view-human { display: block; }
  .view-agent { display: none; }
  .agent-json { background: #f0fdf4; padding: 1rem; border-radius: 8px; font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; white-space: pre-wrap; word-break: break-all; overflow-x: auto; max-height: 80vh; overflow-y: auto; line-height: 1.5; }
</style>
<script>
async function copyJson(e, path) {
  e.preventDefault();
  try {
    const resp = await fetch(path, { headers: { 'Accept': 'application/json' } });
    const text = await resp.text();
    await navigator.clipboard.writeText(text);
    e.target.textContent = 'Copied!';
    e.target.classList.add('copied');
    setTimeout(() => { e.target.textContent = 'Copy raw JSON for agent'; e.target.classList.remove('copied'); }, 2000);
  } catch(err) {
    window.open(path, '_blank');
  }
}
function switchView(mode) {
  document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
  document.querySelector('.view-toggle button[data-mode="'+mode+'"]').classList.add('active');
  document.querySelector('.view-human').style.display = mode === 'human' ? 'block' : 'none';
  document.querySelector('.view-agent').style.display = mode === 'agent' ? 'block' : 'none';
}
</script>
</head>
<body>
${BRAND_NAV}
<div class="container">
  <div class="breadcrumb">
    ${renderBreadcrumbPath("/" + jsonPath.replace(".json", "").replace(/^\//, ""))}
  </div>

  <div class="view-toggle">
    <button class="active" data-mode="human" onclick="switchView('human')">Human</button>
    <button data-mode="agent" onclick="switchView('agent')">Agent</button>
  </div>

  <div class="view-agent">
    <pre class="agent-json">${escHtml(JSON.stringify(spec, null, 2))}</pre>
  </div>

  <div class="view-human">
  <h1>${escHtml(title)}</h1>

  <div class="meta">
    <a href="${escHtml(url)}" target="_blank">${escHtml(url)}</a>
    <span class="confidence">
      <span class="confidence-dot" style="background:${confidenceColor}"></span>
      ${confidencePct}% confidence
    </span>
    <span>verified: ${escHtml(lastVerified)}</span>
  </div>

  <p class="summary">${escHtml(summary)}</p>

  ${
    !isMultiApi
      ? `
  <div class="card">
    <h2>API Endpoint</h2>
    <div class="endpoint"><span class="method">${escHtml(method)}</span> ${escHtml(endpoint)}</div>
    ${paramsHtml}
  </div>`
      : `
  <div class="card">
    <h2>Common</h2>
    ${paramsHtml}
  </div>
  <div class="card">
    <h2>APIs (${Object.keys(spec.apis).length})</h2>
    ${apisHtml}
  </div>`
  }

  ${
    caveats.length
      ? `
  <div class="card">
    <h2>Notes</h2>
    ${caveats.map((c) => `<div class="caveat">⚠ ${escHtml(c)}</div>`).join("")}
  </div>`
      : ""
  }

  ${
    spec.action_steps_template
      ? `
  <div class="card">
    <h2>Action Steps Template</h2>
    <p style="font-size:0.85rem;color:var(--muted);margin-bottom:0.75rem;">${escHtml(spec.action_steps_template.description || "Browser replay steps for evidence creation.")}</p>
    <pre style="background:#f0fdf4;padding:0.75rem 1rem;border-radius:6px;font-size:0.8rem;overflow-x:auto;font-family:'JetBrains Mono',monospace;">${escHtml(JSON.stringify(spec.action_steps_template.steps, null, 2))}</pre>
    ${spec.action_steps_template.example ? `
    <p style="font-size:0.8rem;color:var(--muted);margin-top:0.75rem;margin-bottom:0.5rem;">Example (date = 2025-03-10):</p>
    <pre style="background:#f0fdf4;padding:0.75rem 1rem;border-radius:6px;font-size:0.8rem;overflow-x:auto;font-family:'JetBrains Mono',monospace;">${escHtml(JSON.stringify(spec.action_steps_template.example, null, 2))}</pre>` : ""}
  </div>`
      : ""
  }

  ${
    spec.page_table
      ? `
  <div class="card">
    <h2>Page Table Headers</h2>
    <p style="font-size:0.85rem;color:var(--muted);margin-bottom:0.75rem;">${escHtml(spec.page_table.description || "Exact table header text as shown on the web page.")}</p>
    <table>
      <tr><th>API Field</th><th>Page Header</th></tr>
      ${Object.entries(spec.page_table.api_to_header || {}).map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`).join("")}
    </table>
  </div>`
      : ""
  }

  <div class="report-link">
    Data outdated? <a href="https://github.com/ChizhongWang/open-agent-map/issues/new?title=STALE:+${encodeURIComponent(jsonPath)}" target="_blank">Report an issue</a>
  </div>

  <a class="json-link" href="#" onclick="copyJson(event, '${escHtml(jsonPath)}')">Copy raw JSON for agent</a>
  </div><!-- /view-human -->

  ${BRAND_FOOTER}
</div>
</body>
</html>`;
}

function renderSignpostPage(spec, jsonPath) {
  const name = spec.name || spec.id || "Signpost";
  const reason = spec.why_no_deep_map || "";
  const quickStart = spec.quick_start || "";
  const lastVerified = spec.last_verified || "unknown";
  const csvEndpoint = spec.csv_endpoint || {};
  const keySeries = spec.key_series || {};

  const paramsHtml = csvEndpoint.params ? Object.entries(csvEndpoint.params).map(
    ([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`
  ).join("") : "";

  const seriesHtml = Object.entries(keySeries).map(
    ([k, v]) => `<tr><td><code>${escHtml(k)}</code></td><td>${escHtml(v)}</td></tr>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(name)} — VeriGlow Agent Map</title>
${BRAND_FONTS}
<style>
  ${BRAND_BASE_STYLE}
  .container { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
  .breadcrumb { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; }
  .breadcrumb a { color: var(--accent); text-decoration: none; }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  .signpost-badge { display: inline-block; font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 4px; background: rgba(59,130,246,0.08); color: #3B82F6; font-weight: 600; margin-left: 0.75rem; vertical-align: middle; }
  .meta { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; }
  .reason { font-size: 0.95rem; color: var(--muted); margin-bottom: 2rem; padding: 1rem; background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin-bottom: 1.25rem; }
  .card h2 { font-size: 1.1rem; margin-bottom: 0.75rem; }
  .quick-start { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; background: #0C0F15; color: #E2E8F0; padding: 0.8rem 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .endpoint-pattern { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; background: #f0fdf4; padding: 0.6rem 0.8rem; border-radius: 6px; margin-bottom: 0.75rem; overflow-x: auto; word-break: break-all; }
  .auth-note { font-size: 0.8rem; color: var(--accent); margin-bottom: 0.75rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 500; }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  td:first-child { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; white-space: nowrap; }
  code { background: #f0fdf4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.8rem; font-family: 'JetBrains Mono', monospace; }
  .json-link { display: inline-block; margin-top: 1.5rem; color: var(--accent); font-size: 0.85rem; text-decoration: none; cursor: pointer; }
  .json-link:hover { text-decoration: underline; }
  .copied { color: #10B981 !important; }
</style>
<script>
async function copyJson(e, path) {
  e.preventDefault();
  try {
    const resp = await fetch(path, { headers: { 'Accept': 'application/json' } });
    const text = await resp.text();
    await navigator.clipboard.writeText(text);
    e.target.textContent = 'Copied!';
    e.target.classList.add('copied');
    setTimeout(() => { e.target.textContent = 'Copy raw JSON for agent'; e.target.classList.remove('copied'); }, 2000);
  } catch(err) { window.open(path, '_blank'); }
}
</script>
</head>
<body>
${BRAND_NAV}
<div class="container">
  <div class="breadcrumb">
    ${renderBreadcrumbPath("/" + jsonPath.replace(".json", "").replace(/^\//, ""))}
  </div>

  <h1>${escHtml(name)} <span class="signpost-badge">Signpost</span></h1>
  <div class="meta">verified: ${escHtml(lastVerified)}</div>

  <div class="reason">${escHtml(reason)}</div>

  ${quickStart ? `
  <div class="card">
    <h2>Quick Start</h2>
    <div class="quick-start">${escHtml(quickStart)}</div>
  </div>` : ""}

  ${csvEndpoint.pattern ? `
  <div class="card">
    <h2>Endpoint</h2>
    <div class="endpoint-pattern">${escHtml(csvEndpoint.pattern)}</div>
    ${csvEndpoint.auth ? `<div class="auth-note">Auth: ${escHtml(csvEndpoint.auth)}</div>` : ""}
    ${paramsHtml ? `
    <table>
      <thead><tr><th>Parameter</th><th>Description</th></tr></thead>
      <tbody>${paramsHtml}</tbody>
    </table>` : ""}
  </div>` : ""}

  ${seriesHtml ? `
  <div class="card">
    <h2>Key Series</h2>
    <table>
      <thead><tr><th>ID</th><th>Description</th></tr></thead>
      <tbody>${seriesHtml}</tbody>
    </table>
  </div>` : ""}

  <a class="json-link" href="#" onclick="copyJson(event, '${escHtml(jsonPath)}')">Copy raw JSON for agent</a>

  ${BRAND_FOOTER}
</div>
</body>
</html>`;
}

function renderParams(params, heading) {
  const entries = Object.entries(params).filter(
    ([k]) => !k.startsWith("pageHelp") && k !== "isPagination"
  );
  if (!entries.length) return "";

  const rows = entries
    .map(([name, spec]) => {
      if (typeof spec === "string") {
        return `<tr><td>${escHtml(name)}</td><td>${escHtml(spec)}</td><td></td></tr>`;
      }
      const required = spec.required
        ? '<span class="required">required</span>'
        : "";
      const fixed = spec.value
        ? `<span class="fixed">= ${escHtml(String(spec.value))}</span>`
        : "";
      const desc = spec.description || "";
      const example = spec.example ? `e.g. <code>${escHtml(String(spec.example))}</code>` : "";
      return `<tr><td>${escHtml(name)}</td><td>${required}${fixed} ${escHtml(desc)} ${example}</td></tr>`;
    })
    .join("");

  return `
    ${heading ? `<h3 style="font-size:0.9rem;margin-bottom:0.5rem;color:var(--muted)">${escHtml(heading)}</h3>` : ""}
    <table>
      <thead><tr><th>Parameter</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function render404Page(path) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Map Not Found — VeriGlow Agent Map</title>
${BRAND_FONTS}
<style>
  ${BRAND_BASE_STYLE}
  .wrap { min-height: calc(100vh - 56px); display: flex; align-items: center; justify-content: center; }
  .container { max-width: 500px; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; margin-bottom: 0.75rem; }
  .path { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; color: var(--accent); background: #f0fdf4; padding: 0.5rem 1rem; border-radius: 6px; margin-bottom: 1.5rem; word-break: break-all; }
  p { color: var(--muted); margin-bottom: 1.5rem; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  input[type="email"] { padding: 0.6rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 0.9rem; font-family: 'DM Sans', sans-serif; }
  input[type="email"]:focus { outline: none; border-color: var(--accent); }
  button { padding: 0.6rem; border: none; border-radius: 6px; background: var(--accent); color: white; font-size: 0.9rem; cursor: pointer; font-weight: 500; font-family: 'DM Sans', sans-serif; }
  button:hover { background: #059669; }
  .success { display: none; color: #10B981; margin-top: 1rem; }
</style>
</head>
<body>
${BRAND_NAV}
<div class="wrap">
<div class="container">
  <h1>Map Not Found</h1>
  <div class="path">${escHtml(path)}</div>
  <p>We haven't mapped this page yet. Leave your email and we'll notify you when it's ready.</p>

  <form id="requestForm" onsubmit="submitRequest(event)">
    <input type="email" id="email" placeholder="your@email.com" required>
    <input type="hidden" id="requestPath" value="${escHtml(path)}">
    <button type="submit">Notify me when ready</button>
  </form>
  <div class="success" id="successMsg">Got it! We'll email you when this map is ready.</div>

  ${BRAND_FOOTER}
</div>
</div>
<script>
function submitRequest(e) {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const path = document.getElementById('requestPath').value;
  fetch('/api/request-map', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email, path})
  }).catch(() => {});
  document.getElementById('requestForm').style.display = 'none';
  document.getElementById('successMsg').style.display = 'block';
}
</script>
</body>
</html>`;
}

async function serveHomepage(request) {
  // Fetch manifest (shared by JSON and HTML branches)
  let sites = [];
  let totalPages = 0;
  let manifestData = [];
  try {
    const mResp = await fetch(GITHUB_RAW_ORIGIN + "/_manifest.json", {
      headers: { "User-Agent": "Open-Agent-Map-Worker/1.0" },
      cf: { cacheTtl: 600 },
    });
    if (mResp.ok) {
      manifestData = await mResp.json();
      totalPages = manifestData.length;
      const domainMap = {};
      for (const p of manifestData) {
        const domain = p.path.split("/").filter(Boolean)[0];
        if (!domainMap[domain]) domainMap[domain] = { domain, pages: 0 };
        domainMap[domain].pages++;
      }
      sites = Object.values(domainMap);
    }
  } catch {}

  const accept = request.headers.get("Accept") || "";
  if (!accept.includes("text/html")) {
    return new Response(
      JSON.stringify({
        service: "VeriGlow Agent Map",
        description: "Web data extraction maps for AI agents — API specs, CSS selectors, pagination patterns",
        usage: {
          list_pages: "GET /{domain}  →  all mapped pages for a site",
          get_spec: "GET /{domain}/{path}  →  extraction spec for a page",
          search: "GET /_manifest.json  →  full index of all mapped pages",
          example: "GET /www.sse.com.cn/market/stockdata/statistic",
        },
        sites,
        total_pages: totalPages,
        github: "https://github.com/ChizhongWang/open-agent-map",
      }, null, 2),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      }
    );
  }

  // Build the agent JSON for homepage (reuse shared manifestData)
  const agentJson = JSON.stringify({
    service: "VeriGlow Agent Map",
    description: "Web data extraction maps for AI agents",
    usage: {
      list_pages: "GET /{domain}",
      get_spec: "GET /{domain}/{path}",
      search: "GET /_manifest.json",
    },
    sites,
    total_pages: totalPages,
    pages: manifestData,
  }, null, 2);

  // Fetch the real index.html from GitHub and inject toggle
  try {
    const resp = await fetch(GITHUB_RAW_ORIGIN + "/index.html", {
      headers: { "User-Agent": "Open-Agent-Map-Worker/1.0" },
      cf: { cacheTtl: 300 },
    });
    if (resp.ok) {
      let html = await resp.text();
      const toggleHtml = `
<style>
.view-toggle-home{display:inline-flex;border:1px solid #E5E7EB;border-radius:6px;overflow:hidden;font-size:0.8rem;margin-bottom:1rem;position:fixed;top:16px;right:16px;z-index:100}
.view-toggle-home button{padding:0.35rem 0.85rem;border:none;background:#fff;color:#6B7280;cursor:pointer;font-family:inherit;transition:all 0.15s}
.view-toggle-home button.active{background:#10B981;color:#fff}
.view-toggle-home button:hover:not(.active){background:#F3F4F6}
.agent-overlay{display:none;position:fixed;inset:0;z-index:99;background:rgba(255,255,255,0.97);padding:2rem;overflow:auto}
.agent-overlay pre{max-width:900px;margin:3rem auto 2rem;background:#f0fdf4;padding:1.5rem;border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:0.75rem;white-space:pre-wrap;word-break:break-all;line-height:1.5}
</style>
<div class="view-toggle-home">
  <button class="active" onclick="this.classList.add('active');this.nextElementSibling.classList.remove('active');document.getElementById('agentOverlay').style.display='none'">Human</button>
  <button onclick="this.classList.add('active');this.previousElementSibling.classList.remove('active');document.getElementById('agentOverlay').style.display='block'">Agent</button>
</div>
<div id="agentOverlay" class="agent-overlay"><pre>${escHtml(agentJson)}</pre></div>`;
      html = html.replace("</body>", toggleHtml + "</body>");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }
  } catch {}

  // Fallback if fetch fails
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Open Agent Map</title></head><body><h1>Open Agent Map</h1><p>Crowdsourced API specs for AI agents.</p><a href="https://github.com/ChizhongWang/open-agent-map">GitHub</a></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function serveDirectoryListing(request, dirPath) {
  // Fetch manifest
  const manifestUrl = GITHUB_RAW_ORIGIN + "/_manifest.json";
  try {
    const resp = await fetch(manifestUrl, {
      headers: { "User-Agent": "Open-Agent-Map-Worker/1.0" },
      cf: { cacheTtl: 600 },
    });
    if (!resp.ok) return serve404(request, dirPath + ".json");
    const manifest = await resp.json();

    // Filter entries under this directory prefix
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    const children = manifest.filter((e) => e.path.startsWith(prefix));

    if (children.length === 0) {
      return serve404(request, dirPath + ".json");
    }

    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html") && !accept.includes("application/json")) {
      return new Response(renderDirectoryPage(dirPath, children), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }

    // JSON response for agents
    return new Response(JSON.stringify({
      directory: dirPath,
      count: children.length,
      pages: children,
    }, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (e) {
    return serve404(request, dirPath + ".json");
  }
}

function renderDirectoryPage(dirPath, children) {
  const displayPath = dirPath.replace(/^\//, "");

  // Group by immediate subdirectory
  const prefix = dirPath + "/";
  const groups = {};
  const groupOrder = [];
  for (const child of children) {
    const rest = child.path.slice(prefix.length);
    const segment = rest.split("/")[0];
    if (!groups[segment]) { groups[segment] = []; groupOrder.push(segment); }
    groups[segment].push(child);
  }

  // Count types
  const apiCount = children.filter(c => !c.summary || !c.summary.includes("scrape")).length;
  const scrapeCount = children.length - apiCount;

  let sectionsHtml = "";
  for (const segment of groupOrder) {
    const items = groups[segment];
    if (items.length === 1 && !items[0].path.slice(prefix.length).includes("/")) {
      // Single leaf — render as a standalone card-row
      const item = items[0];
      sectionsHtml += `
      <div class="section leaf-item">
        <a class="leaf-link" href="${escHtml(item.path)}">
          <span class="leaf-title">${escHtml(item.title || segment)}</span>
          <span class="leaf-summary">${escHtml(item.summary || "")}</span>
        </a>
      </div>`;
    } else {
      // Subdirectory — expanded section with child pages
      const subPrefix = prefix + segment + "/";
      // Sub-group one more level for display
      const subGroups = {};
      const subOrder = [];
      for (const item of items) {
        const subRest = item.path.slice(subPrefix.length);
        const subSeg = subRest.split("/")[0];
        if (!subGroups[subSeg]) { subGroups[subSeg] = []; subOrder.push(subSeg); }
        subGroups[subSeg].push(item);
      }

      let childrenHtml = "";
      let shown = 0;
      const MAX_SHOW = 8;
      for (const subSeg of subOrder) {
        const subItems = subGroups[subSeg];
        if (shown >= MAX_SHOW) break;
        if (subItems.length === 1 && !subItems[0].path.slice(subPrefix.length).includes("/")) {
          const item = subItems[0];
          childrenHtml += `<a class="child" href="${escHtml(item.path)}"><span class="child-title">${escHtml(item.title)}</span><span class="child-desc">${escHtml(truncate(item.summary || "", 60))}</span></a>`;
          shown++;
        } else {
          childrenHtml += `<a class="child" href="${escHtml(subPrefix + subSeg)}"><span class="child-title">${escHtml(subSeg)}/</span><span class="child-desc">${subItems.length} pages</span></a>`;
          shown++;
        }
      }
      const remaining = items.length - shown;

      sectionsHtml += `
      <div class="section">
        <div class="section-header">
          <a class="section-link" href="${escHtml(prefix + segment)}">
            <span class="section-name">${escHtml(segment)}/</span>
            <span class="section-count">${items.length}</span>
          </a>
        </div>
        <div class="children">${childrenHtml}${remaining > 0 ? `<a class="child more" href="${escHtml(prefix + segment)}">+${remaining} more</a>` : ""}</div>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(displayPath)} — VeriGlow Agent Map</title>
${BRAND_FONTS}
<style>
  ${BRAND_BASE_STYLE}
  .container { max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; }
  .breadcrumb { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; word-break: break-all; }
  .breadcrumb a { color: var(--accent); text-decoration: none; }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  .stats { color: var(--muted); font-size: 0.9rem; margin-bottom: 0.5rem; }
  .stats-detail { color: var(--muted); font-size: 0.8rem; margin-bottom: 2rem; }
  .stats-detail span { margin-right: 1rem; }

  .section { margin-bottom: 1.5rem; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .section-header { background: var(--card); padding: 0.8rem 1.1rem; border-bottom: 1px solid var(--border); }
  .section-link { display: flex; align-items: center; gap: 0.6rem; text-decoration: none; }
  .section-name { font-weight: 600; font-size: 1rem; color: var(--text); font-family: 'JetBrains Mono', monospace; }
  .section-link:hover .section-name { color: var(--accent); }
  .section-count { font-size: 0.75rem; color: var(--muted); background: rgba(16,185,129,0.08); padding: 0.1rem 0.45rem; border-radius: 3px; }

  .children { display: grid; grid-template-columns: 1fr; }
  .child { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem; padding: 0.6rem 1.1rem; border-bottom: 1px solid var(--border); text-decoration: none; transition: background 0.15s; }
  .child:last-child { border-bottom: none; }
  .child:hover { background: #f0fdf4; }
  .child-title { font-size: 0.88rem; color: var(--accent); font-weight: 500; white-space: nowrap; }
  .child-desc { font-size: 0.78rem; color: var(--muted); text-align: right; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .child.more { justify-content: center; color: var(--muted); font-size: 0.8rem; }
  .child.more:hover { color: var(--accent); }

  .leaf-item { border: 1px solid var(--border); border-radius: 10px; }
  .leaf-link { display: block; padding: 0.8rem 1.1rem; text-decoration: none; transition: background 0.15s; }
  .leaf-link:hover { background: #f0fdf4; }
  .leaf-title { font-weight: 600; font-size: 0.95rem; color: var(--accent); display: block; margin-bottom: 0.2rem; }
  .leaf-summary { font-size: 0.8rem; color: var(--muted); }
  .json-link { display: inline-block; margin-top: 1.5rem; color: var(--accent); font-size: 0.85rem; text-decoration: none; cursor: pointer; }
  .json-link:hover { text-decoration: underline; }
  .copied { color: #10B981 !important; }
</style>
<script>
function copyEmbeddedJson(e) {
  e.preventDefault();
  try {
    const text = document.getElementById('agent-json').textContent;
    navigator.clipboard.writeText(text).then(() => {
      e.target.textContent = 'Copied!';
      e.target.classList.add('copied');
      setTimeout(() => { e.target.textContent = 'Copy raw JSON for agent'; e.target.classList.remove('copied'); }, 2000);
    });
  } catch(err) { alert('Copy failed'); }
}
</script>
</head>
<body>
${BRAND_NAV}
<div class="container">
  <div class="breadcrumb">
    ${renderBreadcrumbPath(dirPath)}
  </div>

  <h1>${escHtml(displayPath)}</h1>
  <p class="stats">${children.length} pages mapped</p>

  ${sectionsHtml}

  <a class="json-link" href="#" onclick="copyEmbeddedJson(event)">Copy raw JSON for agent</a>
  <script type="application/json" id="agent-json">${JSON.stringify({ directory: dirPath, count: children.length, pages: children }, null, 2)}</script>

  ${BRAND_FOOTER}
</div>
</body>
</html>`;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

function renderBreadcrumbPath(dirPath) {
  const parts = dirPath.split("/").filter(Boolean);
  const crumbs = [`<a href="/">Agent Map</a>`];
  parts.forEach((part, i) => {
    const href = "/" + parts.slice(0, i + 1).join("/");
    if (i === parts.length - 1) {
      crumbs.push(escHtml(part));
    } else {
      crumbs.push(`<a href="${escHtml(href)}">${escHtml(part)}</a>`);
    }
  });
  return crumbs.join(" / ");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
