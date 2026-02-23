# PRD 文档：SmartMail AI（智能邮件助手）

**版本**：v1.3  
**更新日期**：2026 年 2 月 23 日  
**状态**：Ready for Development

---

## 1. 产品概述

### 1.1 背景与定位

SmartMail AI 是一套基于 Cloudflare 全栈无服务器架构的**智能邮件自动化处理系统**，核心目标是以极低成本（免费额度内）实现企业/个人邮件的 AI 化管理。区别于 Zapier/Make 等 SaaS 工具，本系统数据完全自托管于 Cloudflare，隐私可控，且支持任意第三方 AI 模型的热插拔配置。

### 1.2 一句话描述

> 用 Cloudflare 全栈零服务器服务搭建的智能邮件管家，以 OpenAI 格式接口为默认 AI 接入方式，支持自动分类、关键信息提取、智能回复草稿、存档与多渠道通知，成本几乎为零。

### 1.3 核心价值主张

| 维度         | 传统方案             | SmartMail AI                 |
| ------------ | -------------------- | ---------------------------- |
| 基础设施成本 | $20-200/月（服务器） | $0（Cloudflare 免费额度）    |
| AI 成本      | 按 SaaS 定价         | 仅付实际 token（可控）       |
| 数据主权     | 第三方持有           | 完全在 Cloudflare 内         |
| 部署复杂度   | 高（K8s/Docker）     | 低（`wrangler deploy`）      |
| 全球延迟     | 取决于服务器位置     | 边缘节点，全球 <50ms         |
| AI 可换性    | 绑定特定服务         | 任意模型，Dashboard 一键切换 |

### 1.4 MVP 边界

**包含（MVP）**：邮件接收 → 解析 → 队列 → AI 分类+提取 → 自动回复草稿 → 存档 → Slack 通知 → 基础 Dashboard。

**不包含（v1.3+）**：RAG 向量检索、可视化规则引擎、多语言 UI、成本仪表盘、附件内容 AI 解析（如 PDF/图片 OCR）。

---

## 2. 基础设施约束与免费额度（2026 年 2 月最新确认）

这是整个架构设计的物理边界，所有设计决策必须在此约束内进行。

### 2.1 Cloudflare Queues（2026.02.04 正式对 Free 计划开放）

根据官方 Changelog（https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/）：

- **最大队列数**：10,000 个（完全够用，本项目使用约 3-5 个队列）
- **每日操作次数**：10,000 次（读 + 写 + 删除均计入）
- **消息保留时间**：**24 小时**（Free 计划，Paid 为 14 天）——这是最关键的限制，系统设计必须保证消息在 24 小时内被消费
- **Consumer 类型**：支持 Cloudflare Workers 和 HTTP Pull Consumer
- **Event Subscriptions**：无限制，全功能可用

> **设计约束**：每封邮件进队列 = 1 次写操作 + 1 次读操作 + 1 次确认删除 = 3 次操作。10,000 ops/day ÷ 3 ≈ **理论上限约 3,333 封/天**。  
> **生产建议容量**：预留重试、DLQ、规则动作的队列开销后，按 **2,000-2,500 封/天** 设计更稳妥。超过此量需升级 Paid 计划（$0.40/百万操作）。

### 2.2 Cloudflare AI Gateway

根据官方文档（https://developers.cloudflare.com/ai-gateway/usage/chat-completion/）：

- **AI Gateway 本身**：核心功能全计划免费，调用不产生额外费用
- **Free 计划日志额度**：100,000 条/天（足够 MVP 阶段）
- **MVP 统一接入方式**：使用 OpenAI 兼容端点 `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions`
- **模型命名规则**：`{provider}/{model}`，例如 `openai/gpt-5-mini`、`openai/gpt-4o-mini`
- **认证方式**：
  1. `Authorization: Bearer <PROVIDER_API_KEY>`（开发阶段最直观）
  2. `cf-aig-authorization: Bearer <CF_AIG_TOKEN>`（BYOK，生产推荐）
- **底层费用**：仅付所选模型提供商 token 费，Gateway 不加价

### 2.3 其他 Cloudflare 服务免费额度汇总

| 服务              | Free 额度                       | 本项目预计用量     | 是否充足   |
| ----------------- | ------------------------------- | ------------------ | ---------- |
| Workers           | 100,000 请求/天                 | ~10,000/天         | ✅         |
| Workers CPU       | 10ms/请求                       | 邮件解析 <5ms      | ✅         |
| D1 Database       | 5M 行读/天，100k 行写/天        | ~50k 读，5k 写     | ✅         |
| R2 Object Storage | 10GB 存储，100万 GET/月         | 视附件量而定       | ✅（MVP）  |
| KV                | 100k 读/天，1k 写/天            | 配置读取 ~5k       | ✅         |
| Pages             | 无限静态，500 Functions 调用/天 | Dashboard 静态为主 | ✅         |
| Email Routing     | 无限别名，10 自定义地址         | 按需               | ✅         |
| Workers AI        | 10,000 Neurons/天               | 仅 fallback        | ✅（有限） |

---

## 3. 目标用户与使用场景

### 3.1 主要目标用户

**个人开发者 / 独立创业者**：拥有自定义域名，日均邮件量 50-300 封，希望自动处理 support@、invoice@、contact@ 等邮件，节省人工分拣时间。

**小型 SaaS / 独立工具团队**：需要处理用户反馈邮件、自动提取 Bug Report 关键信息、生成待办任务，对接 Linear/GitHub/Slack。

**技术型个人用户**：具备基础 Cloudflare 操作能力，愿意自定义 AI 提示词和处理规则。

### 3.2 核心使用场景

**场景 A：客服邮件自动分流**

> support@company.com 收到用户邮件 → AI 识别类型（Bug/Feature Request/Billing/General） → 提取用户邮箱、产品版本、问题描述 → 根据类型自动转发到对应人员 + 发送确认回执

**场景 B：发票与合同处理**

> finance@company.com 收到发票邮件 → AI 提取供应商名、金额、日期、到期日 → 存入 D1 结构化数据库 → Slack 通知财务人员 → 附件上传 R2 存档

**场景 C：垃圾邮件与促销过滤**

> 所有 catch-all 邮件 → AI 判断 spam/promo → 直接 Drop 或静默归档（不通知）→ 高优先级邮件才触发通知

**场景 D：新闻简报摘要**

> newsletter@company.com → AI 提取要点、生成 3 条摘要 → 以 Digest 格式每日汇总发送给订阅者

---

## 4. 功能需求详细规格

### 4.1 邮件接收与入队（Email Worker）

**功能要求**：

- 支持 Cloudflare Email Routing 的 Worker 绑定，接收所有 `forward_to` 规则命中的邮件
- 使用 `postal-mime` 完整解析 MIME 结构，提取：纯文本正文、HTML 正文、所有附件（名称 + MIME 类型 + 大小 + 二进制内容），以及 Subject、From、To、CC、Reply-To、Message-ID、References、In-Reply-To 等全部 header
- 大附件处理：单个附件 > 5MB 时，仅记录 metadata，不放入队列消息体；附件内容异步上传 R2
- 黑名单校验：从 KV 读取 `blacklist:{domain}` 和 `blacklist:{email}`，命中则直接 `message.setReject("blocked")`
- 邮件队列消息体大小限制：Queues 单条消息上限约 128KB，超过时截断正文至 10,000 字符，完整内容写 R2 后仅传 R2 key

**Email Worker 消息体结构（发送至 Queues 的 JSON）**：

```ts
interface QueueMessage {
  messageId: string; // 唯一 ID，用 crypto.randomUUID()
  emailId: string; // 原始 Message-ID header
  receivedAt: string; // ISO 8601
  to: string; // 收件人地址（决定用哪套 AI 配置）
  from: string;
  fromName: string;
  subject: string;
  textBody: string; // 最多 10,000 字符
  hasHtml: boolean;
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    r2Key?: string; // 已上传 R2 时填写
  }>;
  rawR2Key: string; // 原始 .eml 文件的 R2 key
  threadId?: string; // 如果能匹配 In-Reply-To 则填入
  priority: "high" | "normal" | "low"; // 根据简单规则预判
}
```

### 4.2 AI 处理层（Queue Consumer Worker）

Queue Consumer 是系统的核心，负责所有重型计算。

**处理流程**：

1. 从队列取出消息，解析 `QueueMessage`
2. 根据 `to` 地址从 KV/D1 读取对应 `AIConfig`
3. 调用 `AIProviderFactory.create()` 获取 AI 服务实例
4. 并行执行两个 AI 调用（或合并为一个以节省 token）：
   - **调用 A**：分类 + 情感 + 优先级（结构化 JSON 输出）
   - **调用 B**（仅高优先级或 urgent 类别）：信息提取 + 回复草稿
5. 将结果写入 D1（`emails` 表 + `email_ai_results` 表）
6. 附件已在 Email Worker 上传 R2，此处更新 D1 中 attachment 记录的 R2 key
7. 根据分类结果执行动作（见 4.3）
8. 消息 ack（`message.ack()`）

**AI 分类输出 Schema（强制 JSON）**：

```json
{
  "category": "invoice | support | personal | promo | newsletter | spam | urgent | legal | other",
  "subcategory": "string（可选，如 bug_report / billing / feature_request）",
  "sentiment": "positive | neutral | negative | urgent",
  "priority": 1-5,
  "language": "zh | en | ja | ...",
  "summary": "50字以内的中文摘要",
  "tags": ["array", "of", "strings"],
  "requiresReply": true | false,
  "estimatedReplyDeadline": "ISO8601 或 null",
  "extractedEntities": {
    "amounts": [{"value": 1234.56, "currency": "CNY", "context": "发票金额"}],
    "dates": [{"date": "2026-03-01", "context": "付款截止日"}],
    "persons": ["张三", "李四"],
    "companies": ["某某公司"],
    "orderIds": ["ORD-2026-001"],
    "urls": ["https://..."]
  },
  "suggestedActions": ["forward_to_finance", "create_task", "send_receipt"],
  "confidenceScore": 0.0-1.0
}
```

**AI 智能回复草稿 Schema**：

```json
{
  "subject": "Re: 原主题",
  "body": "回复正文，保持专业友好，引用关键信息",
  "tone": "formal | casual | empathetic",
  "language": "zh | en",
  "placeholders": ["[收件人姓名]", "[订单号]"], // 需人工确认的占位符
  "autoSendSafe": false // 是否可以无人工审核直接发送
}
```

### 4.3 动作执行规则

动作通过 KV 中的规则配置（`rules:{to_address}`）定义，支持条件组合：

| 触发条件                               | 可执行动作                   | 默认行为      |
| -------------------------------------- | ---------------------------- | ------------- |
| category = "spam"                      | Drop / Silent Archive        | Drop          |
| category = "invoice" AND amount > 1000 | Slack 通知 + 归档 + 标记     | 归档          |
| priority >= 4                          | 立即 Slack 通知 + 邮件转发   | 通知          |
| requiresReply = true                   | 生成草稿 + Dashboard 待办    | 生成草稿      |
| category = "promo"                     | 静默归档，无通知             | 归档          |
| autoSendSafe = true（可配置开启）      | 直接调用 Email 发送 API 回复 | 不启用（MVP） |

**通知渠道支持**：

- Slack：Incoming Webhook，消息格式含摘要、类别、优先级
- Discord：Webhook
- 自定义 HTTP Webhook：POST JSON，包含完整 `email_summary` 对象
- 邮件转发：调用 Email Workers 的 forward 功能

### 4.4 Dashboard（Cloudflare Pages + Hono API）

**页面结构**：

- `/`：收件箱列表（分类过滤、搜索、标记已读/未读）
- `/email/:id`：邮件详情（AI 分析结果、提取实体、回复草稿、附件列表）
- `/settings/ai`：**AI Provider 配置页**（核心新功能，见下）
- `/settings/rules`：规则管理（通知条件、自动动作）
- `/settings/aliases`：邮件别名管理
- `/analytics`：处理统计（邮件量趋势、分类分布、AI 响应时延）

**AI Provider 配置页功能规格**：

- 全局默认配置：选择 Provider（下拉框）、输入模型名、API Key（密码框，提交后写入 Cloudflare Secrets）
- 按别名覆盖：为每个收件别名单独设置不同 AIConfig
- 连接测试：点击"测试"按钮，发送 `"hello"` 消息，显示响应时间和 token 消耗
- Fallback 配置：勾选"启用 Workers AI 作为 fallback"，配置触发条件（超时阈值、错误类型）
- Token 用量展示：从 D1 聚合最近 7 天 token 消耗，估算月度模型调用花费

---

## 5. AI Service Layer 完整技术规格

### 5.1 AI Gateway + OpenAI 格式集成（基于官方文档）

根据 https://developers.cloudflare.com/ai-gateway/usage/chat-completion/，Cloudflare AI Gateway 提供 OpenAI 兼容统一端点，推荐作为所有模型调用的统一入口，原因如下：

- **请求缓存**：相同 prompt 可复用，降低 token 消耗（对摘要/分类场景极有效）
- **速率限制保护**：AI Gateway 层面限流，防止超额
- **统一日志与分析**：所有 AI 调用可在 Cloudflare Dashboard 统一观测
- **BYOK 模式**：API Key 存入 Cloudflare，代码中无需明文传递

**实际调用规格（采用 OpenAI 兼容格式）**：

方式一：Provider Key 直传（开发阶段推荐）

```ts
const response = await fetch(
  `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/compat/chat/completions`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      // 如需认证 Gateway（防滥用），追加：
      // "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-5-mini", // 或从 AIConfig 读取
      max_tokens: 1024,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
  },
);
```

方式二：BYOK 模式（生产推荐，密钥托管在 Cloudflare）

```ts
// 不传 Authorization，只传 cf-aig-authorization
headers: {
  "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
  "Content-Type": "application/json",
}
```

方式三：使用 OpenAI SDK（最少改造）

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`,
});

const completion = await client.chat.completions.create({
  model: "openai/gpt-5-mini",
  messages: [{ role: "user", content: "Hello, world!" }],
});
```

### 5.2 完整 `ai.ts` 实现规格

````ts
// ============================
// types.ts
// ============================
export interface AIConfig {
  provider:
    | "ai-gateway"
    | "openai-direct"
    | "openai"
    | "workers-ai"
    | "groq";
  model: string;
  apiKey?: string; // 运行时从 env Secrets 读取，不硬编码
  accountId?: string; // AI Gateway 用
  gatewayId?: string; // AI Gateway 用
  aigAuthToken?: string; // cf-aig-authorization，BYOK 模式
  temperature?: number; // 默认 0.3（分类任务建议低温）
  maxTokens?: number; // 默认 1024
  timeoutMs?: number; // 默认 30000
  fallback?: AIConfig; // fallback 配置，可嵌套
}

// ============================
// ai.ts - 抽象基类 + 工厂
// ============================
export abstract class AIService {
  abstract chat(
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    opts?: { temperature?: number; maxTokens?: number },
  ): Promise<string>;

  // 强制 JSON 输出，内部用 system prompt 约束
  async extract<T>(
    systemPrompt: string,
    userContent: string,
    schema: object,
  ): Promise<T> {
    const fullSystem = `${systemPrompt}\n\n你必须以纯 JSON 格式输出，符合此 Schema：${JSON.stringify(schema)}。不要输出任何 JSON 以外的内容。`;
    const raw = await this.chat(
      [{ role: "user", content: userContent }],
      { temperature: 0.1 }, // 结构化提取用极低温
    );
    // 健壮的 JSON 提取（处理 markdown 代码块包裹的情况）
    const jsonMatch =
      raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[1] || jsonMatch[0] : raw) as T;
  }

  protected abstract getProviderName(): string;
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export class AIGatewayOpenAIService extends AIService {
  constructor(
    private config: AIConfig,
    private env: Env,
  ) {
    super();
  }

  async chat(messages, opts) {
    const url = `https://gateway.ai.cloudflare.com/v1/${this.config.accountId}/${this.config.gatewayId}/compat/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey)
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    if (this.config.aigAuthToken)
      headers["cf-aig-authorization"] = `Bearer ${this.config.aigAuthToken}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: opts?.maxTokens ?? this.config.maxTokens ?? 1024,
        temperature: opts?.temperature ?? this.config.temperature ?? 0.3,
        messages,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new AIProviderError(this.getProviderName(), res.status, err);
    }
    const data = (await res.json()) as OpenAIChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content.map((c) => c.text ?? "").join("\n").trim();
    return "";
  }

  protected getProviderName() {
    return "ai-gateway-openai-compat";
  }
}

export class WorkersAIService extends AIService {
  constructor(
    private ai: Ai,
    private model = "@cf/meta/llama-3.1-8b-instruct",
  ) {
    super();
  }

  async chat(messages, opts) {
    const result = (await this.ai.run(this.model, {
      messages,
      max_tokens: opts?.maxTokens ?? 512,
    })) as { response: string };
    return result.response;
  }

  protected getProviderName() {
    return "workers-ai";
  }
}

export class AIProviderError extends Error {
  constructor(
    public provider: string,
    public statusCode: number,
    public detail: string,
  ) {
    super(`[${provider}] HTTP ${statusCode}: ${detail}`);
  }
}

// 带自动 fallback 的包装器
export class AIServiceWithFallback extends AIService {
  constructor(
    private primary: AIService,
    private fallback: AIService,
  ) {
    super();
  }

  async chat(messages, opts) {
    try {
      return await this.primary.chat(messages, opts);
    } catch (e) {
      if (
        e instanceof AIProviderError &&
        [429, 529, 503, 504].includes(e.statusCode)
      ) {
        console.warn(
          `Primary AI failed (${e.statusCode}), switching to fallback`,
        );
        return await this.fallback.chat(messages, opts);
      }
      throw e;
    }
  }

  protected getProviderName() {
    return "with-fallback";
  }
}

export class AIProviderFactory {
  static create(env: Env, config: AIConfig): AIService {
    let primary: AIService;

    switch (config.provider) {
      case "ai-gateway":
        primary = new AIGatewayOpenAIService(config, env);
        break;
      case "workers-ai":
        primary = new WorkersAIService(env.AI, config.model);
        break;
      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }

    if (config.fallback) {
      const fallbackService = AIProviderFactory.create(env, config.fallback);
      return new AIServiceWithFallback(primary, fallbackService);
    }

    return primary;
  }
}
````

### 5.3 AI Prompt 设计规范

**分类 Prompt（系统提示词）**：

```
你是一个专业的邮件分类助手。分析用户提供的邮件内容，输出结构化 JSON。
规则：
- category 必须是枚举值之一
- priority 1=最低，5=最高紧急
- summary 必须是中文，50字以内
- 不要猜测附件内容（只分析正文）
- 如果邮件是自动发送的（如通知、收据），requiresReply 设为 false
```

**信息提取 Prompt 中文化示例**：提取金额时，需区分人民币/美元/欧元，并标注上下文（"发票金额"vs"税额"vs"合计"）。

**回复生成 Prompt**：

```
你是公司客服代表。根据收到的邮件生成专业回复草稿。
要求：
- 语言与来信一致（中文来信用中文回复）
- 首段必须确认收到并感谢
- 如有占位符需要人工填写，用 [方括号] 标注
- 结尾签名保持 [发件人姓名] 占位符
- autoSendSafe 默认为 false，除非内容完全确定
```

---

## 6. 数据模型完整定义

### 6.1 D1 数据库 Schema

```sql
-- 邮件主表
CREATE TABLE emails (
  id              TEXT PRIMARY KEY,           -- UUID
  email_message_id TEXT UNIQUE,               -- 原始 Message-ID header
  thread_id       TEXT,                       -- 会话 ID（基于 References header）
  received_at     DATETIME NOT NULL,
  to_address      TEXT NOT NULL,
  from_address    TEXT NOT NULL,
  from_name       TEXT,
  subject         TEXT NOT NULL,
  text_body       TEXT,                       -- 最多 10,000 字符
  has_attachments BOOLEAN DEFAULT FALSE,
  raw_r2_key      TEXT,                       -- 原始 .eml 在 R2 的 key
  status          TEXT DEFAULT 'pending',     -- pending/processing/done/error
  is_read         BOOLEAN DEFAULT FALSE,
  is_archived     BOOLEAN DEFAULT FALSE,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- AI 分析结果表（1:1 with emails）
CREATE TABLE email_ai_results (
  id              TEXT PRIMARY KEY,
  email_id        TEXT NOT NULL REFERENCES emails(id),
  category        TEXT,
  subcategory     TEXT,
  sentiment       TEXT,
  priority        INTEGER,
  language        TEXT,
  summary         TEXT,
  tags            TEXT,                       -- JSON array string
  requires_reply  BOOLEAN,
  extracted_json  TEXT,                       -- 完整 extractedEntities JSON
  reply_draft     TEXT,                       -- 回复草稿全文
  reply_draft_json TEXT,                      -- 完整回复草稿 JSON（含 tone/placeholders 等）
  confidence_score REAL,
  ai_provider     TEXT,                       -- 记录实际用了哪个 provider
  ai_model        TEXT,
  tokens_input    INTEGER,
  tokens_output   INTEGER,
  processing_ms   INTEGER,                    -- AI 调用耗时（毫秒）
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 附件表
CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  email_id        TEXT NOT NULL REFERENCES emails(id),
  filename        TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      INTEGER,
  r2_key          TEXT,                       -- R2 存储 key
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 会话/线程表
CREATE TABLE threads (
  id              TEXT PRIMARY KEY,
  subject         TEXT,
  participants    TEXT,                       -- JSON array
  email_count     INTEGER DEFAULT 1,
  last_email_at   DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 动作执行日志
CREATE TABLE action_logs (
  id              TEXT PRIMARY KEY,
  email_id        TEXT NOT NULL REFERENCES emails(id),
  action_type     TEXT NOT NULL,             -- notify_slack/forward/archive/reject/reply
  action_config   TEXT,                      -- JSON（目标 Slack channel 等）
  status          TEXT,                      -- success/failed
  error_msg       TEXT,
  executed_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- AI Provider 配置表（按别名区分）
CREATE TABLE ai_configs (
  id              TEXT PRIMARY KEY,
  alias           TEXT UNIQUE NOT NULL,      -- "support@domain.com" 或 "*"（全局默认）
  provider        TEXT NOT NULL DEFAULT 'ai-gateway',
  model           TEXT NOT NULL DEFAULT 'openai/gpt-5-mini',
  gateway_id      TEXT,
  has_api_key     BOOLEAN DEFAULT FALSE,     -- Key 实际存在 Secrets/KV 中，此处不存明文
  temperature     REAL DEFAULT 0.3,
  max_tokens      INTEGER DEFAULT 1024,
  fallback_enabled BOOLEAN DEFAULT TRUE,
  fallback_model  TEXT DEFAULT '@cf/meta/llama-3.1-8b-instruct',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_emails_to_address ON emails(to_address);
CREATE INDEX idx_emails_status ON emails(status);
CREATE INDEX idx_emails_received_at ON emails(received_at DESC);
CREATE INDEX idx_emails_thread_id ON emails(thread_id);
CREATE INDEX idx_ai_results_email_id ON email_ai_results(email_id);
CREATE UNIQUE INDEX idx_ai_results_email_unique ON email_ai_results(email_id);
CREATE INDEX idx_ai_results_category ON email_ai_results(category);
```

### 6.2 KV 命名空间规划

| Key 格式                          | 用途                               | TTL    |
| --------------------------------- | ---------------------------------- | ------ |
| `blacklist:{email}`               | 黑名单邮件地址                     | 无     |
| `blacklist:domain:{domain}`       | 黑名单域名                         | 无     |
| `whitelist:{email}`               | 白名单（跳过 AI 直接归档）         | 无     |
| `rules:{to_address}`              | 该别名的动作规则 JSON              | 无     |
| `ai_config:{to_address}`          | 该别名的 AI 配置缓存（从 D1 同步） | 3600s  |
| `template:{name}`                 | 回复模板                           | 无     |
| `ratelimit:{from_address}:{date}` | 发件人当日处理计数（防刷）         | 86400s |

### 6.3 R2 存储路径规范

```
emails/
  {year}/{month}/{day}/
    {email_id}.eml              # 原始邮件
    {email_id}_parsed.json      # postal-mime 解析结果
    {email_id}_attachments/
      {attachment_id}_{filename}
```

---

## 7. 完整 Wrangler 配置

```toml
# wrangler.toml
name = "smartmail-ai"
main = "src/email-worker.ts"
compatibility_date = "2025-06-01"

# ==============================
# Email Worker（主入口，处理入站邮件）
# ==============================
[email]
enabled = true

# ==============================
# Queue Producer（Email Worker 发消息）
# ==============================
[[queues.producers]]
queue = "smartmail-email-queue"
binding = "EMAIL_QUEUE"

# ==============================
# Queue Consumer（独立 Worker，异步处理）
# ==============================
[[queues.consumers]]
queue = "smartmail-email-queue"
max_batch_size = 5          # 每批最多处理 5 封（控制并发 AI 调用）
max_batch_timeout = 10      # 最多等待 10 秒凑批
max_retries = 3             # 失败重试 3 次
dead_letter_queue = "smartmail-dlq"  # 死信队列

[[queues.consumers]]
queue = "smartmail-dlq"     # 死信队列 consumer（告警用）
max_batch_size = 1

# ==============================
# D1 Database
# ==============================
[[d1_databases]]
binding = "DB"
database_name = "smartmail-db"
database_id = "YOUR_D1_DATABASE_ID"

# ==============================
# R2 Object Storage
# ==============================
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "smartmail-storage"

# ==============================
# KV Namespaces
# ==============================
[[kv_namespaces]]
binding = "CONFIG"
id = "YOUR_KV_NAMESPACE_ID"

# ==============================
# Workers AI（fallback）
# ==============================
[ai]
binding = "AI"

# ==============================
# 环境变量（非敏感）
# ==============================
[vars]
CF_ACCOUNT_ID = "your-cloudflare-account-id"
AI_GATEWAY_ID = "smartmail-gateway"
ENVIRONMENT = "production"
MAX_TEXT_BODY_LENGTH = "10000"
DEFAULT_AI_MODEL = "openai/gpt-5-mini"
DEFAULT_AI_PROVIDER = "ai-gateway"

# ==============================
# Secrets（通过 wrangler secret put 设置，不出现在此文件）
# ==============================
# OPENAI_API_KEY
# CF_AIG_TOKEN       （AI Gateway 认证 token）
# SLACK_WEBHOOK_URL
# DASHBOARD_API_SECRET  （Dashboard API 鉴权）
```

---

## 8. 安全设计

### 8.1 API Key 管理

- OpenAI API Key 仅通过 `wrangler secret put OPENAI_API_KEY` 设置，存入 Cloudflare 加密 Secret Store
- Dashboard 的 AI 配置页提交 Key 时，通过 HTTPS POST 到 Pages Function，Function 调用 Cloudflare API 更新 Secret，**前端和 D1 均不存明文 Key**
- D1 中 `ai_configs` 表的 `has_api_key` 字段仅表示"已配置"，不存 Key 内容

### 8.2 Dashboard 鉴权

- Pages Functions 使用 `DASHBOARD_API_SECRET` 做 Bearer Token 鉴权
- Dashboard 登录态建议使用 HttpOnly + Secure + SameSite Cookie，避免在前端 JS 内存保存长期凭证
- 所有 API 路由统一在 Hono middleware 中校验

### 8.3 邮件发件人验证

- Email Routing 层已做 SPF/DKIM/DMARC 验证，Worker 可信任 `message.from`
- 额外在 Worker 中检查 `X-Spam-Status` header（若存在），spam 分数 > 5 直接 Drop

### 8.4 AI 注入攻击防护

- 邮件正文在传入 AI 前，去除所有 HTML 标签，截断到 10,000 字符
- System prompt 与 user content 严格分离，不将邮件正文插入 system prompt
- AI 输出结果做 JSON Schema 校验，拒绝不合规输出并记录异常

---

## 9. 错误处理与可靠性保障

### 9.1 Queues 可靠性（关键：24 小时保留窗口）

由于 Free 计划消息只保留 **24 小时**，系统必须确保消息在此窗口内被消费：

- Queue Consumer 默认 `max_retries = 3`，重试间隔指数退避（30s / 2min / 10min）
- 最终失败进入 Dead Letter Queue（`smartmail-dlq`），DLQ Consumer 向 Slack 发告警
- Email Worker 在 `send()` 失败时，**同步写入 D1** 一条 `status='failed_queue'` 记录作为备份，定时 Worker（Cron Trigger）每小时重试这些记录

### 9.2 AI 调用失败处理

```
调用失败类型 → 处理策略
────────────────────────────────────────────────────────────
HTTP 429 (Rate Limit)  → 等待 Retry-After header 时间，切换 fallback
HTTP 529 (上游模型服务过载) → 立即切换 Workers AI fallback
HTTP 5xx (服务端错误) → 重试 1 次，失败则 fallback
超时 (>30s)          → 切换 fallback
JSON 解析失败         → 重试 1 次（不同 temperature），失败则标注 ai_failed
Workers AI 失败       → 邮件标注 "需人工处理"，Dashboard 高亮显示
```

### 9.3 幂等性保障

- Queue Consumer 处理前检查 D1 中是否存在相同 `email_message_id` 的记录，存在则跳过（防止重复消费）
- 避免使用 `INSERT OR REPLACE`（会触发 delete+insert 语义）；统一使用 `INSERT ... ON CONFLICT (...) DO UPDATE/DO NOTHING`

---

## 10. 性能指标与成本预估

### 10.1 延迟目标

| 阶段                    | 目标 P95 延迟 | 说明                      |
| ----------------------- | ------------- | ------------------------- |
| Email Worker 执行       | < 50ms        | 仅解析 + 入队，极轻量     |
| Queue 投递延迟          | < 10s         | Cloudflare SLA            |
| AI 分类调用             | < 8s          | OpenAI 格式模型实测约 3-6s |
| 总处理时间（收件→通知） | < 30s         | P95 目标                  |
| Dashboard 首屏加载      | < 1.5s        | Pages 全球 CDN            |

### 10.2 成本预估（每日 200 封邮件场景）

**Cloudflare 侧**：免费（在上述 Free 额度内）

**模型调用侧（以 OpenAI 兼容接口为准）**：

- 分类调用：平均 input 800 tokens + output 200 tokens = 1,000 tokens/封
- 提取 + 回复（50% 邮件触发）：平均 2,000 tokens/封
- 日均 token 消耗：200 × 1,000 + 100 × 2,000 = 400,000 tokens/天
- 月均：12M tokens（input ~10M + output ~2M）
- 月成本估算公式：`(月 input tokens / 1M × 输入单价) + (月 output tokens / 1M × 输出单价)`
- 具体单价以所选模型当日官方价格为准（建议在 Dashboard 配置页展示可编辑单价参数）

> **成本控制手段**：对 promo/newsletter 类邮件跳过提取+回复步骤（节省 ~30%），对白名单邮件跳过 AI（节省 ~15%），开启 AI Gateway 响应缓存（对摘要类任务效果显著）。

---

## 11. 测试策略

### 11.1 单元测试（Vitest）

- `ai.ts` 的 `extract()` 方法：mock fetch，测试 JSON 提取的健壮性（含 markdown 包裹、多余文本等情况）
- `AIProviderFactory`：测试各 provider 实例化
- `AIServiceWithFallback`：测试 429/503 触发 fallback 逻辑
- 队列消息体构造：测试附件超大、正文超长的截断逻辑

### 11.2 集成测试

- 使用 `wrangler dev` 本地模拟 Email Worker + Queues
- 准备 10 个测试 `.eml` 文件（覆盖所有 category 类型）
- Queue Consumer 集成测试：直接调用处理函数，校验 D1 写入结果

### 11.3 E2E 验收标准

- 发送一封真实邮件到配置的别名地址，30 秒内 Slack 收到通知
- Dashboard 显示正确的分类、摘要和优先级
- AI fallback：临时移除 OPENAI_API_KEY，验证 Workers AI 接管并正确标注

---

## 12. 实施路线图（优化版）

### Phase 0 — 基础设施（第 1 天）

**产出**：Email Worker 收到邮件 → 解析 → 写 Queues → Queue Consumer 打印日志（不含 AI）

- 创建 D1、R2、KV、AI Gateway（Cloudflare Dashboard）
- `wrangler.toml` 完整配置
- Email Worker：postal-mime 解析 + 黑名单校验 + Queues.send()
- Queue Consumer：接收消息 + 写 D1（仅 emails 表）

### Phase 1 — AI 集成（第 2-3 天）

**产出**：邮件分类 + 提取结果进 D1

- `ai.ts`：AIConfig、AIService、AIGatewayOpenAIService、WorkersAIService、Factory、Fallback
- AI Gateway 创建 + OpenAI 兼容配置（按官方文档）
- Queue Consumer 集成 AI Service Layer
- `email_ai_results` 表写入

### Phase 2 — 动作执行（第 4 天）

**产出**：Slack 通知、邮件归档自动化

- 动作路由器：根据分类/优先级执行规则
- Slack Webhook 集成
- R2 存档（.eml + parsed JSON）
- Dead Letter Queue 消费者

### Phase 3 — Dashboard（第 5-7 天）

**产出**：可用的管理界面

- Cloudflare Pages + Hono API
- 收件箱列表、邮件详情、附件下载
- AI Provider 配置页（含连接测试）
- 基础统计图表（D3.js 或 Chart.js）

### Phase 4 — 优化与监控（持续）

- AI Gateway 缓存规则调优
- RAG（Vectorize）集成
- 成本监控仪表盘
- 多语言支持

---

## 13. 数据保留与清理策略

### 13.1 目标

- 在满足排障、审计、业务追溯的前提下控制存储成本
- 将含敏感信息的数据按最小必要原则设置保留期限
- 所有删除动作可追踪、可审计、可重跑

### 13.2 分层保留策略（默认值）

| 数据类型 | 存储位置 | 默认保留 | 清理方式 | 说明 |
| --- | --- | --- | --- | --- |
| 原始邮件 `.eml` | R2 | 180 天 | 定时硬删除 | 用于追溯与误判复核 |
| 解析结果 `_parsed.json` | R2 | 90 天 | 定时硬删除 | 便于短期问题复现 |
| 附件文件 | R2 | 90 天 | 定时硬删除 | 财务/法务别名可单独延长 |
| 邮件主表 `emails` | D1 | 365 天 | 归档后删除正文 | 保留索引字段，降低 DB 体积 |
| AI 结果 `email_ai_results` | D1 | 365 天 | 定时删除 | 用于效果分析与审计 |
| 动作日志 `action_logs` | D1 | 180 天 | 定时删除 | 运维排障窗口 |
| 死信队列记录 | D1/KV | 30 天 | 定时删除 | 仅用于故障复盘 |

### 13.3 清理任务实现

- 使用 Cron Worker 每日 02:00 UTC 执行清理
- 执行顺序：先删除 D1 关联记录，再删除 R2 对象，避免悬挂引用
- 每次清理按批次执行（建议每批 500 条），避免单次 CPU 超时
- 每次任务写入 `cleanup_runs` 审计日志：开始时间、结束时间、删除条数、失败条数、失败原因

### 13.4 合规与例外策略

- 支持“法律保留”标签（`legal_hold=true`），命中后跳过自动清理
- 支持按别名覆盖保留策略，例如 `finance@` 保留 2 年、`support@` 保留 180 天
- 提供手动触发单封邮件彻底删除接口（D1 + R2 + KV 关联数据）

---

## 14. Prompt 版本管理与回滚

### 14.1 版本管理原则

- 所有系统 Prompt 必须版本化，禁止直接覆盖线上文本
- Prompt 更新必须绑定变更说明与预期影响
- 每次上线可追溯到具体版本号与发布时间

### 14.2 建议数据结构

```sql
CREATE TABLE prompt_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,          -- classify / extract / reply
  version       TEXT NOT NULL,          -- v1.0.0
  content       TEXT NOT NULL,
  output_schema TEXT,                   -- JSON Schema（可选）
  created_by    TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active     BOOLEAN DEFAULT FALSE
);

CREATE UNIQUE INDEX idx_prompt_name_version
ON prompt_templates(name, version);
```

### 14.3 发布流程（建议）

1. 新建 Prompt 版本并执行离线回放（固定样本集）
2. 在 5%-10% 流量做灰度，观测 24 小时
3. 指标达标后全量发布，并记录 release note

### 14.4 核心观测指标

- `json_parse_success_rate`（结构化解析成功率）
- `fallback_rate`（回退模型触发率）
- `human_takeover_rate`（人工接管率）
- `avg_processing_ms`（平均处理时延）

### 14.5 回滚策略

- 回滚触发阈值（任一命中即回滚）：
  - `json_parse_success_rate` 较基线下降 > 5%
  - `human_takeover_rate` 较基线上升 > 10%
  - P1/P0 误分类事故在 24 小时内 ≥ 3 次
- 回滚步骤：将 `is_active` 切换到上一稳定版本，5 分钟内全局生效
- 回滚后必须输出复盘：问题样本、根因、修复动作、再次发布条件

---

## 15. 人工兜底流程与 SLA

### 15.1 触发条件

- AI 连续失败（主模型 + fallback 均失败）
- 输出置信度低于阈值（如 `confidenceScore < 0.6`）
- 命中高风险类别（legal/付款争议/账户安全）
- JSON 结构校验失败且重试后仍失败

### 15.2 工单化与状态流转

- 自动生成 `manual_review_tasks` 记录，分配到值班人
- 状态机：`pending -> acknowledged -> processing -> resolved -> closed`
- 每次状态变更记录操作人、时间、备注，保证审计可追踪

### 15.3 SLA 分级（建议）

| 等级 | 场景 | 首次响应 SLA | 处理完成 SLA |
| --- | --- | --- | --- |
| P0 | 法务风险、资金风险、账户安全 | 15 分钟 | 2 小时 |
| P1 | 客服高优先级、业务中断投诉 | 30 分钟 | 8 小时 |
| P2 | 普通邮件误分类/草稿质量问题 | 4 小时 | 24 小时 |

### 15.4 通知与升级

- 新增待人工任务时，立即发 Slack 通知到值班频道
- 超过首次响应 SLA 未认领，自动 @on-call 负责人
- 超过处理完成 SLA 未关闭，升级到团队负责人并生成日报告警

### 15.5 人工处理闭环

- 人工修正后的分类与回复结果回写 D1，作为后续 prompt 优化样本
- 每周汇总 Top 误判样本，进入 Prompt 迭代 backlog
- 对高频误判场景新增规则短路（先规则后 AI），降低重复人工成本

---

## 16. 官方参考文档索引

| 文档                   | URL                                                                      | 关键信息                                |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| Queues Free 计划公告   | https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/ | 10k ops/天，24h 保留                    |
| AI Gateway Unified API | https://developers.cloudflare.com/ai-gateway/usage/chat-completion/       | OpenAI 兼容端点、model 命名规则          |
| AI Gateway + OpenAI    | https://developers.cloudflare.com/ai-gateway/usage/providers/openai/      | OpenAI provider 直连与响应格式           |
| Email Workers API      | https://developers.cloudflare.com/email-routing/email-workers/           | forward/reject/drop 方法                |
| D1 Database            | https://developers.cloudflare.com/d1/                                    | SQL API、批量操作                       |
| Queues 文档            | https://developers.cloudflare.com/queues/                                | 消息格式、Consumer 配置                 |
| Workers AI             | https://developers.cloudflare.com/workers-ai/                            | Neurons 额度、可用模型                  |

---

## 17. 风险与规避

| 风险                             | 概率 | 影响 | 规避措施                                                                                |
| -------------------------------- | ---- | ---- | --------------------------------------------------------------------------------------- |
| Queues 24h 内未消费消息丢失      | 低   | 高   | Email Worker 同步写 D1 备份；Cron 定时重试失败记录                                      |
| 上游模型 API 超额/欠费           | 中   | 中   | AI Gateway 设置速率限制；Workers AI fallback；D1 记录月度 token 用量并在 Dashboard 告警 |
| 大量垃圾邮件导致 ops 超限        | 中   | 中   | Email Worker 层做 SPF 检查 + KV 黑名单，不合规直接 Reject，不进 Queue                   |
| AI 输出 JSON 解析失败            | 低   | 低   | 健壮 JSON 提取 + Schema 校验；失败降级存原始文本                                        |
| Queue Consumer 超时（AI 调用慢） | 低   | 中   | Worker timeout 设为 60s；AI 调用 30s timeout 后切 fallback                              |

---

**PRD v1.3 结束** ✅

这份文档已包含：基础设施精确约束（含官方文档数据）、完整数据模型（含 SQL）、完整 `ai.ts` 代码规格、Wrangler 配置、安全设计、错误处理、成本估算、测试策略、数据保留清理策略、Prompt 版本治理与回滚、人工兜底 SLA。可直接作为编码实现输入文档使用。
