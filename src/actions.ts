import { createManualReviewTask, insertActionLog, markEmailStatus } from "./db";
import type { AIClassification, AIReplyDraft, ActionRuleConfig, Env, QueueMessage } from "./types";

const defaultRules: Required<ActionRuleConfig> = {
  spamAction: "drop",
  urgentPriorityThreshold: 4,
  invoiceSlackAmountThreshold: 1000,
  enableSlackNotify: true,
  enableCustomWebhook: false,
  autoCreateManualReview: true
};

export async function executePostAIFlow(
  env: Env,
  payload: QueueMessage,
  classification: AIClassification
): Promise<{ manualReviewCreated: boolean }> {
  const rules = await loadRules(env.CONFIG, payload.to);

  await runNotifications(env, payload, classification, rules);
  const manualReviewCreated = await maybeCreateManualReview(env, payload, classification, rules);
  return { manualReviewCreated };
}

export async function maybeSendReplyDraft(
  env: Env,
  payload: QueueMessage,
  classification: AIClassification,
  draft: AIReplyDraft
): Promise<{ sent: boolean; reason?: string }> {
  if (!env.RESEND_API_KEY || !env.REPLY_FROM_EMAIL) {
    return { sent: false, reason: "missing resend config" };
  }

  const autoEnabled = String(env.AUTO_SEND_REPLY ?? "false").toLowerCase() === "true";
  if (!autoEnabled) {
    return { sent: false, reason: "auto send disabled" };
  }

  const minConfidence = Number.parseFloat(env.AUTO_SEND_MIN_CONFIDENCE ?? "0.85");
  if (!Number.isFinite(minConfidence)) {
    return { sent: false, reason: "invalid AUTO_SEND_MIN_CONFIDENCE" };
  }

  if (!draft.autoSendSafe) {
    return { sent: false, reason: "draft autoSendSafe=false" };
  }
  if (classification.confidenceScore < minConfidence) {
    return { sent: false, reason: `confidence below threshold ${minConfidence}` };
  }

  await sendReplyViaResend(env, payload, draft);
  await insertActionLog(
    env.DB,
    payload.messageId,
    "reply_sent_resend",
    {
      mode: "auto",
      to: payload.from,
      from: env.REPLY_FROM_EMAIL,
      autoSendSafe: draft.autoSendSafe
    },
    "success"
  );
  return { sent: true };
}

export async function sendReplyDraftNow(
  env: Env,
  payload: QueueMessage,
  draft: AIReplyDraft
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.REPLY_FROM_EMAIL) {
    throw new Error("RESEND_API_KEY or REPLY_FROM_EMAIL is not configured");
  }
  await sendReplyViaResend(env, payload, draft);
  await insertActionLog(
    env.DB,
    payload.messageId,
    "reply_sent_resend",
    {
      mode: "manual",
      to: payload.from,
      from: env.REPLY_FROM_EMAIL
    },
    "success"
  );
}

async function loadRules(config: KVNamespace, toAddress: string): Promise<Required<ActionRuleConfig>> {
  const [aliasRule, globalRule] = await Promise.all([
    config.get(`rules:${toAddress}`),
    config.get("rules:*")
  ]);

  let parsed: ActionRuleConfig = {};
  const raw = aliasRule ?? globalRule;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as ActionRuleConfig;
    } catch (err) {
      console.error("Invalid rules json, fallback to default", err);
    }
  }
  return {
    ...defaultRules,
    ...parsed
  };
}

async function runNotifications(
  env: Env,
  payload: QueueMessage,
  classification: AIClassification,
  rules: Required<ActionRuleConfig>
): Promise<void> {
  const shouldNotify =
    (classification.priority >= rules.urgentPriorityThreshold && rules.enableSlackNotify) ||
    classification.requiresReply;

  if (classification.category === "spam" && rules.spamAction === "drop") {
    await insertActionLog(env.DB, payload.messageId, "drop_spam", { category: classification.category }, "success");
    return;
  }

  if (shouldNotify && env.SLACK_WEBHOOK_URL) {
    try {
      await sendSlack(env.SLACK_WEBHOOK_URL, payload, classification);
      await insertActionLog(
        env.DB,
        payload.messageId,
        "notify_slack",
        { priority: classification.priority, category: classification.category },
        "success"
      );
    } catch (err) {
      await insertActionLog(
        env.DB,
        payload.messageId,
        "notify_slack",
        { priority: classification.priority, category: classification.category },
        "failed",
        err instanceof Error ? err.message : "slack notify error"
      );
    }
  }

  if (rules.enableCustomWebhook && env.CUSTOM_WEBHOOK_URL) {
    try {
      await fetch(env.CUSTOM_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailId: payload.messageId,
          to: payload.to,
          from: payload.from,
          subject: payload.subject,
          classification
        })
      });
      await insertActionLog(env.DB, payload.messageId, "notify_webhook", { target: "custom" }, "success");
    } catch (err) {
      await insertActionLog(
        env.DB,
        payload.messageId,
        "notify_webhook",
        { target: "custom" },
        "failed",
        err instanceof Error ? err.message : "webhook notify error"
      );
    }
  }
}

async function sendSlack(
  webhookUrl: string,
  payload: QueueMessage,
  classification: AIClassification
): Promise<void> {
  const text = [
    `SmartMail 告警`,
    `分类: ${classification.category}`,
    `优先级: ${classification.priority}`,
    `主题: ${payload.subject || "(no subject)"}`,
    `发件人: ${payload.from}`,
    `摘要: ${classification.summary}`
  ].join("\n");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
    throw new Error(`slack webhook failed: HTTP ${res.status}`);
  }
}

async function maybeCreateManualReview(
  env: Env,
  payload: QueueMessage,
  classification: AIClassification,
  rules: Required<ActionRuleConfig>
): Promise<boolean> {
  if (!rules.autoCreateManualReview) return false;

  const lowConfidence = classification.confidenceScore < 0.6;
  const highRiskCategory = classification.category === "legal" || classification.category === "urgent";
  if (!lowConfidence && !highRiskCategory) return false;

  const priority: "P0" | "P1" | "P2" = classification.category === "legal" ? "P0" : lowConfidence ? "P2" : "P1";
  const reason = lowConfidence
    ? `Low confidence score: ${classification.confidenceScore}`
    : `High risk category: ${classification.category}`;

  await createManualReviewTask(env.DB, payload.messageId, priority, reason);
  await insertActionLog(env.DB, payload.messageId, "manual_review_created", { reason, priority }, "success");
  await markEmailStatus(env.DB, payload.messageId, "manual_review");
  return true;
}

async function sendReplyViaResend(
  env: Env,
  payload: QueueMessage,
  draft: AIReplyDraft
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.REPLY_FROM_EMAIL,
      to: [payload.from],
      subject: draft.subject,
      text: draft.body,
      reply_to: payload.to
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend send failed: HTTP ${res.status} ${body}`);
  }
}
