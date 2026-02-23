CREATE TABLE IF NOT EXISTS ai_raw_responses (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  request_json_redacted TEXT,
  response_text TEXT,
  response_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processing_events (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_raw_email_id ON ai_raw_responses(email_id);
CREATE INDEX IF NOT EXISTS idx_ai_raw_created_at ON ai_raw_responses(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_events_email_id ON processing_events(email_id);
CREATE INDEX IF NOT EXISTS idx_processing_events_stage ON processing_events(stage);
CREATE INDEX IF NOT EXISTS idx_processing_events_created_at ON processing_events(created_at DESC);
