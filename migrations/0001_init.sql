CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  email_message_id TEXT UNIQUE,
  thread_id TEXT,
  received_at DATETIME NOT NULL,
  to_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  subject TEXT NOT NULL,
  text_body TEXT,
  has_attachments BOOLEAN DEFAULT FALSE,
  raw_r2_key TEXT,
  parsed_r2_key TEXT,
  status TEXT DEFAULT 'pending',
  last_error TEXT,
  legal_hold BOOLEAN DEFAULT FALSE,
  is_read BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_ai_results (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id),
  category TEXT,
  subcategory TEXT,
  sentiment TEXT,
  priority INTEGER,
  language TEXT,
  summary TEXT,
  tags TEXT,
  requires_reply BOOLEAN,
  extracted_json TEXT,
  reply_draft TEXT,
  reply_draft_json TEXT,
  confidence_score REAL,
  ai_provider TEXT,
  ai_model TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  processing_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id),
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  r2_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS action_logs (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id),
  action_type TEXT NOT NULL,
  action_config TEXT,
  status TEXT,
  error_msg TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_configs (
  id TEXT PRIMARY KEY,
  alias TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ai-gateway',
  model TEXT NOT NULL DEFAULT 'openai/gpt-5-mini',
  gateway_id TEXT,
  has_api_key BOOLEAN DEFAULT FALSE,
  temperature REAL DEFAULT 0.3,
  max_tokens INTEGER DEFAULT 1024,
  fallback_enabled BOOLEAN DEFAULT TRUE,
  fallback_model TEXT DEFAULT '@cf/meta/llama-3.1-8b-instruct',
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  output_schema TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_name_version ON prompt_templates(name, version);

CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NOT NULL,
  deleted_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_msg TEXT
);

CREATE TABLE IF NOT EXISTS manual_review_tasks (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id),
  priority_level TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  assignee TEXT,
  acknowledged_at DATETIME,
  resolved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emails_to_address ON emails(to_address);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_ai_results_email_id ON email_ai_results(email_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_results_email_unique ON email_ai_results(email_id);
CREATE INDEX IF NOT EXISTS idx_ai_results_category ON email_ai_results(category);
CREATE INDEX IF NOT EXISTS idx_manual_review_status ON manual_review_tasks(status);
