# SmartMail AI

Implementation bootstrap for the PRD in `prd.md`.

## What is implemented now

- Email Worker handler:
  - blacklist checks via KV
  - MIME parsing via `postal-mime`
  - raw `.eml` + attachments upload to R2
  - queue payload generation and send
- Queue consumer:
  - idempotent insert into D1
  - OpenAI-format AI classification through Cloudflare AI Gateway
  - fallback to Workers AI / heuristic classification
  - `emails` / `email_ai_results` / `attachments` writes
  - KV rule-based action execution (Slack + custom webhook)
  - manual review task creation for low-confidence/high-risk messages
- Scheduled tasks:
  - retry `failed_queue` emails
  - retention cleanup with `cleanup_runs` audit log
  - manual-review SLA overdue Slack alerts
- Dashboard API endpoints:
  - `GET /api/manual-reviews`
  - `PATCH /api/manual-reviews/:id`
  - `GET /api/prompts`
  - `POST /api/prompts`
  - `POST /api/prompts/activate`
- D1 migration: `migrations/0001_init.sql`
- Basic unit tests in `src/utils.test.ts`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure `wrangler.toml` IDs and queue names.

3. Set secrets:

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put CF_AIG_TOKEN
wrangler secret put SLACK_WEBHOOK_URL
wrangler secret put CUSTOM_WEBHOOK_URL
wrangler secret put DASHBOARD_API_SECRET
```

`OPENAI_API_KEY` or `CF_AIG_TOKEN` is enough for AI calls. If both are missing, heuristic fallback is used.

4. Apply D1 schema:

```bash
wrangler d1 execute smartmail-db --local --file migrations/0001_init.sql
```

5. Configure inbound email route in Cloudflare Dashboard:

- Email Routing -> Routing rules
- Target Worker: `smartmail-ai`
- Route aliases such as `support@...`, `finance@...`

## Local development

```bash
npm run typecheck
npm run test
npm run dev
```

Optional vars in `wrangler.toml`:

- `MAX_QUEUE_MESSAGE_BYTES` (default `122880`)
- `RETENTION_DAYS_EMAILS` (default `365`)
- `FALLBACK_AI_MODEL` (default `@cf/meta/llama-3.1-8b-instruct`)
