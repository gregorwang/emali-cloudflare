import { createManualReviewTask, insertActionLog, markEmailStatus } from "./db";
import type { AIClassification, ActionRuleConfig, Env, QueueMessage } from "./types";

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
