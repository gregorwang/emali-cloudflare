import {
  activatePromptTemplate,
  createPromptTemplate,
  insertProcessingEvent,
  listManualReviewTasks,
  listPromptTemplates,
  updateManualReviewTaskStatus
} from "./db";
import type { Env } from "./types";

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith("/api/")) {
    return new Response("Not found", { status: 404 });
  }

  if (!isAuthorized(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (request.method === "GET" && path === "/api/manual-reviews") {
    const status = url.searchParams.get("status") as
      | "pending"
      | "acknowledged"
      | "processing"
      | "resolved"
      | "closed"
      | null;
    const tasks = await listManualReviewTasks(env.DB, status ?? undefined, 200);
    return json({ tasks });
  }

  if (request.method === "PATCH" && path.startsWith("/api/manual-reviews/")) {
    const id = path.split("/").pop();
    if (!id) return json({ error: "missing id" }, 400);
    const body = (await request.json()) as {
      status: "acknowledged" | "processing" | "resolved" | "closed";
      assignee?: string;
    };
    await updateManualReviewTaskStatus(env.DB, id, body.status, body.assignee);
    try {
      const task = await env.DB
        .prepare(`SELECT email_id FROM manual_review_tasks WHERE id = ?`)
        .bind(id)
        .first<{ email_id: string }>();
      if (task?.email_id) {
        await insertProcessingEvent(env.DB, task.email_id, "manual_review", "ok", {
          source: "dashboard_api",
          taskId: id,
          status: body.status,
          assignee: body.assignee ?? null
        });
      }
    } catch (err) {
      console.error("insertProcessingEvent(manual_review) failed", err);
    }
    return json({ ok: true });
  }

  if (request.method === "GET" && path === "/api/prompts") {
    const name = url.searchParams.get("name") ?? undefined;
    const prompts = await listPromptTemplates(env.DB, name);
    return json({ prompts });
  }

  if (request.method === "POST" && path === "/api/prompts") {
    const body = (await request.json()) as {
      name: string;
      version: string;
      content: string;
      outputSchema?: string;
      createdBy?: string;
    };
    await createPromptTemplate(
      env.DB,
      body.name,
      body.version,
      body.content,
      body.outputSchema,
      body.createdBy
    );
    return json({ ok: true }, 201);
  }

  if (request.method === "POST" && path === "/api/prompts/activate") {
    const body = (await request.json()) as { name: string; version: string };
    await activatePromptTemplate(env.DB, body.name, body.version);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

function isAuthorized(request: Request, env: Env): boolean {
  const secret = env.DASHBOARD_API_SECRET?.trim();
  if (!secret) return true;
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return token === secret;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
