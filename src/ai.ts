import { z } from "zod";
import type {
  AIClassifyResult,
  AIClassification,
  AIReplyDraft,
  AIReplyDraftResult,
  Env,
  QueueMessage
} from "./types";

const classificationSchema = z.object({
  category: z
    .enum([
      "invoice",
      "support",
      "personal",
      "promo",
      "newsletter",
      "spam",
      "urgent",
      "legal",
      "other"
    ])
    .default("other"),
  subcategory: z.string().optional(),
  sentiment: z.enum(["positive", "neutral", "negative", "urgent"]).default("neutral"),
  priority: z.number().int().min(1).max(5).default(3),
  language: z.string().default("en"),
  summary: z.string().default("No summary"),
  tags: z.array(z.string()).default([]),
  requiresReply: z.boolean().default(false),
  estimatedReplyDeadline: z.string().nullable().default(null),
  extractedEntities: z
    .object({
      amounts: z.array(z.object({ value: z.number(), currency: z.string(), context: z.string() })).default([]),
      dates: z.array(z.object({ date: z.string(), context: z.string() })).default([]),
      persons: z.array(z.string()).default([]),
      companies: z.array(z.string()).default([]),
      orderIds: z.array(z.string()).default([]),
      urls: z.array(z.string()).default([])
    })
    .default({
      amounts: [],
      dates: [],
      persons: [],
      companies: [],
      orderIds: [],
      urls: []
    }),
  suggestedActions: z.array(z.string()).default([]),
  confidenceScore: z.number().min(0).max(1).default(0.6)
});

const replyDraftSchema = z.object({
  subject: z.string().min(1).max(200).default("Re: Your message"),
  body: z.string().min(1).max(6000).default("Thank you for your email."),
  tone: z.enum(["formal", "casual", "empathetic"]).default("formal"),
  language: z.string().default("en"),
  placeholders: z.array(z.string()).default([]),
  autoSendSafe: z.boolean().default(false)
});

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface ChatResult {
  content: string;
  requestJsonRedacted: string;
  responseText: string;
  responseJson: string;
}

export class AIGatewayOpenAIService {
  constructor(private readonly env: Env) {}

  async classify(message: QueueMessage): Promise<AIClassifyResult> {
    const model = this.env.DEFAULT_AI_MODEL ?? "openai/gpt-5-mini";
    const prompt = buildClassificationPrompt(message);
    const chatResult = await runAIGatewayChat(this.env, model, {
      systemPrompt:
        "You are a strict email classification assistant. Output pure JSON only and do not wrap with markdown.",
      userPrompt: prompt,
      temperature: 0.1,
      maxTokens: 1024
    });
    const parsed = parseJsonFromText(chatResult.content);
    return {
      classification: classificationSchema.parse(parsed) as AIClassification,
      provider: "ai-gateway-openai-compat",
      model,
      rawTrace: {
        requestJsonRedacted: chatResult.requestJsonRedacted,
        responseText: chatResult.responseText,
        responseJson: chatResult.responseJson
      }
    };
  }
}

export function buildHeuristicClassification(message: QueueMessage): AIClassification {
  const text = `${message.subject} ${message.textBody}`.toLowerCase();
  const category = /invoice|receipt|payment|billing/.test(text)
    ? "invoice"
    : /promo|discount|sale/.test(text)
      ? "promo"
      : /newsletter|weekly|digest/.test(text)
        ? "newsletter"
        : /urgent|asap|immediately|security/.test(text)
          ? "urgent"
          : /support|bug|issue|error/.test(text)
            ? "support"
            : "other";

  const priority = category === "urgent" ? 5 : category === "support" ? 4 : 3;
  const summary = message.textBody.slice(0, 120) || message.subject || "No content";

  return {
    category,
    sentiment: category === "urgent" ? "urgent" : "neutral",
    priority,
    language: "unknown",
    summary,
    tags: [category],
    requiresReply: category === "support" || category === "urgent",
    estimatedReplyDeadline: null,
    extractedEntities: {
      amounts: [],
      dates: [],
      persons: [],
      companies: [],
      orderIds: [],
      urls: []
    },
    suggestedActions: [],
    confidenceScore: 0.5
  };
}

export async function classifyEmail(env: Env, message: QueueMessage): Promise<AIClassifyResult> {
  if (!env.OPENAI_API_KEY && !env.CF_AIG_TOKEN) {
    return await classifyWithWorkersOrHeuristic(env, message);
  }

  try {
    const service = new AIGatewayOpenAIService(env);
    return await service.classify(message);
  } catch (err) {
    console.error("AI classify failed, fallback to Workers AI / heuristic:", err);
    return await classifyWithWorkersOrHeuristic(env, message);
  }
}

export async function generateReplyDraft(
  env: Env,
  message: QueueMessage,
  classification: AIClassification
): Promise<AIReplyDraftResult> {
  if (!env.OPENAI_API_KEY && !env.CF_AIG_TOKEN) {
    return await generateReplyWithWorkersOrHeuristic(env, message, classification);
  }

  try {
    const model = env.DEFAULT_AI_MODEL ?? "openai/gpt-5-mini";
    const prompt = buildReplyPrompt(message, classification);
    const chatResult = await runAIGatewayChat(env, model, {
      systemPrompt:
        "You are an email reply assistant. Return strict JSON only. Do not include markdown.",
      userPrompt: prompt,
      temperature: 0.2,
      maxTokens: 1200
    });
    const parsed = parseJsonFromText(chatResult.content);
    return {
      draft: replyDraftSchema.parse(parsed) as AIReplyDraft,
      provider: "ai-gateway-openai-compat",
      model,
      rawTrace: {
        requestJsonRedacted: chatResult.requestJsonRedacted,
        responseText: chatResult.responseText,
        responseJson: chatResult.responseJson
      }
    };
  } catch (err) {
    console.error("AI reply draft failed, fallback to Workers AI / heuristic:", err);
    return await generateReplyWithWorkersOrHeuristic(env, message, classification);
  }
}

async function classifyWithWorkersOrHeuristic(
  env: Env,
  message: QueueMessage
): Promise<AIClassifyResult> {
  if (env.AI) {
    try {
      const fallbackModel = env.FALLBACK_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
      const prompt = buildClassificationPrompt(message);
      const workersRequest = {
        model: fallbackModel,
        prompt: `Return strict JSON only.\n${prompt}`,
        max_tokens: 800
      };
      const res = (await env.AI.run(fallbackModel as keyof AiModels, {
        prompt: workersRequest.prompt,
        max_tokens: 800
      })) as { response?: string };
      const parsed = parseJsonFromText(res.response ?? "{}");
      return {
        classification: classificationSchema.parse(parsed) as AIClassification,
        provider: "workers-ai",
        model: fallbackModel,
        rawTrace: {
          requestJsonRedacted: safeJsonStringify(redactObjectDeep(workersRequest)),
          responseText: res.response ?? "",
          responseJson: safeJsonStringify(res)
        }
      };
    } catch (err) {
      console.error("Workers AI fallback failed:", err);
    }
  }
  const heuristic = buildHeuristicClassification(message);
  return {
    classification: heuristic,
    provider: "heuristic",
    model: "heuristic-v1",
    rawTrace: {
      requestJsonRedacted: safeJsonStringify({
        reason: "OPENAI_API_KEY and CF_AIG_TOKEN are missing, and Workers AI unavailable",
        subject: redactPII(message.subject),
        from: redactPII(message.from)
      }),
      responseText: safeJsonStringify(heuristic),
      responseJson: safeJsonStringify(heuristic)
    }
  };
}

function buildClassificationPrompt(message: QueueMessage): string {
  return [
    "Classify this email and return one JSON object with fields:",
    "category, subcategory, sentiment, priority, language, summary, tags, requiresReply, estimatedReplyDeadline, extractedEntities, suggestedActions, confidenceScore.",
    "Use category enum: invoice, support, personal, promo, newsletter, spam, urgent, legal, other.",
    "summary must be concise and <= 50 Chinese characters or <= 120 English characters.",
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Body: ${message.textBody}`
  ].join("\n");
}

function buildReplyPrompt(message: QueueMessage, classification: AIClassification): string {
  return [
    "Draft a professional email reply and return one JSON object with fields:",
    "subject, body, tone, language, placeholders, autoSendSafe.",
    "Rules:",
    "- body should be concise and specific to the message.",
    "- if information is missing, set placeholders and autoSendSafe=false.",
    "- avoid legal promises and monetary commitments unless explicit in source.",
    `From (sender of original email): ${message.from}`,
    `To (our inbox alias): ${message.to}`,
    `Original subject: ${message.subject}`,
    `Original body: ${message.textBody}`,
    `Classification summary: ${classification.summary}`,
    `Category: ${classification.category}`,
    `Priority: ${classification.priority}`,
    `Requires reply: ${classification.requiresReply}`
  ].join("\n");
}

function parseJsonFromText(raw: string): unknown {
  const mdBlock = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = mdBlock?.[1] ?? raw;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const jsonText =
    firstBrace >= 0 && lastBrace >= firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate;
  return JSON.parse(jsonText);
}

function redactObjectDeep(value: unknown): unknown {
  if (typeof value === "string") return redactPII(value);
  if (Array.isArray(value)) return value.map((item) => redactObjectDeep(item));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactObjectDeep(inner);
  }
  return out;
}

function redactPII(input: string): string {
  return input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

async function runAIGatewayChat(
  env: Env,
  model: string,
  args: {
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    maxTokens: number;
  }
): Promise<ChatResult> {
  const requestPayload = {
    model,
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    messages: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userPrompt }
    ]
  };

  const commonHeaders: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (env.OPENAI_API_KEY) commonHeaders.Authorization = `Bearer ${env.OPENAI_API_KEY}`;

  const gatewayConfigured = Boolean(env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID);
  if (gatewayConfigured) {
    const gatewayHeaders = { ...commonHeaders };
    if (env.CF_AIG_TOKEN) gatewayHeaders["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
    const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/compat/chat/completions`;

    const gatewayResponse = await fetch(gatewayUrl, {
      method: "POST",
      headers: gatewayHeaders,
      body: JSON.stringify(requestPayload),
      signal: AbortSignal.timeout(30000)
    });
    const gatewayBody = await gatewayResponse.text();

    if (gatewayResponse.ok) {
      return parseChatResult(requestPayload, gatewayBody);
    }

    if (canFallbackToDirectOpenAI(gatewayResponse.status, gatewayBody, env.OPENAI_BASE_URL)) {
      return await runDirectOpenAICompatChat(env.OPENAI_BASE_URL as string, commonHeaders, requestPayload);
    }
    throw new Error(`AI gateway request failed: HTTP ${gatewayResponse.status} ${gatewayBody}`);
  }

  if (env.OPENAI_BASE_URL) {
    return await runDirectOpenAICompatChat(env.OPENAI_BASE_URL, commonHeaders, requestPayload);
  }
  throw new Error("Neither AI Gateway nor OPENAI_BASE_URL is configured");
}

async function generateReplyWithWorkersOrHeuristic(
  env: Env,
  message: QueueMessage,
  classification: AIClassification
): Promise<AIReplyDraftResult> {
  if (env.AI) {
    try {
      const fallbackModel = env.FALLBACK_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
      const prompt = buildReplyPrompt(message, classification);
      const workersRequest = {
        model: fallbackModel,
        prompt: `Return strict JSON only.\n${prompt}`,
        max_tokens: 900
      };
      const res = (await env.AI.run(fallbackModel as keyof AiModels, {
        prompt: workersRequest.prompt,
        max_tokens: workersRequest.max_tokens
      })) as { response?: string };
      const parsed = parseJsonFromText(res.response ?? "{}");
      return {
        draft: replyDraftSchema.parse(parsed) as AIReplyDraft,
        provider: "workers-ai",
        model: fallbackModel,
        rawTrace: {
          requestJsonRedacted: safeJsonStringify(redactObjectDeep(workersRequest)),
          responseText: res.response ?? "",
          responseJson: safeJsonStringify(res)
        }
      };
    } catch (err) {
      console.error("Workers AI reply fallback failed:", err);
    }
  }

  const heuristic = buildHeuristicReplyDraft(message, classification);
  return {
    draft: heuristic,
    provider: "heuristic",
    model: "heuristic-reply-v1",
    rawTrace: {
      requestJsonRedacted: safeJsonStringify({
        reason: "AI provider unavailable, generated heuristic reply",
        from: redactPII(message.from),
        subject: redactPII(message.subject)
      }),
      responseText: safeJsonStringify(heuristic),
      responseJson: safeJsonStringify(heuristic)
    }
  };
}

function buildHeuristicReplyDraft(
  message: QueueMessage,
  classification: AIClassification
): AIReplyDraft {
  const baseSubject = message.subject ? `Re: ${message.subject}` : "Re: Your message";
  const body = [
    "Hello,",
    "",
    "Thank you for your email. We have received your message and are reviewing it.",
    classification.summary ? `Summary we captured: ${classification.summary}` : "",
    "We will follow up shortly with next steps.",
    "",
    "Best regards,",
    "SmartMail Team"
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject: baseSubject.slice(0, 200),
    body,
    tone: "formal",
    language: classification.language || "en",
    placeholders: [],
    autoSendSafe: false
  };
}

function parseChatResult(requestPayload: unknown, rawBodyText: string): ChatResult {
  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(rawBodyText) as ChatCompletionResponse;
  } catch {
    throw new Error("AI provider returned non-JSON response");
  }
  const content = body.choices?.[0]?.message?.content;
  return {
    content:
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c) => c.text ?? "").join("\n")
          : "{}",
    requestJsonRedacted: safeJsonStringify(redactObjectDeep(requestPayload)),
    responseText: rawBodyText,
    responseJson: safeJsonStringify(body)
  };
}

function canFallbackToDirectOpenAI(
  status: number,
  body: string,
  openaiBaseUrl?: string
): boolean {
  if (!openaiBaseUrl) return false;
  if (status >= 500) return true;
  if (status === 400 && /configure AI Gateway|gateway/i.test(body)) return true;
  return false;
}

async function runDirectOpenAICompatChat(
  openaiBaseUrl: string,
  headers: Record<string, string>,
  requestPayload: unknown
): Promise<ChatResult> {
  const base = openaiBaseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestPayload),
    signal: AbortSignal.timeout(30000)
  });
  const rawBodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed: HTTP ${response.status} ${rawBodyText}`);
  }
  return parseChatResult(requestPayload, rawBodyText);
}
