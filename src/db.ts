import type { AIClassification, AIRawTrace, AIReplyDraft, QueueMessage } from "./types";

export async function insertEmailIfNotExists(db: D1Database, message: QueueMessage): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO emails (
          id, email_message_id, thread_id, received_at, to_address, from_address, from_name, subject, text_body,
          has_attachments, raw_r2_key, parsed_r2_key, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email_message_id) DO NOTHING`
    )
    .bind(
      message.messageId,
      message.emailId,
      message.threadId ?? null,
      message.receivedAt,
      message.to,
      message.from,
      message.fromName || null,
      message.subject,
      message.textBody,
      message.attachments.length > 0 ? 1 : 0,
      message.rawR2Key,
      message.parsedR2Key ?? null,
      "processing"
    )
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function insertAttachments(
  db: D1Database,
  emailId: string,
  attachments: QueueMessage["attachments"]
): Promise<void> {
  if (attachments.length === 0) return;

  const stmts = attachments.map((item) =>
    db
      .prepare(
        `INSERT INTO attachments (id, email_id, filename, mime_type, size_bytes, r2_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), emailId, item.filename, item.mimeType, item.size, item.r2Key ?? null)
  );
  await db.batch(stmts);
}

export async function upsertAIResult(
  db: D1Database,
  emailId: string,
  classification: AIClassification,
  provider: string,
  model: string,
  processingMs: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_ai_results (
          id, email_id, category, subcategory, sentiment, priority, language, summary, tags, requires_reply,
          extracted_json, confidence_score, ai_provider, ai_model, processing_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email_id) DO UPDATE SET
          category=excluded.category,
          subcategory=excluded.subcategory,
          sentiment=excluded.sentiment,
          priority=excluded.priority,
          language=excluded.language,
          summary=excluded.summary,
          tags=excluded.tags,
          requires_reply=excluded.requires_reply,
          extracted_json=excluded.extracted_json,
          confidence_score=excluded.confidence_score,
          ai_provider=excluded.ai_provider,
          ai_model=excluded.ai_model,
          processing_ms=excluded.processing_ms`
    )
    .bind(
      crypto.randomUUID(),
      emailId,
      classification.category,
      classification.subcategory ?? null,
      classification.sentiment,
      classification.priority,
      classification.language,
      classification.summary,
      JSON.stringify(classification.tags),
      classification.requiresReply ? 1 : 0,
      JSON.stringify(classification.extractedEntities),
      classification.confidenceScore,
      provider,
      model,
      processingMs
    )
    .run();
}

export async function insertAIRawResponse(
  db: D1Database,
  emailId: string,
  provider: string,
  model: string,
  rawTrace?: AIRawTrace
): Promise<void> {
  if (!rawTrace) return;
  await db
    .prepare(
      `INSERT INTO ai_raw_responses (
         id, email_id, provider, model, request_json_redacted, response_text, response_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      emailId,
      provider,
      model,
      rawTrace.requestJsonRedacted ?? null,
      rawTrace.responseText ?? null,
      rawTrace.responseJson ?? null
    )
    .run();
}

export async function upsertReplyDraft(
  db: D1Database,
  emailId: string,
  draft: AIReplyDraft
): Promise<void> {
  await db
    .prepare(
      `UPDATE email_ai_results
       SET reply_draft = ?, reply_draft_json = ?
       WHERE email_id = ?`
    )
    .bind(draft.body, JSON.stringify(draft), emailId)
    .run();
}

export async function getReplyDraftByEmailId(
  db: D1Database,
  emailId: string
): Promise<AIReplyDraft | null> {
  const row = await db
    .prepare(
      `SELECT reply_draft_json, reply_draft
       FROM email_ai_results
       WHERE email_id = ?
       LIMIT 1`
    )
    .bind(emailId)
    .first<{ reply_draft_json: string | null; reply_draft: string | null }>();
  if (!row) return null;

  if (row.reply_draft_json) {
    try {
      const parsed = JSON.parse(row.reply_draft_json) as AIReplyDraft;
      if (parsed?.subject && parsed?.body) return parsed;
    } catch {
      // ignore malformed JSON and use plain fallback below
    }
  }
  if (!row.reply_draft) return null;

  return {
    subject: "Re: Your message",
    body: row.reply_draft,
    tone: "formal",
    language: "en",
    placeholders: [],
    autoSendSafe: false
  };
}

export async function insertProcessingEvent(
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
  await db
    .prepare(
      `INSERT INTO processing_events (id, email_id, stage, status, detail)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      emailId,
      stage,
      status,
      detail ? JSON.stringify(detail) : null
    )
    .run();
}

export async function markEmailStatus(
  db: D1Database,
  emailId: string,
  status: "pending" | "processing" | "done" | "error" | "failed_queue" | "manual_review",
  errorMsg?: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE emails
       SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(status, errorMsg?.slice(0, 2000) ?? null, emailId)
    .run();

  if (errorMsg && status === "error") {
    await db
      .prepare(
        `INSERT INTO action_logs (id, email_id, action_type, action_config, status, error_msg)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), emailId, "ai_process", "{}", "failed", errorMsg.slice(0, 2000))
      .run();
  }
}

export async function saveFailedQueueRecord(
  db: D1Database,
  message: QueueMessage,
  reason: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO emails (
          id, email_message_id, thread_id, received_at, to_address, from_address, from_name, subject, text_body,
          has_attachments, raw_r2_key, parsed_r2_key, status, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email_message_id) DO UPDATE SET
          status='failed_queue',
          last_error=excluded.last_error,
          updated_at=CURRENT_TIMESTAMP`
    )
    .bind(
      message.messageId,
      message.emailId,
      message.threadId ?? null,
      message.receivedAt,
      message.to,
      message.from,
      message.fromName || null,
      message.subject,
      message.textBody,
      message.attachments.length > 0 ? 1 : 0,
      message.rawR2Key,
      message.parsedR2Key ?? null,
      "failed_queue",
      reason.slice(0, 2000)
    )
    .run();
}

export async function listFailedQueueEmails(
  db: D1Database,
  limit = 50
): Promise<Array<{ id: string; raw_r2_key: string | null; parsed_r2_key: string | null }>> {
  const rows = await db
    .prepare(
      `SELECT id, raw_r2_key, parsed_r2_key
       FROM emails
       WHERE status = 'failed_queue'
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ id: string; raw_r2_key: string | null; parsed_r2_key: string | null }>();
  return rows.results ?? [];
}

export async function setEmailRetryStatus(
  db: D1Database,
  emailId: string,
  status: "processing" | "failed_queue",
  errorMsg?: string
): Promise<void> {
  await markEmailStatus(db, emailId, status, errorMsg);
}

export async function getQueueMessageById(db: D1Database, id: string): Promise<QueueMessage | null> {
  const row = await db
    .prepare(
      `SELECT id, email_message_id, received_at, to_address, from_address, from_name, subject, text_body,
              raw_r2_key, parsed_r2_key, thread_id
       FROM emails
       WHERE id = ?`
    )
    .bind(id)
    .first<{
      id: string;
      email_message_id: string;
      received_at: string;
      to_address: string;
      from_address: string;
      from_name: string | null;
      subject: string;
      text_body: string | null;
      raw_r2_key: string | null;
      parsed_r2_key: string | null;
      thread_id: string | null;
    }>();
  if (!row) return null;

  const attachmentRows = await db
    .prepare(
      `SELECT filename, mime_type, size_bytes, r2_key
       FROM attachments
       WHERE email_id = ?`
    )
    .bind(id)
    .all<{ filename: string; mime_type: string | null; size_bytes: number | null; r2_key: string | null }>();

  return {
    messageId: row.id,
    emailId: row.email_message_id,
    receivedAt: row.received_at,
    to: row.to_address,
    from: row.from_address,
    fromName: row.from_name ?? "",
    subject: row.subject,
    textBody: row.text_body ?? "",
    hasHtml: false,
    attachments: (attachmentRows.results ?? []).map((a) => ({
      filename: a.filename,
      mimeType: a.mime_type ?? "application/octet-stream",
      size: a.size_bytes ?? 0,
      r2Key: a.r2_key ?? undefined
    })),
    rawR2Key: row.raw_r2_key ?? "",
    parsedR2Key: row.parsed_r2_key ?? undefined,
    threadId: row.thread_id ?? undefined,
    priority: "normal"
  };
}

export async function insertActionLog(
  db: D1Database,
  emailId: string,
  actionType: string,
  actionConfig: unknown,
  status: "success" | "failed",
  errorMsg?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO action_logs (id, email_id, action_type, action_config, status, error_msg)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      emailId,
      actionType,
      JSON.stringify(actionConfig ?? {}),
      status,
      errorMsg?.slice(0, 2000) ?? null
    )
    .run();
}

export async function createManualReviewTask(
  db: D1Database,
  emailId: string,
  priority: "P0" | "P1" | "P2",
  reason: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO manual_review_tasks (
        id, email_id, priority_level, reason, status
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), emailId, priority, reason.slice(0, 2000), "pending")
    .run();
}

export async function listExpiredEmailObjects(
  db: D1Database,
  cutoffIso: string,
  limit = 200
): Promise<Array<{ id: string; raw_r2_key: string | null }>> {
  const rows = await db
    .prepare(
      `SELECT id, raw_r2_key
       FROM emails
       WHERE legal_hold = 0
         AND received_at < ?
       ORDER BY received_at ASC
       LIMIT ?`
    )
    .bind(cutoffIso, limit)
    .all<{ id: string; raw_r2_key: string | null }>();
  return rows.results ?? [];
}

export async function listAttachmentKeysByEmailIds(
  db: D1Database,
  emailIds: string[]
): Promise<string[]> {
  if (emailIds.length === 0) return [];
  const placeholders = emailIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT r2_key
       FROM attachments
       WHERE email_id IN (${placeholders})
         AND r2_key IS NOT NULL`
    )
    .bind(...emailIds)
    .all<{ r2_key: string }>();
  return (rows.results ?? []).map((r) => r.r2_key);
}

export async function deleteEmailCascade(db: D1Database, emailIds: string[]): Promise<void> {
  if (emailIds.length === 0) return;
  const placeholders = emailIds.map(() => "?").join(",");
  await db.batch([
    db.prepare(`DELETE FROM manual_review_tasks WHERE email_id IN (${placeholders})`).bind(...emailIds),
    db.prepare(`DELETE FROM action_logs WHERE email_id IN (${placeholders})`).bind(...emailIds),
    db.prepare(`DELETE FROM processing_events WHERE email_id IN (${placeholders})`).bind(...emailIds),
    db.prepare(`DELETE FROM ai_raw_responses WHERE email_id IN (${placeholders})`).bind(...emailIds),
    db.prepare(`DELETE FROM email_ai_results WHERE email_id IN (${placeholders})`).bind(...emailIds),
    db.prepare(`DELETE FROM attachments WHERE email_id IN (${placeholders})`).bind(...emailIds),
    db.prepare(`DELETE FROM emails WHERE id IN (${placeholders})`).bind(...emailIds)
  ]);
}

export async function insertCleanupRun(
  db: D1Database,
  deletedCount: number,
  failedCount: number,
  errorMsg?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cleanup_runs (id, started_at, finished_at, deleted_count, failed_count, error_msg)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      new Date().toISOString(),
      deletedCount,
      failedCount,
      errorMsg?.slice(0, 2000) ?? null
    )
    .run();
}

export async function listManualReviewTasks(
  db: D1Database,
  status?: "pending" | "acknowledged" | "processing" | "resolved" | "closed",
  limit = 100
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
         LIMIT ?`
      )
      .bind(status, limit)
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
       LIMIT ?`
    )
    .bind(limit)
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

export async function updateManualReviewTaskStatus(
  db: D1Database,
  id: string,
  status: "acknowledged" | "processing" | "resolved" | "closed",
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

export async function listOverdueManualReviews(
  db: D1Database
): Promise<Array<{ id: string; email_id: string; priority_level: string; status: string; created_at: string }>> {
  const rows = await db
    .prepare(
      `SELECT id, email_id, priority_level, status, created_at
       FROM manual_review_tasks
       WHERE status IN ('pending', 'acknowledged', 'processing')
       ORDER BY created_at ASC`
    )
    .all<{ id: string; email_id: string; priority_level: string; status: string; created_at: string }>();
  return rows.results ?? [];
}

export async function createPromptTemplate(
  db: D1Database,
  name: string,
  version: string,
  content: string,
  outputSchema?: string,
  createdBy?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO prompt_templates (id, name, version, content, output_schema, created_by, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      name,
      version,
      content,
      outputSchema ?? null,
      createdBy ?? null,
      0
    )
    .run();
}

export async function activatePromptTemplate(
  db: D1Database,
  name: string,
  version: string
): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE prompt_templates SET is_active = 0 WHERE name = ?`).bind(name),
    db
      .prepare(`UPDATE prompt_templates SET is_active = 1 WHERE name = ? AND version = ?`)
      .bind(name, version)
  ]);
}

export async function listPromptTemplates(
  db: D1Database,
  name?: string
): Promise<
  Array<{
    id: string;
    name: string;
    version: string;
    is_active: number;
    created_at: string;
  }>
> {
  if (name) {
    const rows = await db
      .prepare(
        `SELECT id, name, version, is_active, created_at
         FROM prompt_templates
         WHERE name = ?
         ORDER BY created_at DESC`
      )
      .bind(name)
      .all<{ id: string; name: string; version: string; is_active: number; created_at: string }>();
    return rows.results ?? [];
  }

  const rows = await db
    .prepare(
      `SELECT id, name, version, is_active, created_at
       FROM prompt_templates
       ORDER BY created_at DESC`
    )
    .all<{ id: string; name: string; version: string; is_active: number; created_at: string }>();
  return rows.results ?? [];
}

export async function getAIClassificationByEmailId(
  db: D1Database,
  emailId: string
): Promise<AIClassification | null> {
  const row = await db
    .prepare(
      `SELECT category, subcategory, sentiment, priority, language, summary, tags, requires_reply,
              extracted_json, confidence_score
       FROM email_ai_results
       WHERE email_id = ?`
    )
    .bind(emailId)
    .first<{
      category: AIClassification["category"];
      subcategory: string | null;
      sentiment: AIClassification["sentiment"];
      priority: number;
      language: string | null;
      summary: string | null;
      tags: string | null;
      requires_reply: number | null;
      extracted_json: string | null;
      confidence_score: number | null;
    }>();
  if (!row) return null;

  let tags: string[] = [];
  let extractedEntities: AIClassification["extractedEntities"] = {
    amounts: [],
    dates: [],
    persons: [],
    companies: [],
    orderIds: [],
    urls: []
  };

  try {
    tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    tags = [];
  }

  try {
    extractedEntities = row.extracted_json
      ? (JSON.parse(row.extracted_json) as AIClassification["extractedEntities"])
      : extractedEntities;
  } catch {
    extractedEntities = {
      amounts: [],
      dates: [],
      persons: [],
      companies: [],
      orderIds: [],
      urls: []
    };
  }

  return {
    category: row.category,
    subcategory: row.subcategory ?? undefined,
    sentiment: row.sentiment,
    priority: normalizePriority(row.priority),
    language: row.language ?? "unknown",
    summary: row.summary ?? "",
    tags,
    requiresReply: Boolean(row.requires_reply),
    estimatedReplyDeadline: null,
    extractedEntities,
    suggestedActions: [],
    confidenceScore: row.confidence_score ?? 0
  };
}

export interface AdminEmailListFilters {
  status?: string;
  category?: string;
  priority?: number;
  fromDate?: string;
  toDate?: string;
  requiresManualReview?: boolean;
  limit?: number;
  offset?: number;
}

export async function listAdminEmails(
  db: D1Database,
  filters: AdminEmailListFilters
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

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);
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

export async function getAdminEmailDetail(
  db: D1Database,
  emailId: string
): Promise<{
  email: {
    id: string;
    email_message_id: string | null;
    thread_id: string | null;
    received_at: string;
    to_address: string;
    from_address: string;
    from_name: string | null;
    subject: string;
    text_body: string | null;
    status: string;
    last_error: string | null;
    raw_r2_key: string | null;
    parsed_r2_key: string | null;
    has_attachments: number | null;
  };
  aiResult: {
    category: string | null;
    subcategory: string | null;
    sentiment: string | null;
    priority: number | null;
    language: string | null;
    summary: string | null;
    tags: string | null;
    requires_reply: number | null;
    extracted_json: string | null;
    confidence_score: number | null;
    ai_provider: string | null;
    ai_model: string | null;
    processing_ms: number | null;
    reply_draft: string | null;
    reply_draft_json: string | null;
    created_at: string | null;
  } | null;
  aiRaw: {
    id: string;
    provider: string | null;
    model: string | null;
    request_json_redacted: string | null;
    response_text: string | null;
    response_json: string | null;
    created_at: string;
  } | null;
  attachments: Array<{ filename: string; mime_type: string | null; size_bytes: number | null; r2_key: string | null }>;
  actionLogs: Array<{
    id: string;
    action_type: string;
    action_config: string | null;
    status: string | null;
    error_msg: string | null;
    executed_at: string;
  }>;
  manualReviews: Array<{
    id: string;
    priority_level: string;
    reason: string;
    status: string;
    assignee: string | null;
    created_at: string;
  }>;
} | null> {
  const email = await db
    .prepare(
      `SELECT id, email_message_id, thread_id, received_at, to_address, from_address, from_name, subject,
              text_body, status, last_error, raw_r2_key, parsed_r2_key, has_attachments
       FROM emails
       WHERE id = ?`
    )
    .bind(emailId)
    .first<{
      id: string;
      email_message_id: string | null;
      thread_id: string | null;
      received_at: string;
      to_address: string;
      from_address: string;
      from_name: string | null;
      subject: string;
      text_body: string | null;
      status: string;
      last_error: string | null;
      raw_r2_key: string | null;
      parsed_r2_key: string | null;
      has_attachments: number | null;
    }>();
  if (!email) return null;

  const [aiRows, aiRawRows, attachmentRows, actionRows, reviewRows] = await Promise.all([
    db
      .prepare(
        `SELECT category, subcategory, sentiment, priority, language, summary, tags, requires_reply,
                extracted_json, confidence_score, ai_provider, ai_model, processing_ms, reply_draft, reply_draft_json, created_at
         FROM email_ai_results
         WHERE email_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(emailId)
      .all<{
        category: string | null;
        subcategory: string | null;
        sentiment: string | null;
        priority: number | null;
        language: string | null;
        summary: string | null;
        tags: string | null;
        requires_reply: number | null;
        extracted_json: string | null;
        confidence_score: number | null;
        ai_provider: string | null;
        ai_model: string | null;
        processing_ms: number | null;
        reply_draft: string | null;
        reply_draft_json: string | null;
        created_at: string | null;
      }>(),
    db
      .prepare(
        `SELECT id, provider, model, request_json_redacted, response_text, response_json, created_at
         FROM ai_raw_responses
         WHERE email_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(emailId)
      .all<{
        id: string;
        provider: string | null;
        model: string | null;
        request_json_redacted: string | null;
        response_text: string | null;
        response_json: string | null;
        created_at: string;
      }>(),
    db
      .prepare(
        `SELECT filename, mime_type, size_bytes, r2_key
         FROM attachments
         WHERE email_id = ?
         ORDER BY created_at DESC`
      )
      .bind(emailId)
      .all<{ filename: string; mime_type: string | null; size_bytes: number | null; r2_key: string | null }>(),
    db
      .prepare(
        `SELECT id, action_type, action_config, status, error_msg, executed_at
         FROM action_logs
         WHERE email_id = ?
         ORDER BY executed_at DESC`
      )
      .bind(emailId)
      .all<{
        id: string;
        action_type: string;
        action_config: string | null;
        status: string | null;
        error_msg: string | null;
        executed_at: string;
      }>(),
    db
      .prepare(
        `SELECT id, priority_level, reason, status, assignee, created_at
         FROM manual_review_tasks
         WHERE email_id = ?
         ORDER BY created_at DESC`
      )
      .bind(emailId)
      .all<{
        id: string;
        priority_level: string;
        reason: string;
        status: string;
        assignee: string | null;
        created_at: string;
      }>()
  ]);

  return {
    email,
    aiResult: (aiRows.results ?? [])[0] ?? null,
    aiRaw: (aiRawRows.results ?? [])[0] ?? null,
    attachments: attachmentRows.results ?? [],
    actionLogs: actionRows.results ?? [],
    manualReviews: reviewRows.results ?? []
  };
}

export async function listProcessingEventsByEmail(
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

function normalizePriority(priority: number): 1 | 2 | 3 | 4 | 5 {
  if (priority <= 1) return 1;
  if (priority === 2) return 2;
  if (priority === 3) return 3;
  if (priority === 4) return 4;
  return 5;
}
