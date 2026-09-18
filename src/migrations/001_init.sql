-- 001_init.sql
-- 网络开盒举报分派与材料保留：初始结构
-- 所有时间均以 ISO8601 文本持久化（UTC），队列顺序由持久化的序号决定，重启不丢失。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 举报案件（信封计算结果 + 案件字段存于 record_json，含敏感原文，到期清理时在事务内重写）
CREATE TABLE IF NOT EXISTS cases (
  case_id         TEXT PRIMARY KEY,
  source_channel  TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,           -- 举报事件发生时间（信封时间，UTC）
  registered_at   TEXT NOT NULL,           -- 服务端登记时间（UTC）
  queue_seq       INTEGER NOT NULL,        -- 全局登记序号，决定队列先后
  priority        TEXT NOT NULL,
  queue           TEXT NOT NULL,
  risk_score      INTEGER NOT NULL,
  status          TEXT NOT NULL,           -- open | recalculated | redacted | anonymized | deleted
  retention_days  INTEGER NOT NULL,
  expires_at      TEXT NOT NULL,           -- 保留截止时间（UTC）
  expiry_action   TEXT NOT NULL,           -- anonymize | redact_sensitive | delete_record
  risk_flags      TEXT NOT NULL,           -- JSON 数组
  record_json     TEXT NOT NULL,           -- 案件字段（含敏感原文，随清理重写）
  last_request_id TEXT,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_cases_queue ON cases(queue, queue_seq);
CREATE INDEX IF NOT EXISTS idx_cases_expires ON cases(expires_at);

-- 附件索引：同一案件内 digest 唯一，重复摘要只保留这一份规范行
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  digest      TEXT NOT NULL,
  position    INTEGER NOT NULL,            -- 首次登记请求中的行序号
  meta_json   TEXT NOT NULL DEFAULT '{}',  -- 附属字段（url、note 等，清理时改写）
  UNIQUE(case_id, attachment_id),
  UNIQUE(case_id, digest)
);

-- 重复摘要引用关系：提交的附件 id -> 保留的规范附件 id
CREATE TABLE IF NOT EXISTS attachment_refs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id               TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  submitted_attachment_id TEXT NOT NULL,
  canonical_attachment_id TEXT NOT NULL,
  digest                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE(case_id, submitted_attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_refs_case ON attachment_refs(case_id);

-- 请求审计（每个 request_id 一行，登记/重算/清理的处理结论）
CREATE TABLE IF NOT EXISTS request_audit (
  request_id  TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  operation   TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  status      TEXT NOT NULL,               -- accepted | rejected
  reasons     TEXT NOT NULL DEFAULT '[]',
  result_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_case ON request_audit(case_id);

-- 到期清理计划（登记/重算时生成，preview 与 execute 共用；重算会取消旧计划并重建）
CREATE TABLE IF NOT EXISTS cleanup_plan (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id       TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL,             -- case | case_field | attachment
  target_ref    TEXT NOT NULL,             -- case_id / 字段名 / attachment_id
  action        TEXT NOT NULL,             -- anonymize | redact_sensitive | delete_record
  scheduled_for TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | done | cancelled
  created_at    TEXT NOT NULL,
  executed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_plan_due ON cleanup_plan(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_plan_case ON cleanup_plan(case_id, status);
