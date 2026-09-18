/** 入站信封：所有单条操作请求的统一外壳 */
export interface Envelope<TPayload = unknown> {
  request_id: string;
  operation: Operation;
  case_id: string;
  actor_role: string;
  occurred_at: string;
  payload: TPayload;
}

export type Operation =
  | "register_case"
  | "register_attachments"
  | "recalculate_risk"
  | "preview_cleanup"
  | "run_cleanup"
  | "export_fields";

export interface AttachmentInput {
  attachment_id: string;
  kind: string;
  digest: string;
}

export interface RegisterCasePayload {
  source_channel: string;
  retention_days: number;
  attachments?: AttachmentInput[];
  risk_tags?: string[];
  summary?: string;
  reporter_contact?: string;
  subject_real_name?: string;
  subject_id_number?: string;
  subject_address?: string;
  evidence_urls?: string[];
  internal_note?: string;
}

export interface RegisterAttachmentsPayload {
  attachments: AttachmentInput[];
}

export interface RecalculatePayload {
  risk_tags?: string[];
}

export interface CleanupPreviewPayload {
  /** 以某个时间点评估到期情况（操作员工具，便于预览未来计划）；缺省为当前时间 */
  now?: string;
  case_id?: string;
  limit?: number;
}

export interface RunCleanupPayload extends CleanupPreviewPayload {
  /** 仅预览不执行时置 false，缺省 true */
  execute?: boolean;
}

export interface ExportPayload {
  role: string;
  case_ids?: string[];
  fields?: string[];
}

export interface RiskFactor {
  code: string;
  points: number;
}

export interface AttachmentRef {
  attachment_id: string;
  digest: string;
  kind: string;
  duplicate: boolean;
  already_linked?: boolean;
  original_case_id?: string;
  original_attachment_id?: string;
  original_request_id?: string;
}

export interface AttachmentRowResult extends AttachmentRef {
  index: number;
  ok: boolean;
  error_code?: string;
  error_message?: string;
}

export interface CleanupPlanItem {
  case_id: string;
  expires_at: string;
  action: string;
  purge_status: string;
  purgable_fields: string[];
  retention_days: number;
}

export interface CleanupResultItem {
  case_id: string;
  action: string;
  expired_at: string;
  executed_at: string;
  purged_fields: string[];
}
