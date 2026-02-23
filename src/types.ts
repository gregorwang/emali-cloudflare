export interface Env {
  EMAIL_QUEUE: Queue<QueueMessage>;
  DB: D1Database;
  STORAGE: R2Bucket;
  CONFIG: KVNamespace;
  AI: Ai;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
  CUSTOM_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  REPLY_FROM_EMAIL?: string;
  DASHBOARD_API_SECRET?: string;
  INTERNAL_API_SECRET?: string;
  AUTO_SEND_REPLY?: string;
  AUTO_SEND_MIN_CONFIDENCE?: string;
  MAX_TEXT_BODY_LENGTH?: string;
  MAX_QUEUE_MESSAGE_BYTES?: string;
  RETENTION_DAYS_EMAILS?: string;
  DEFAULT_AI_MODEL?: string;
  FALLBACK_AI_MODEL?: string;
}

export interface QueueMessage {
  messageId: string;
  emailId: string;
  receivedAt: string;
  to: string;
  from: string;
  fromName: string;
  subject: string;
  textBody: string;
  hasHtml: boolean;
  attachments: AttachmentMeta[];
  rawR2Key: string;
  parsedR2Key?: string;
  bodyTruncated?: boolean;
  threadId?: string;
  priority: "high" | "normal" | "low";
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  r2Key?: string;
}

export interface AIClassification {
  category:
    | "invoice"
    | "support"
    | "personal"
    | "promo"
    | "newsletter"
    | "spam"
    | "urgent"
    | "legal"
    | "other";
  subcategory?: string;
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  priority: 1 | 2 | 3 | 4 | 5;
  language: string;
  summary: string;
  tags: string[];
  requiresReply: boolean;
  estimatedReplyDeadline: string | null;
  extractedEntities: {
    amounts: Array<{ value: number; currency: string; context: string }>;
    dates: Array<{ date: string; context: string }>;
    persons: string[];
    companies: string[];
    orderIds: string[];
    urls: string[];
  };
  suggestedActions: string[];
  confidenceScore: number;
}

export interface AIClassifyResult {
  classification: AIClassification;
  provider: string;
  model: string;
  rawTrace?: AIRawTrace;
}

export interface AIReplyDraft {
  subject: string;
  body: string;
  tone: "formal" | "casual" | "empathetic";
  language: string;
  placeholders: string[];
  autoSendSafe: boolean;
}

export interface AIReplyDraftResult {
  draft: AIReplyDraft;
  provider: string;
  model: string;
  rawTrace?: AIRawTrace;
}

export interface AIRawTrace {
  requestJsonRedacted?: string;
  responseText?: string;
  responseJson?: string;
}

export interface ActionRuleConfig {
  spamAction?: "drop" | "archive";
  urgentPriorityThreshold?: number;
  invoiceSlackAmountThreshold?: number;
  enableSlackNotify?: boolean;
  enableCustomWebhook?: boolean;
  autoCreateManualReview?: boolean;
}
