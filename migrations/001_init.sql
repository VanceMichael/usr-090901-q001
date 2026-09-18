-- 001_init.sql: 举报信封、附件全局索引、分派卡片与清理计划
-- 所有写入均在事务内完成；队列表与清理计划持久化，重启后顺序不丢失。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 案件（举报信封 + 风险分派结果 + 到期动作状态）
CREATE TABLE IF NOT EXISTS cases (
  case_id            TEXT PRIMARY KEY,
  source_channel     TEXT NOT NULL,
  actor_role         TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,          -- ISO8601，举报发生时间
  registered_at      TEXT NOT NULL,          -- ISO8601，服务端登记时间
  recalculated_at    TEXT,
  retention_days     INTEGER NOT NULL,
  expires_at         TEXT NOT NULL,          -- registered_at + retention_days
  priority_score     INTEGER NOT NULL,
  priority_level     TEXT NOT NULL,
  queue              TEXT NOT NULL,
  queue_seq          INTEGER NOT NULL,       -- 队列内单调序号，决定 FIFO 顺序
  status             TEXT NOT NULL DEFAULT 'open',  -- open | closed
  risk_tags          TEXT NOT NULL DEFAULT '[]',    -- JSON 数组
  risk_factors       TEXT NOT NULL DEFAULT '[]',    -- JSON 数组（可解释打分）
  summary            TEXT,
  reporter_contact   TEXT,                   -- 敏感字段，到期清除
  subject_real_name  TEXT,                   -- 敏感字段
  subject_id_number  TEXT,                   -- 敏感字段
  subject_address    TEXT,                   -- 敏感字段
  evidence_urls      TEXT NOT NULL DEFAULT '[]',    -- 敏感 JSON 数组
  internal_note      TEXT,                   -- 敏感字段
  purged_at          TEXT,
  purge_status       TEXT NOT NULL DEFAULT 'pending' -- pending | purged
);

CREATE INDEX IF NOT EXISTS idx_cases_queue ON cases(queue, queue_seq);
CREATE INDEX IF NOT EXISTS idx_cases_expires ON cases(purge_status, expires_at);
CREATE INDEX IF NOT EXISTS idx_cases_registered ON cases(registered_at);

-- 附件全局去重索引：同一 digest 全局只存一份
CREATE TABLE IF NOT EXISTS attachments (
  digest          TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  first_case_id   TEXT NOT NULL,
  first_request   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  ref_count       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_att_first_case ON attachments(first_case_id);

-- 案件 <-> 附件 引用关系（重复摘要指向同一 digest，仅建立引用，不新增附件行）
CREATE TABLE IF NOT EXISTS case_attachments (
  case_id         TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  digest          TEXT NOT NULL REFERENCES attachments(digest),
  attachment_id   TEXT NOT NULL,          -- 登记请求里的行内标识
  request_id      TEXT NOT NULL,
  is_duplicate    INTEGER NOT NULL DEFAULT 0,
  linked_at       TEXT NOT NULL,
  PRIMARY KEY (case_id, attachment_id),
  UNIQUE (case_id, digest)
);
CREATE INDEX IF NOT EXISTS idx_ca_digest ON case_attachments(digest);

-- 到期清理计划（每行案件一条；清理执行后保留事件并删除计划行）
CREATE TABLE IF NOT EXISTS cleanup_plan (
  case_id      TEXT PRIMARY KEY REFERENCES cases(case_id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL,
  action       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cleanup_due ON cleanup_plan(expires_at);

-- 清理事件（审计轨迹：实际删除了哪些敏感字段）
CREATE TABLE IF NOT EXISTS cleanup_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id       TEXT NOT NULL,
  action        TEXT NOT NULL,
  expired_at    TEXT NOT NULL,
  executed_at   TEXT NOT NULL,
  purged_fields TEXT NOT NULL,            -- JSON 数组
  request_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cleanup_events_case ON cleanup_events(case_id);

-- 每个队列的单调序号计数器（持久化，重启后继续递增，保证队列顺序稳定）
CREATE TABLE IF NOT EXISTS queue_counters (
  queue      TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0
);

-- 入站信封审计（成功/失败都记录），便于坏行隔离排查
CREATE TABLE IF NOT EXISTS request_log (
  request_id    TEXT,
  operation     TEXT,
  case_id       TEXT,
  actor_role    TEXT,
  ok            INTEGER NOT NULL,
  error_code    TEXT,
  error_message TEXT,
  received_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_log_case ON request_log(case_id);
