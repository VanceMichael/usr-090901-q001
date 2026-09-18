// 领域类型定义

export type Operation =
  | "register_case"
  | "register_attachments"
  | "recalculate"
  | "cleanup";

export type CaseStatus =
  | "open"
  | "recalculated"
  | "redacted"
  | "anonymized"
  | "deleted";

export type ExpiryAction = "anonymize" | "redact_sensitive" | "delete_record";

export interface AttachmentInput {
  attachment_id: string;
  kind: string;
  digest: string;
  url?: unknown;
  note?: unknown;
  [key: string]: unknown;
}

export interface Envelope {
  request_id: string;
  operation: Operation;
  case_id: string;
  actor_role: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface RowError {
  code: string;
  field?: string;
  message: string;
}

export interface AttachmentResult {
  index: number;
  attachment_id: string;
  kind: string;
  digest: string;
  status: "created" | "duplicate" | "rejected";
  ref_to?: string;
  errors?: RowError[];
}

export interface RowResult {
  index: number;
  request_id?: string;
  case_id?: string;
  operation?: Operation;
  status: "accepted" | "rejected";
  reasons?: string[];
  data?: unknown;
  errors?: RowError[];
}

export interface Policy {
  version: string;
  reason_codes: string[];
  source_channels: Record<
    string,
    { label: string; allowed: boolean; base_risk: number; trust: number }
  >;
  time_window_minutes: number;
  future_skew_seconds: number;
  retention: {
    min_days: number;
    max_days: number;
    default_days: number;
    by_channel: Record<string, number>;
  };
  attachment: {
    kinds: string[];
    digest_pattern: string;
    kind_weights: Record<string, number>;
    max_per_request: number;
  };
  risk: {
    flags: Record<string, number>;
    levels: { min: number; priority: string; queue: string }[];
  };
  expiry_by_priority: Record<string, ExpiryAction>;
  sensitive_fields: string[];
  roles: Record<string, RolePolicy>;
}

export interface RolePolicy {
  label: string;
  allow: string[];
  unredacted?: boolean;
  redact?: string[];
  attachments_fields?: string[];
}
