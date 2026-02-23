import { z } from "zod";
import type { AIClassifyResult, AIClassification, Env, QueueMessage } from "./types";

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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export class AIGatewayOpenAIService {
  constructor(private readonly env: Env) {}

  async classify(message: QueueMessage): Promise<AIClassifyResult> {
    const model = this.env.DEFAULT_AI_MODEL ?? "openai/gpt-5-mini";
    const prompt = buildClassificationPrompt(message);
    const content = await this.chat(model, prompt, 0.1, 1024);
    const parsed = parseJsonFromText(content);
    return {
      classification: classificationSchema.parse(parsed) as AIClassification,
      provider: "ai-gateway-openai-compat",
      model
    };
  }

  private async chat(
    model: string,
    userPrompt: string,
    temperature: number,
    maxTokens: number
  ): Promise<string> {
    const url = `https://gateway.ai.cloudflare.com/v1/${this.env.CF_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/compat/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (this.env.OPENAI_API_KEY) {
      headers.Authorization = `Bearer ${this.env.OPENAI_API_KEY}`;
    }
    if (this.env.CF_AIG_TOKEN) {
      headers["cf-aig-authorization"] = `Bearer ${this.env.CF_AIG_TOKEN}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          {
            role: "system",
            content:
              "You are a strict email classification assistant. Output pure JSON only and do not wrap with markdown."
          },
          {
            role: "user",
            content: userPrompt
          }
        ]
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(`AI gateway request failed: HTTP ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("\n");
    return "{}";
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

async function classifyWithWorkersOrHeuristic(
  env: Env,
  message: QueueMessage
): Promise<AIClassifyResult> {
  if (env.AI) {
    try {
      const fallbackModel = env.FALLBACK_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
      const prompt = buildClassificationPrompt(message);
      const res = (await env.AI.run(fallbackModel as keyof AiModels, {
        prompt: `Return strict JSON only.\n${prompt}`,
        max_tokens: 800
      })) as { response?: string };
      const parsed = parseJsonFromText(res.response ?? "{}");
      return {
        classification: classificationSchema.parse(parsed) as AIClassification,
        provider: "workers-ai",
        model: fallbackModel
      };
    } catch (err) {
      console.error("Workers AI fallback failed:", err);
    }
  }
  return {
    classification: buildHeuristicClassification(message),
    provider: "heuristic",
    model: "heuristic-v1"
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
