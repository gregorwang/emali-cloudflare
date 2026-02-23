# PRD 文档：SmartMail Admin Worker（第二个 Worker）

**版本**：v0.1  
**更新日期**：2026 年 2 月 23 日  
**状态**：Draft for Implementation

---

## 1. 结论与技术立场

将 Web 管理台从 `smartmail-ai` 主处理 Worker 中拆分为第二个 Worker 是正确决策。

- 主链路 Worker（收信/入队/消费/定时任务）应保持轻量、稳定、低变更频率。
- 管理台 Worker（页面/API/查询）天然高变更频率，不应影响邮件处理 SLA。
- Cloudflare 原生支持 Worker 间协作（Service Binding），适合做控制面与数据面解耦。

> 关键点：只新增第二个 Worker 还不够。要“去黑盒”，必须同时补齐可观测数据（处理事件、AI 原始输出、动作执行日志）。

---

## 2. 产品目标

### 2.1 目标

1. 提供可视化管理台，能完整追踪每封邮件处理链路。
2. 能查看 AI 结构化结果与原始回复（可脱敏）。
3. 支持人工介入：状态流转、重试处理、触发补偿动作。
4. 不影响当前 `smartmail-ai` 的吞吐与稳定性。

### 2.2 非目标（本期不做）

1. 不做复杂 BI 报表系统。
2. 不做多租户权限模型（仅单租户/单团队）。
3. 不做全文检索引擎（先用 D1 条件查询 + 索引）。

---

## 3. 系统边界与职责拆分

### 3.1 Worker A：`smartmail-ai`（已有）

- 负责：`email()`、`queue()`、`scheduled()`、AI 分类、规则执行、数据写入。
- 暴露：最小化内部命令接口（仅给 Admin Worker 调用），例如重跑流程、动作补偿。

### 3.2 Worker B：`smartmail-admin`（新增）

- 负责：Web UI、管理 API、聚合查询、人工处理操作入口。
- 只做控制面，不参与邮件实时处理。

### 3.3 Worker 间通信策略（推荐）

采用“读写分离”：

1. 读：Admin Worker 直接绑定 D1 做查询（低延迟、简单）。
2. 写命令：Admin Worker 通过 Service Binding 调用 `smartmail-ai` 内部命令接口（避免绕过业务约束）。

---

## 4. 功能需求（Admin Worker）

### 4.1 页面模块

1. 邮件列表页：
- 按时间倒序展示 `from/subject/category/priority/status/confidence`。
- 支持筛选：状态、分类、优先级、时间范围、是否需要人工处理。

2. 邮件详情页：
- 基础信息：Header 摘要、正文、附件清单、R2 对象引用。
- AI 信息：结构化分类 JSON、summary、tags、confidence、模型信息。
- 可观测时间线：`received -> queued -> processing -> ai_done -> action_done/failed`。

3. 人工审核页：
- 展示 `manual_review_tasks`，支持认领、处理中、已解决、关闭。

4. Prompt 管理页：
- 查看版本、创建版本、激活版本。

### 4.2 操作能力

1. `Reprocess`：对单封邮件触发重处理。
2. `Replay Action`：对失败动作单独补偿执行（例如 Slack/Webhook）。
3. `Mark Resolved`：人工审核任务状态流转。

---

## 5. 去黑盒数据要求（新增/补齐）

当前系统仅有结构化结果，不能完整解释 AI 行为。本期补齐：

### 5.1 `ai_raw_responses`（新增表）

- `id`（PK）
- `email_id`（FK）
- `provider`
- `model`
- `request_json_redacted`（脱敏后请求）
- `response_text`（原始文本）
- `response_json`（可解析 JSON）
- `created_at`

### 5.2 `processing_events`（新增表）

- `id`（PK）
- `email_id`（FK）
- `stage`（`received|queued|processing|ai_done|action_done|error|manual_review`）
- `status`（`ok|retry|failed`）
- `detail`（JSON）
- `created_at`

> 原则：所有关键状态转移都写事件，Dashboard 只读此表构建时间线，不靠猜测。

---

## 6. API 设计

### 6.1 Admin Worker 对外 API（示例）

1. `GET /admin/api/emails`
2. `GET /admin/api/emails/:id`
3. `GET /admin/api/emails/:id/timeline`
4. `GET /admin/api/manual-reviews`
5. `POST /admin/api/manual-reviews/:id/status`
6. `POST /admin/api/emails/:id/reprocess`
7. `POST /admin/api/emails/:id/replay-action`

### 6.2 Core Worker 内部命令 API（仅 Service Binding）

1. `POST /internal/reprocess/:emailId`
2. `POST /internal/replay-action/:emailId`

鉴权策略：

- 不对公网暴露 `/internal/*`。
- 仅允许来自 Admin Worker 的 Service Binding 调用。
- 额外校验内部共享密钥（`INTERNAL_API_SECRET`）。

---

## 7. 安全与权限

1. 管理台必须启用登录保护（Cloudflare Access 或应用级会话）。
2. API 使用 HttpOnly Cookie 或短期 Bearer Token，不在前端长期存储密钥。
3. 原始邮件正文和 AI 原始输出默认按“敏感数据”处理：
- 默认遮罩邮箱、手机号、账号类模式。
- 仅管理员可查看完整原文。

---

## 8. 部署与资源绑定

新增 Worker：`smartmail-admin`

`wrangler.toml`（admin）至少包含：

1. `[[d1_databases]]` 绑定现有 `smartmail-db`（只读查询 + 有限写入）。
2. `[[kv_namespaces]]` 绑定 `CONFIG`（读取规则、开关）。
3. `[services]` 绑定 `smartmail-ai`（内部命令调用）。
4. 必要 Secrets：`DASHBOARD_API_SECRET`、`INTERNAL_API_SECRET`。

路由建议：

1. `mail-admin.yourdomain.com/*` -> `smartmail-admin`
2. `smartmail-ai` 保持邮件处理专用，不承载 UI。

---

## 9. 验收标准

1. 打开管理台可看到最近邮件列表，且字段完整。
2. 任意邮件详情可看到：
- 结构化 AI 输出
- AI 原始输出
- 处理时间线
3. 人工审核状态流转可生效并落库。
4. `Reprocess` 与 `Replay Action` 操作可触发主 Worker 执行并写事件。
5. 高峰邮件处理吞吐与拆分前相比无明显下降（误差 <5%）。

---

## 10. 实施里程碑（建议）

1. Phase A（0.5 天）：
- 建立 `smartmail-admin` Worker 骨架、鉴权、基础路由。

2. Phase B（1 天）：
- 补充 `ai_raw_responses`、`processing_events` migration 与写入埋点。

3. Phase C（1 天）：
- 完成列表页/详情页/人工审核页 API + UI。

4. Phase D（0.5 天）：
- 接入 Service Binding 命令接口，完成 `Reprocess`、`Replay Action`。

5. Phase E（0.5 天）：
- 回归测试、压测抽样、上线部署。

---

## 11. 风险与规避

1. 风险：D1 查询压力上升。  
规避：为列表筛选字段加索引，分页限制默认 `limit <= 100`。

2. 风险：原始 AI 输出泄露敏感信息。  
规避：默认脱敏存储，细粒度权限控制。

3. 风险：Admin Worker 越权修改核心状态。  
规避：写操作全部走 Core Worker 内部命令接口，不允许前台直接改主状态表关键字段。

---

## 12. 与主 PRD 的关系

本文件是对 `prd.md` 的“控制面拆分补充”，不替代原 PRD。  
原 `prd.md` 继续定义邮件处理主链路；本 PRD 仅定义第二个 Worker（可视化与人工运维）。
