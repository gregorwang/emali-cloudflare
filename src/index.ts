import PostalMime from "postal-mime";
import { z } from "zod";
import { classifyEmail, generateReplyDraft } from "./ai";
import { executePostAIFlow, maybeSendReplyDraft, sendReplyDraftNow } from "./actions";
import { handleApiRequest } from "./api";
import {
  deleteEmailCascade,
  getAIClassificationByEmailId,
  getQueueMessageById,
  getReplyDraftByEmailId,
  insertAIRawResponse,
  insertActionLog,
  insertAttachments,
  insertCleanupRun,
  insertEmailIfNotExists,
  insertProcessingEvent,
  listAttachmentKeysByEmailIds,
  listExpiredEmailObjects,
  listFailedQueueEmails,
  listOverdueManualReviews,
  markEmailStatus,
  saveFailedQueueRecord,
  setEmailRetryStatus,
  upsertReplyDraft,
  upsertAIResult
} from "./db";
import type { AttachmentMeta, Env, QueueMessage } from "./types";
import {
  applyQueuePayloadBudget,
  buildDatedKey,
  estimateJsonBytes,
  extractDomain,
  inferPriority,
  parseMaxBodyLength,
  parsePositiveInt,
  truncateText
} from "./utils";

const queueMessageSchema = z.object({
  messageId: z.string(),
  emailId: z.string(),
  receivedAt: z.string(),
  to: z.string(),
  from: z.string(),
  fromName: z.string().default(""),
  subject: z.string().default(""),
  textBody: z.string().default(""),
  hasHtml: z.boolean().default(false),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        mimeType: z.string(),
        size: z.number(),
        r2Key: z.string().optional()
      })
    )
    .default([]),
  rawR2Key: z.string(),
  parsedR2Key: z.string().optional(),
  bodyTruncated: z.boolean().optional(),
  threadId: z.string().optional(),
  priority: z.enum(["high", "normal", "low"])
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/internal/")) {
      return await handleInternalRequest(request, env);
    }
    return await handleApiRequest(request, env);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const blocked = await isBlocked(env.CONFIG, message.from);
    if (blocked) {
      message.setReject("blocked by blacklist");
      return;
    }

    const rawBuffer = await new Response(message.raw).arrayBuffer();
    const parser = new PostalMime();
    const parsed = await parser.parse(rawBuffer);

    const queueId = crypto.randomUUID();
    const rawR2Key = buildDatedKey("emails", queueId, "eml");
    ctx.waitUntil(env.STORAGE.put(rawR2Key, rawBuffer));

    const maxLength = parseMaxBodyLength(env.MAX_TEXT_BODY_LENGTH);
    const body = truncateText(parsed.text ?? "", maxLength).value;

    const attachments = await uploadAttachments(env, ctx, queueId, parsed.attachments ?? []);

    const parsedR2Key = buildDatedKey("emails", `${queueId}_parsed`, "json");
    ctx.waitUntil(
      env.STORAGE.put(
        parsedR2Key,
        JSON.stringify({
          from: message.from,
          to: message.to,
          subject: parsed.subject ?? "",
          textBody: parsed.text ?? "",
          hasHtml: Boolean(parsed.html),
          attachmentCount: attachments.length
        }),
        { httpMetadata: { contentType: "application/json" } }
      )
    );

    let payload: QueueMessage = {
      messageId: queueId,
      emailId: message.headers.get("message-id") ?? queueId,
      receivedAt: new Date().toISOString(),
      to: message.to,
      from: message.from,
      fromName: parsed.from?.name ?? "",
      subject: parsed.subject ?? "",
      textBody: body,
      hasHtml: Boolean(parsed.html),
      attachments,
      rawR2Key,
      parsedR2Key,
      threadId: message.headers.get("in-reply-to") ?? undefined,
      priority: inferPriority(parsed.subject ?? "", message.from)
    };

    await safeInsertEvent(env.DB, payload.messageId, "received", "ok", {
      to: payload.to,
      from: payload.from,
      subject: payload.subject
    });

    const maxQueueBytes = parsePositiveInt(env.MAX_QUEUE_MESSAGE_BYTES, 120 * 1024);
    payload = applyQueuePayloadBudget(payload, maxQueueBytes);

    if (estimateJsonBytes(payload) > maxQueueBytes) {
      payload.textBody = payload.textBody.slice(0, 500);
      payload.bodyTruncated = true;
    }

    try {
      await env.EMAIL_QUEUE.send(payload);
      await safeInsertEvent(env.DB, payload.messageId, "queued", "ok", {
        priority: payload.priority
      });
    } catch (err) {
      await saveFailedQueueRecord(
        env.DB,
        payload,
        err instanceof Error ? err.message : "queue send failed"
      );
      await safeInsertEvent(env.DB, payload.messageId, "error", "failed", {
        stage: "queue_send",
        error: err instanceof Error ? err.message : "queue send failed"
      });
      throw err;
    }
  },

  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        const parsed = queueMessageSchema.safeParse(message.body);
        if (!parsed.success) {
          console.error("Invalid queue payload", parsed.error.flatten());
          message.ack();
          continue;
        }

        await processMessage(parsed.data as QueueMessage, env);
        message.ack();
      } catch (err) {
        console.error("Queue process error", err);
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await retryFailedQueueMessages(env);
    await runRetentionCleanup(env);
    await notifyOverdueManualReviews(env);
  }
};

async function processMessage(payload: QueueMessage, env: Env): Promise<void> {
  const inserted = await insertEmailIfNotExists(env.DB, payload);
  if (!inserted) {
    await safeInsertEvent(env.DB, payload.messageId, "processing", "ok", {
      skipped: "duplicate"
    });
    return;
  }

  try {
    await safeInsertEvent(env.DB, payload.messageId, "processing", "ok", {
      source: "queue"
    });
    await insertAttachments(env.DB, payload.messageId, payload.attachments);
    const start = Date.now();
    const aiResult = await classifyEmail(env, payload);
    const elapsed = Date.now() - start;

    await upsertAIResult(
      env.DB,
      payload.messageId,
      aiResult.classification,
      aiResult.provider,
      aiResult.model,
      elapsed
    );
    await insertAIRawResponse(
      env.DB,
      payload.messageId,
      aiResult.provider,
      aiResult.model,
      aiResult.rawTrace
    );
    await safeInsertEvent(env.DB, payload.messageId, "ai_done", "ok", {
      provider: aiResult.provider,
      model: aiResult.model,
      elapsedMs: elapsed,
      category: aiResult.classification.category,
      confidenceScore: aiResult.classification.confidenceScore
    });

    let replyDraftGenerated = false;
    if (aiResult.classification.requiresReply) {
      try {
        const replyResult = await generateReplyDraft(env, payload, aiResult.classification);
        await upsertReplyDraft(env.DB, payload.messageId, replyResult.draft);
        await insertAIRawResponse(
          env.DB,
          payload.messageId,
          `${replyResult.provider}:reply-draft`,
          replyResult.model,
          replyResult.rawTrace
        );
        replyDraftGenerated = true;
      } catch (err) {
        await insertActionLog(
          env.DB,
          payload.messageId,
          "reply_draft_generate",
          { requiresReply: true },
          "failed",
          err instanceof Error ? err.message : "reply draft generation failed"
        );
      }
    }

    const actionResult = await executePostAIFlow(env, payload, aiResult.classification);
    let replySent = false;
    if (replyDraftGenerated) {
      const draft = await getReplyDraftByEmailId(env.DB, payload.messageId);
      if (draft) {
        try {
          const sendResult = await maybeSendReplyDraft(env, payload, aiResult.classification, draft);
          replySent = sendResult.sent;
          if (!sendResult.sent && sendResult.reason) {
            await insertActionLog(
              env.DB,
              payload.messageId,
              "reply_send_skipped",
              { reason: sendResult.reason },
              "success"
            );
          }
        } catch (err) {
          await insertActionLog(
            env.DB,
            payload.messageId,
            "reply_sent_resend",
            { mode: "auto", to: payload.from },
            "failed",
            err instanceof Error ? err.message : "reply send failed"
          );
        }
      }
    }

    await markEmailStatus(
      env.DB,
      payload.messageId,
      actionResult.manualReviewCreated ? "manual_review" : "done"
    );
    await safeInsertEvent(
      env.DB,
      payload.messageId,
      actionResult.manualReviewCreated ? "manual_review" : "action_done",
      "ok",
      {
        manualReviewCreated: actionResult.manualReviewCreated,
        replyDraftGenerated,
        replySent
      }
    );
  } catch (err) {
    await markEmailStatus(
      env.DB,
      payload.messageId,
      "error",
      err instanceof Error ? err.message : "unknown process error"
    );
    await safeInsertEvent(env.DB, payload.messageId, "error", "failed", {
      stage: "process",
      error: err instanceof Error ? err.message : "unknown process error"
    });
    throw err;
  }
}

async function isBlocked(config: KVNamespace, email: string): Promise<boolean> {
  const domain = extractDomain(email);
  const [byEmail, byDomain] = await Promise.all([
    config.get(`blacklist:${email.toLowerCase()}`),
    domain ? config.get(`blacklist:domain:${domain}`) : Promise.resolve(null)
  ]);
  return Boolean(byEmail || byDomain);
}

async function uploadAttachments(
  env: Env,
  ctx: ExecutionContext,
  emailId: string,
  attachments: Array<{
    filename?: string | null;
    mimeType?: string | null;
    content?: Uint8Array | ArrayBuffer | string;
  }>
): Promise<AttachmentMeta[]> {
  const result: AttachmentMeta[] = [];
  for (const item of attachments) {
    const filename = item.filename || "unnamed";
    const mimeType = item.mimeType || "application/octet-stream";
    const data = normalizeToUint8Array(item.content);
    const size = data.byteLength;
    const key = buildDatedKey(`emails/${emailId}_attachments`, crypto.randomUUID(), "bin");

    // Store attachments in R2 to keep queue payload small and deterministic.
    ctx.waitUntil(
      env.STORAGE.put(key, data, {
        httpMetadata: {
          contentType: mimeType
        },
        customMetadata: {
          filename
        }
      })
    );

    result.push({
      filename,
      mimeType,
      size,
      r2Key: key
    });
  }
  return result;
}

function normalizeToUint8Array(
  content: Uint8Array | ArrayBuffer | string | undefined
): Uint8Array {
  if (!content) return new Uint8Array();
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(content);
}

async function retryFailedQueueMessages(env: Env): Promise<void> {
  const failed = await listFailedQueueEmails(env.DB, 50);
  for (const row of failed) {
    try {
      const payload = await getQueueMessageById(env.DB, row.id);
      if (!payload) {
        continue;
      }
      await env.EMAIL_QUEUE.send(payload);
      await setEmailRetryStatus(env.DB, row.id, "processing");
      await safeInsertEvent(env.DB, row.id, "retry", "ok", {
        source: "scheduled_retry"
      });
    } catch (err) {
      await setEmailRetryStatus(
        env.DB,
        row.id,
        "failed_queue",
        err instanceof Error ? err.message : "retry failed"
      );
      await safeInsertEvent(env.DB, row.id, "retry", "failed", {
        source: "scheduled_retry",
        error: err instanceof Error ? err.message : "retry failed"
      });
    }
  }
}

async function runRetentionCleanup(env: Env): Promise<void> {
  const retentionDays = parsePositiveInt(env.RETENTION_DAYS_EMAILS, 365);
  const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  let failed = 0;

  try {
    const expired = await listExpiredEmailObjects(env.DB, cutoffIso, 200);
    if (expired.length === 0) {
      await insertCleanupRun(env.DB, 0, 0);
      return;
    }

    const emailIds = expired.map((e) => e.id);
    const attachmentKeys = await listAttachmentKeysByEmailIds(env.DB, emailIds);
    const rawKeys = expired.map((e) => e.raw_r2_key).filter((k): k is string => Boolean(k));
    const allKeys = [...rawKeys, ...attachmentKeys];
    await Promise.all(allKeys.map((key) => env.STORAGE.delete(key)));

    await deleteEmailCascade(env.DB, emailIds);
    deleted = emailIds.length;
  } catch (err) {
    failed = 1;
    await insertCleanupRun(
      env.DB,
      deleted,
      failed,
      err instanceof Error ? err.message : "cleanup error"
    );
    return;
  }

  await insertCleanupRun(env.DB, deleted, failed);
}

async function notifyOverdueManualReviews(env: Env): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;
  const rows = await listOverdueManualReviews(env.DB);
  const now = Date.now();

  for (const row of rows) {
    const createdAt = new Date(row.created_at).getTime();
    const elapsedMinutes = (now - createdAt) / 60000;
    const overdue = isManualReviewOverdue(row.priority_level, elapsedMinutes);
    if (!overdue) continue;

    const text = [
      "SmartMail 人工兜底 SLA 告警",
      `task: ${row.id}`,
      `email: ${row.email_id}`,
      `priority: ${row.priority_level}`,
      `status: ${row.status}`,
      `elapsed_min: ${Math.floor(elapsedMinutes)}`
    ].join("\n");
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
  }
}

function isManualReviewOverdue(priority: string, elapsedMinutes: number): boolean {
  if (priority === "P0") return elapsedMinutes > 15;
  if (priority === "P1") return elapsedMinutes > 30;
  return elapsedMinutes > 240;
}

async function handleInternalRequest(request: Request, env: Env): Promise<Response> {
  if (!isInternalAuthorized(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const path = new URL(request.url).pathname;
  if (path.startsWith("/internal/reprocess/")) {
    const emailId = path.slice("/internal/reprocess/".length);
    if (!emailId) return json({ error: "missing email id" }, 400);
    return await runReprocess(env, emailId);
  }

  if (path.startsWith("/internal/replay-action/")) {
    const emailId = path.slice("/internal/replay-action/".length);
    if (!emailId) return json({ error: "missing email id" }, 400);
    return await runReplayAction(env, emailId);
  }

  if (path.startsWith("/internal/send-reply/")) {
    const emailId = path.slice("/internal/send-reply/".length);
    if (!emailId) return json({ error: "missing email id" }, 400);
    return await runSendReply(env, emailId);
  }

  return json({ error: "Not found" }, 404);
}

async function runReprocess(env: Env, emailId: string): Promise<Response> {
  const payload = await getQueueMessageById(env.DB, emailId);
  if (!payload) return json({ error: "email not found" }, 404);

  try {
    await markEmailStatus(env.DB, emailId, "processing");
    await safeInsertEvent(env.DB, emailId, "retry", "ok", {
      source: "admin_reprocess"
    });
    await processExistingMessage(payload, env, "admin_reprocess");
    return json({ ok: true, emailId });
  } catch (err) {
    return json(
      {
        error: err instanceof Error ? err.message : "reprocess failed"
      },
      500
    );
  }
}

async function runReplayAction(env: Env, emailId: string): Promise<Response> {
  const payload = await getQueueMessageById(env.DB, emailId);
  if (!payload) return json({ error: "email not found" }, 404);

  const classification = await getAIClassificationByEmailId(env.DB, emailId);
  if (!classification) return json({ error: "ai result not found" }, 404);

  try {
    const actionResult = await executePostAIFlow(env, payload, classification);
    await markEmailStatus(env.DB, emailId, actionResult.manualReviewCreated ? "manual_review" : "done");
    await safeInsertEvent(
      env.DB,
      emailId,
      actionResult.manualReviewCreated ? "manual_review" : "action_done",
      "ok",
      {
        source: "admin_replay_action",
        manualReviewCreated: actionResult.manualReviewCreated
      }
    );
    return json({ ok: true, emailId });
  } catch (err) {
    await safeInsertEvent(env.DB, emailId, "action_done", "failed", {
      source: "admin_replay_action",
      error: err instanceof Error ? err.message : "replay action failed"
    });
    return json(
      {
        error: err instanceof Error ? err.message : "replay action failed"
      },
      500
    );
  }
}

async function runSendReply(env: Env, emailId: string): Promise<Response> {
  const payload = await getQueueMessageById(env.DB, emailId);
  if (!payload) return json({ error: "email not found" }, 404);

  const draft = await getReplyDraftByEmailId(env.DB, emailId);
  if (!draft) return json({ error: "reply draft not found" }, 404);

  try {
    await sendReplyDraftNow(env, payload, draft);
    await safeInsertEvent(env.DB, emailId, "action_done", "ok", {
      source: "admin_send_reply",
      to: payload.from
    });
    return json({ ok: true, emailId });
  } catch (err) {
    await insertActionLog(
      env.DB,
      emailId,
      "reply_sent_resend",
      { mode: "manual", to: payload.from },
      "failed",
      err instanceof Error ? err.message : "manual reply send failed"
    );
    await safeInsertEvent(env.DB, emailId, "action_done", "failed", {
      source: "admin_send_reply",
      error: err instanceof Error ? err.message : "manual reply send failed"
    });
    return json(
      {
        error: err instanceof Error ? err.message : "manual reply send failed"
      },
      500
    );
  }
}

async function processExistingMessage(
  payload: QueueMessage,
  env: Env,
  source: string
): Promise<void> {
  try {
    await safeInsertEvent(env.DB, payload.messageId, "processing", "ok", { source });
    const start = Date.now();
    const aiResult = await classifyEmail(env, payload);
    const elapsed = Date.now() - start;

    await upsertAIResult(
      env.DB,
      payload.messageId,
      aiResult.classification,
      aiResult.provider,
      aiResult.model,
      elapsed
    );
    await insertAIRawResponse(
      env.DB,
      payload.messageId,
      aiResult.provider,
      aiResult.model,
      aiResult.rawTrace
    );
    await safeInsertEvent(env.DB, payload.messageId, "ai_done", "ok", {
      source,
      provider: aiResult.provider,
      model: aiResult.model,
      elapsedMs: elapsed,
      category: aiResult.classification.category,
      confidenceScore: aiResult.classification.confidenceScore
    });

    let replyDraftGenerated = false;
    if (aiResult.classification.requiresReply) {
      try {
        const replyResult = await generateReplyDraft(env, payload, aiResult.classification);
        await upsertReplyDraft(env.DB, payload.messageId, replyResult.draft);
        await insertAIRawResponse(
          env.DB,
          payload.messageId,
          `${replyResult.provider}:reply-draft`,
          replyResult.model,
          replyResult.rawTrace
        );
        replyDraftGenerated = true;
      } catch (err) {
        await insertActionLog(
          env.DB,
          payload.messageId,
          "reply_draft_generate",
          { requiresReply: true, source },
          "failed",
          err instanceof Error ? err.message : "reply draft generation failed"
        );
      }
    }

    const actionResult = await executePostAIFlow(env, payload, aiResult.classification);
    let replySent = false;
    if (replyDraftGenerated) {
      const draft = await getReplyDraftByEmailId(env.DB, payload.messageId);
      if (draft) {
        try {
          const sendResult = await maybeSendReplyDraft(env, payload, aiResult.classification, draft);
          replySent = sendResult.sent;
          if (!sendResult.sent && sendResult.reason) {
            await insertActionLog(
              env.DB,
              payload.messageId,
              "reply_send_skipped",
              { source, reason: sendResult.reason },
              "success"
            );
          }
        } catch (err) {
          await insertActionLog(
            env.DB,
            payload.messageId,
            "reply_sent_resend",
            { mode: "auto", source, to: payload.from },
            "failed",
            err instanceof Error ? err.message : "reply send failed"
          );
        }
      }
    }

    await markEmailStatus(
      env.DB,
      payload.messageId,
      actionResult.manualReviewCreated ? "manual_review" : "done"
    );
    await safeInsertEvent(
      env.DB,
      payload.messageId,
      actionResult.manualReviewCreated ? "manual_review" : "action_done",
      "ok",
      {
        source,
        manualReviewCreated: actionResult.manualReviewCreated,
        replyDraftGenerated,
        replySent
      }
    );
  } catch (err) {
    await markEmailStatus(
      env.DB,
      payload.messageId,
      "error",
      err instanceof Error ? err.message : "reprocess failed"
    );
    await safeInsertEvent(env.DB, payload.messageId, "error", "failed", {
      source,
      error: err instanceof Error ? err.message : "reprocess failed"
    });
    throw err;
  }
}

function isInternalAuthorized(request: Request, env: Env): boolean {
  const expected = env.INTERNAL_API_SECRET?.trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return token === expected;
}

async function safeInsertEvent(
  db: D1Database,
  emailId: string,
  stage:
    | "received"
    | "queued"
    | "processing"
    | "ai_done"
    | "action_done"
    | "manual_review"
    | "error"
    | "retry",
  status: "ok" | "retry" | "failed",
  detail?: unknown
): Promise<void> {
  try {
    await insertProcessingEvent(db, emailId, stage, status, detail);
  } catch (err) {
    console.error("insertProcessingEvent failed", err);
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
