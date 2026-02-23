import PostalMime from "postal-mime";
import { z } from "zod";
import { classifyEmail } from "./ai";
import { executePostAIFlow } from "./actions";
import { handleApiRequest } from "./api";
import {
  deleteEmailCascade,
  getQueueMessageById,
  insertAttachments,
  insertCleanupRun,
  insertEmailIfNotExists,
  listAttachmentKeysByEmailIds,
  listExpiredEmailObjects,
  listFailedQueueEmails,
  listOverdueManualReviews,
  markEmailStatus,
  saveFailedQueueRecord,
  setEmailRetryStatus,
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

    const maxQueueBytes = parsePositiveInt(env.MAX_QUEUE_MESSAGE_BYTES, 120 * 1024);
    payload = applyQueuePayloadBudget(payload, maxQueueBytes);

    if (estimateJsonBytes(payload) > maxQueueBytes) {
      payload.textBody = payload.textBody.slice(0, 500);
      payload.bodyTruncated = true;
    }

    try {
      await env.EMAIL_QUEUE.send(payload);
    } catch (err) {
      await saveFailedQueueRecord(
        env.DB,
        payload,
        err instanceof Error ? err.message : "queue send failed"
      );
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
    return;
  }

  try {
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
    const actionResult = await executePostAIFlow(env, payload, aiResult.classification);
    await markEmailStatus(
      env.DB,
      payload.messageId,
      actionResult.manualReviewCreated ? "manual_review" : "done"
    );
  } catch (err) {
    await markEmailStatus(
      env.DB,
      payload.messageId,
      "error",
      err instanceof Error ? err.message : "unknown process error"
    );
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
    } catch (err) {
      await setEmailRetryStatus(
        env.DB,
        row.id,
        "failed_queue",
        err instanceof Error ? err.message : "retry failed"
      );
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
