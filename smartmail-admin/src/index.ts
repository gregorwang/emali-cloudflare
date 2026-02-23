interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  SMARTMAIL_AI: Fetcher;
  DASHBOARD_API_SECRET?: string;
  INTERNAL_API_SECRET?: string;
  REQUIRE_CF_ACCESS?: string;
}

type ManualReviewStatus = "pending" | "acknowledged" | "processing" | "resolved" | "closed";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/admin/login" && request.method === "POST") {
      return await login(request, env);
    }
    if (path === "/admin/logout" && request.method === "POST") {
      return logout();
    }
    if (path === "/" && request.method === "GET") {
      return isAuthenticated(request, env) ? html(dashboardHtml()) : html(loginHtml());
    }
    if (path === "/healthz") {
      return json({ ok: true, service: "smartmail-admin" });
    }

    if (!path.startsWith("/admin/api/")) {
      return new Response("Not found", { status: 404 });
    }
    if (!isAuthenticated(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && path === "/admin/api/emails") {
      const data = await listEmails(env.DB, {
        status: url.searchParams.get("status") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        priority: parseIntOrUndef(url.searchParams.get("priority")),
        fromDate: url.searchParams.get("fromDate") ?? undefined,
        toDate: url.searchParams.get("toDate") ?? undefined,
        requiresManualReview: parseBooleanOrUndef(url.searchParams.get("requiresManualReview")),
        limit: parseIntOrUndef(url.searchParams.get("limit")) ?? 50,
        offset: parseIntOrUndef(url.searchParams.get("offset")) ?? 0
      });
      return json({ emails: data });
    }

    if (request.method === "GET" && path.startsWith("/admin/api/emails/") && path.endsWith("/timeline")) {
      const emailId = path.slice("/admin/api/emails/".length, -"/timeline".length);
      const timeline = await listTimeline(env.DB, emailId);
      return json({ timeline });
    }

    if (request.method === "GET" && path.startsWith("/admin/api/emails/")) {
      const emailId = path.slice("/admin/api/emails/".length);
      const raw = url.searchParams.get("raw") === "1";
      const detail = await getEmailDetail(env.DB, emailId, raw);
      if (!detail) return json({ error: "Not found" }, 404);
      return json({ detail });
    }

    if (request.method === "GET" && path === "/admin/api/manual-reviews") {
      const status = url.searchParams.get("status") as ManualReviewStatus | null;
      const tasks = await listManualReviews(env.DB, status ?? undefined);
      return json({ tasks });
    }

    if (request.method === "POST" && path.startsWith("/admin/api/manual-reviews/") && path.endsWith("/status")) {
      const id = path.slice("/admin/api/manual-reviews/".length, -"/status".length);
      const body = (await request.json()) as { status: ManualReviewStatus; assignee?: string };
      await updateManualReview(env.DB, id, body.status, body.assignee);
      return json({ ok: true });
    }

    if (request.method === "POST" && path.startsWith("/admin/api/emails/") && path.endsWith("/reprocess")) {
      const emailId = path.slice("/admin/api/emails/".length, -"/reprocess".length);
      return await forwardInternalCommand(env, `/internal/reprocess/${emailId}`);
    }

    if (request.method === "POST" && path.startsWith("/admin/api/emails/") && path.endsWith("/replay-action")) {
      const emailId = path.slice("/admin/api/emails/".length, -"/replay-action".length);
      return await forwardInternalCommand(env, `/internal/replay-action/${emailId}`);
    }

    return json({ error: "Not found" }, 404);
  }
};

async function login(request: Request, env: Env): Promise<Response> {
  const secret = env.DASHBOARD_API_SECRET?.trim();
  if (!secret) {
    return redirect("/");
  }

  const contentType = request.headers.get("content-type") ?? "";
  let token = "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { token?: string };
    token = body.token ?? "";
  } else {
    const form = await request.formData();
    token = String(form.get("token") ?? "");
  }

  if (token.trim() !== secret) {
    return html(loginHtml("Token 无效"), 401);
  }

  return redirect("/", {
    "Set-Cookie": buildCookie("sm_admin_token", secret, 60 * 60 * 8)
  });
}

function logout(): Response {
  return redirect("/", {
    "Set-Cookie": buildCookie("sm_admin_token", "", 0)
  });
}

function isAuthenticated(request: Request, env: Env): boolean {
  const accessRequired = env.REQUIRE_CF_ACCESS === "true";
  const accessUser = request.headers.get("cf-access-authenticated-user-email");
  if (accessRequired && !accessUser) {
    return false;
  }

  const secret = env.DASHBOARD_API_SECRET?.trim();
  if (!secret) {
    return true;
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (bearer === secret) {
    return true;
  }

  const cookieToken = parseCookie(request.headers.get("cookie") ?? "", "sm_admin_token");
  return cookieToken === secret;
}

async function forwardInternalCommand(env: Env, path: string): Promise<Response> {
  const internalSecret = env.INTERNAL_API_SECRET?.trim();
  if (!internalSecret) {
    return json({ error: "INTERNAL_API_SECRET is not configured" }, 500);
  }

  const res = await env.SMARTMAIL_AI.fetch(
    new Request(`https://smartmail-ai.internal${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalSecret}`
      }
    })
  );
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json" }
  });
}

async function listEmails(
  db: D1Database,
  filters: {
    status?: string;
    category?: string;
    priority?: number;
    fromDate?: string;
    toDate?: string;
    requiresManualReview?: boolean;
    limit: number;
    offset: number;
  }
): Promise<
  Array<{
    id: string;
    received_at: string;
    from_address: string;
    to_address: string;
    subject: string;
    status: string;
    category: string | null;
    ai_priority: number | null;
    confidence_score: number | null;
    requires_manual_review: number;
  }>
> {
  const where: string[] = [];
  const binds: Array<string | number> = [];

  if (filters.status) {
    where.push("e.status = ?");
    binds.push(filters.status);
  }
  if (filters.category) {
    where.push("ai.category = ?");
    binds.push(filters.category);
  }
  if (typeof filters.priority === "number") {
    where.push("ai.priority = ?");
    binds.push(filters.priority);
  }
  if (filters.fromDate) {
    where.push("e.received_at >= ?");
    binds.push(filters.fromDate);
  }
  if (filters.toDate) {
    where.push("e.received_at <= ?");
    binds.push(filters.toDate);
  }
  if (filters.requiresManualReview === true) {
    where.push(
      `EXISTS (
         SELECT 1 FROM manual_review_tasks mrt
         WHERE mrt.email_id = e.id
           AND mrt.status IN ('pending', 'acknowledged', 'processing')
       )`
    );
  }

  const limit = Math.min(Math.max(filters.limit, 1), 100);
  const offset = Math.max(filters.offset, 0);
  binds.push(limit, offset);

  const sql = `
    SELECT
      e.id,
      e.received_at,
      e.from_address,
      e.to_address,
      e.subject,
      e.status,
      ai.category,
      ai.priority AS ai_priority,
      ai.confidence_score,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM manual_review_tasks mrt
          WHERE mrt.email_id = e.id
            AND mrt.status IN ('pending', 'acknowledged', 'processing')
        ) THEN 1
        ELSE 0
      END AS requires_manual_review
    FROM emails e
    LEFT JOIN email_ai_results ai ON ai.email_id = e.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY e.received_at DESC
    LIMIT ?
    OFFSET ?`;

  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<{
      id: string;
      received_at: string;
      from_address: string;
      to_address: string;
      subject: string;
      status: string;
      category: string | null;
      ai_priority: number | null;
      confidence_score: number | null;
      requires_manual_review: number;
    }>();
  return rows.results ?? [];
}

async function getEmailDetail(
  db: D1Database,
  emailId: string,
  rawView: boolean
): Promise<Record<string, unknown> | null> {
  const email = await db
    .prepare(
      `SELECT id, email_message_id, thread_id, received_at, to_address, from_address, from_name, subject,
              text_body, status, last_error, raw_r2_key, parsed_r2_key
       FROM emails
       WHERE id = ?`
    )
    .bind(emailId)
    .first<Record<string, unknown>>();
  if (!email) return null;

  const [aiResultRows, aiRawRows, attachmentsRows, actionsRows, reviewsRows] = await Promise.all([
    db
      .prepare(
        `SELECT category, subcategory, sentiment, priority, language, summary, tags, requires_reply,
                extracted_json, confidence_score, ai_provider, ai_model, processing_ms, created_at
         FROM email_ai_results
         WHERE email_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(emailId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT id, provider, model, request_json_redacted, response_text, response_json, created_at
         FROM ai_raw_responses
         WHERE email_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(emailId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT filename, mime_type, size_bytes, r2_key
         FROM attachments
         WHERE email_id = ?
         ORDER BY created_at DESC`
      )
      .bind(emailId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT id, action_type, action_config, status, error_msg, executed_at
         FROM action_logs
         WHERE email_id = ?
         ORDER BY executed_at DESC`
      )
      .bind(emailId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT id, priority_level, reason, status, assignee, created_at
         FROM manual_review_tasks
         WHERE email_id = ?
         ORDER BY created_at DESC`
      )
      .bind(emailId)
      .all<Record<string, unknown>>()
  ]);

  const aiRaw = (aiRawRows.results ?? [])[0] ?? null;
  if (aiRaw && !rawView) {
    aiRaw.request_json_redacted = maskSensitive(String(aiRaw.request_json_redacted ?? ""));
    aiRaw.response_text = maskSensitive(String(aiRaw.response_text ?? ""));
    aiRaw.response_json = maskSensitive(String(aiRaw.response_json ?? ""));
  }

  return {
    email,
    aiResult: (aiResultRows.results ?? [])[0] ?? null,
    aiRaw,
    attachments: attachmentsRows.results ?? [],
    actionLogs: actionsRows.results ?? [],
    manualReviews: reviewsRows.results ?? []
  };
}

async function listTimeline(
  db: D1Database,
  emailId: string
): Promise<Array<{ id: string; stage: string; status: string; detail: string | null; created_at: string }>> {
  const rows = await db
    .prepare(
      `SELECT id, stage, status, detail, created_at
       FROM processing_events
       WHERE email_id = ?
       ORDER BY created_at ASC`
    )
    .bind(emailId)
    .all<{ id: string; stage: string; status: string; detail: string | null; created_at: string }>();
  return rows.results ?? [];
}

async function listManualReviews(
  db: D1Database,
  status?: ManualReviewStatus
): Promise<
  Array<{
    id: string;
    email_id: string;
    priority_level: string;
    reason: string;
    status: string;
    assignee: string | null;
    created_at: string;
  }>
> {
  if (status) {
    const rows = await db
      .prepare(
        `SELECT id, email_id, priority_level, reason, status, assignee, created_at
         FROM manual_review_tasks
         WHERE status = ?
         ORDER BY created_at DESC
         LIMIT 200`
      )
      .bind(status)
      .all<{
        id: string;
        email_id: string;
        priority_level: string;
        reason: string;
        status: string;
        assignee: string | null;
        created_at: string;
      }>();
    return rows.results ?? [];
  }

  const rows = await db
    .prepare(
      `SELECT id, email_id, priority_level, reason, status, assignee, created_at
       FROM manual_review_tasks
       ORDER BY created_at DESC
       LIMIT 200`
    )
    .all<{
      id: string;
      email_id: string;
      priority_level: string;
      reason: string;
      status: string;
      assignee: string | null;
      created_at: string;
    }>();
  return rows.results ?? [];
}

async function updateManualReview(
  db: D1Database,
  id: string,
  status: ManualReviewStatus,
  assignee?: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE manual_review_tasks
       SET status = ?,
           assignee = COALESCE(?, assignee),
           acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acknowledged_at END,
           resolved_at = CASE WHEN ? IN ('resolved', 'closed') THEN ? ELSE resolved_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(status, assignee ?? null, status, now, status, now, id)
    .run();
}

function parseIntOrUndef(input: string | null): number | undefined {
  if (!input) return undefined;
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseBooleanOrUndef(input: string | null): boolean | undefined {
  if (!input) return undefined;
  if (input === "true") return true;
  if (input === "false") return false;
  return undefined;
}

function parseCookie(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(";").map((x) => x.trim());
  const prefix = `${name}=`;
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function buildCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function maskSensitive(input: string): string {
  return input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]");
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SmartMail Admin</title>
  <style>
    :root {
      --bg: radial-gradient(1200px 600px at 10% -20%, #ffe7c6, #fff4e7 45%, #f8fbff 100%);
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --line: #e5e7eb;
      --primary: #0f766e;
      --warn: #b45309;
      --danger: #b91c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1220px;
      margin: 24px auto;
      padding: 0 16px;
      display: grid;
      grid-template-columns: 420px 1fr;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 8px 26px rgba(15, 23, 42, 0.06);
    }
    .pane-title {
      margin: 0;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    #email-list { max-height: calc(100vh - 130px); overflow: auto; }
    .item {
      padding: 12px 14px;
      border-bottom: 1px solid #f0f2f5;
      cursor: pointer;
      transition: background .15s ease;
    }
    .item:hover { background: #f8fffd; }
    .item.active { background: #ecfeff; border-left: 3px solid var(--primary); }
    .subject { font-weight: 600; font-size: 14px; }
    .meta { margin-top: 6px; color: var(--muted); font-size: 12px; }
    .detail { padding: 14px 16px; }
    .badge {
      display: inline-block; padding: 3px 8px; border-radius: 999px;
      font-size: 12px; margin-right: 6px; border: 1px solid var(--line);
    }
    .status-error { color: var(--danger); border-color: #fecaca; background: #fef2f2; }
    .status-manual { color: var(--warn); border-color: #fed7aa; background: #fff7ed; }
    .status-ok { color: var(--primary); border-color: #99f6e4; background: #f0fdfa; }
    pre {
      background: #0b1324;
      color: #d1d5db;
      padding: 12px;
      border-radius: 10px;
      overflow: auto;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
    button {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover { border-color: #9ca3af; }
    .timeline-row {
      border-left: 2px solid #c7d2fe;
      padding: 6px 0 6px 10px;
      margin: 6px 0;
      font-size: 13px;
    }
    .toolbar {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar input, .toolbar select {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 13px;
    }
    @media (max-width: 980px) {
      .wrap { grid-template-columns: 1fr; }
      #email-list { max-height: 340px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="card">
      <h2 class="pane-title">邮件队列视图</h2>
      <div class="toolbar">
        <select id="status">
          <option value="">全部状态</option>
          <option>processing</option>
          <option>done</option>
          <option>manual_review</option>
          <option>error</option>
          <option>failed_queue</option>
        </select>
        <button id="reload">刷新</button>
      </div>
      <div id="email-list"></div>
    </section>
    <section class="card">
      <h2 class="pane-title">详情与链路</h2>
      <div class="detail" id="detail">请选择一封邮件。</div>
    </section>
  </div>
  <script>
    const listEl = document.getElementById("email-list");
    const detailEl = document.getElementById("detail");
    const statusEl = document.getElementById("status");
    const reloadBtn = document.getElementById("reload");
    let selectedId = "";

    reloadBtn.addEventListener("click", loadEmails);
    statusEl.addEventListener("change", loadEmails);

    async function loadEmails() {
      const params = new URLSearchParams();
      if (statusEl.value) params.set("status", statusEl.value);
      params.set("limit", "80");
      const res = await fetch("/admin/api/emails?" + params.toString(), { credentials: "include" });
      if (res.status === 401) {
        location.href = "/";
        return;
      }
      const data = await res.json();
      const emails = data.emails || [];
      listEl.innerHTML = emails.map(item => {
        const active = item.id === selectedId ? "active" : "";
        const category = item.category || "-";
        const conf = typeof item.confidence_score === "number" ? item.confidence_score.toFixed(2) : "-";
        return '<div class="item ' + active + '" data-id="' + item.id + '">' +
          '<div class="subject">' + esc(item.subject || "(no subject)") + '</div>' +
          '<div class="meta">' + esc(item.from_address) + ' · ' + esc(item.status) + ' · ' + esc(category) + ' · conf=' + esc(conf) + '</div>' +
          '</div>';
      }).join("");
      for (const node of listEl.querySelectorAll(".item")) {
        node.addEventListener("click", () => {
          selectedId = node.getAttribute("data-id") || "";
          loadEmails();
          loadDetail(selectedId);
        });
      }
      if (!selectedId && emails.length > 0) {
        selectedId = emails[0].id;
        loadEmails();
        loadDetail(selectedId);
      }
    }

    async function loadDetail(id) {
      const [detailRes, timelineRes] = await Promise.all([
        fetch("/admin/api/emails/" + id, { credentials: "include" }),
        fetch("/admin/api/emails/" + id + "/timeline", { credentials: "include" })
      ]);
      if (detailRes.status === 401) {
        location.href = "/";
        return;
      }
      const detailData = await detailRes.json();
      const timelineData = await timelineRes.json();
      const d = detailData.detail;
      if (!d) {
        detailEl.innerHTML = "未找到详情。";
        return;
      }

      const statusClass = d.email.status === "error" ? "status-error" : (d.email.status === "manual_review" ? "status-manual" : "status-ok");
      detailEl.innerHTML = "" +
        '<div><span class="badge ' + statusClass + '">' + esc(d.email.status) + '</span>' +
        '<span class="badge">' + esc((d.aiResult && d.aiResult.category) || "-") + '</span></div>' +
        '<h3>' + esc(d.email.subject || "(no subject)") + '</h3>' +
        '<div class="meta">from: ' + esc(d.email.from_address) + ' | to: ' + esc(d.email.to_address) + '</div>' +
        '<div class="actions">' +
        '<button id="btn-reprocess">Reprocess</button>' +
        '<button id="btn-replay">Replay Action</button>' +
        '<button id="btn-raw">查看未脱敏 AI 输出</button>' +
        '</div>' +
        '<h4>正文</h4><pre>' + esc(String(d.email.text_body || "")) + '</pre>' +
        '<h4>AI 结构化结果</h4><pre>' + esc(JSON.stringify(d.aiResult || {}, null, 2)) + '</pre>' +
        '<h4>AI 原始输出（默认脱敏）</h4><pre id="raw-box">' + esc(JSON.stringify(d.aiRaw || {}, null, 2)) + '</pre>' +
        '<h4>动作日志</h4><pre>' + esc(JSON.stringify(d.actionLogs || [], null, 2)) + '</pre>' +
        '<h4>处理时间线</h4>' + (timelineData.timeline || []).map(t => (
          '<div class="timeline-row"><strong>' + esc(t.stage) + '</strong> · ' + esc(t.status) + ' · ' + esc(t.created_at) +
          '<div class="meta">' + esc(t.detail || "") + '</div></div>'
        )).join("");

      document.getElementById("btn-reprocess").addEventListener("click", async () => {
        await postAction("/admin/api/emails/" + id + "/reprocess");
      });
      document.getElementById("btn-replay").addEventListener("click", async () => {
        await postAction("/admin/api/emails/" + id + "/replay-action");
      });
      document.getElementById("btn-raw").addEventListener("click", async () => {
        const rawRes = await fetch("/admin/api/emails/" + id + "?raw=1", { credentials: "include" });
        const rawData = await rawRes.json();
        const box = document.getElementById("raw-box");
        box.textContent = JSON.stringify(rawData.detail ? rawData.detail.aiRaw : {}, null, 2);
      });
    }

    async function postAction(url) {
      const res = await fetch(url, { method: "POST", credentials: "include" });
      const data = await res.json();
      alert(res.ok ? "执行成功" : ("执行失败: " + (data.error || res.status)));
      if (res.ok) {
        loadDetail(selectedId);
      }
    }

    function esc(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    loadEmails();
  </script>
</body>
</html>`;
}

function loginHtml(errorMsg?: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SmartMail Admin Login</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: linear-gradient(145deg, #fef3c7, #e0f2fe);
      color: #1f2937;
    }
    .card {
      width: min(420px, calc(100vw - 30px));
      background: #fff;
      border-radius: 14px;
      border: 1px solid #e5e7eb;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.1);
      padding: 18px;
    }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { color: #6b7280; font-size: 13px; margin: 0 0 12px; }
    input {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 10px;
      padding: 10px;
      font-size: 14px;
      margin-bottom: 12px;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 10px;
      background: #0f766e;
      color: #fff;
      padding: 10px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .err {
      color: #b91c1c;
      font-size: 13px;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <form class="card" method="post" action="/admin/login">
    <h1>SmartMail Admin</h1>
    <p>输入 Dashboard API Token 进入管理台。</p>
    ${errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : ""}
    <input type="password" name="token" placeholder="DASHBOARD_API_SECRET" required />
    <button type="submit">登录</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function html(content: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(content, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...headers
    }
  });
}

function redirect(location: string, headers?: Record<string, string>): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers
    }
  });
}
