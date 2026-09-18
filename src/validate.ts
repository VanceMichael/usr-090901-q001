import { AppError, ERR } from "./errors.js";
import type { Policy } from "./policy.js";
import type {
  AttachmentInput,
  Envelope,
  ExportPayload,
  RecalculatePayload,
  RegisterAttachmentsPayload,
  RegisterCasePayload,
  RunCleanupPayload,
} from "./types.js";
import { parseIso } from "./time.js";

const ID_PATTERN = /^[\w.-]{1,64}$/;
const ATTACHMENT_ID_PATTERN = /^[\w.:-]{1,128}$/;
const MAX_TEXT = 20_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strField(obj: Record<string, unknown>, key: string, max = MAX_TEXT): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw ERR.invalidEnvelope(`字段 ${key} 必须是非空字符串`);
  }
  if (v.length > max) throw ERR.invalidEnvelope(`字段 ${key} 超长（>${max}）`);
  return v;
}

const OPERATIONS = new Set([
  "register_case",
  "register_attachments",
  "recalculate_risk",
  "preview_cleanup",
  "run_cleanup",
  "export_fields",
]);

/** 校验统一信封；operation 不在白名单内按 UNSUPPORTED_OPERATION 处理 */
export function validateEnvelope(raw: unknown): Envelope {
  if (!isObj(raw)) throw ERR.invalidEnvelope("请求体必须是 JSON 对象");
  const allowed = ["request_id", "operation", "case_id", "actor_role", "occurred_at", "payload"];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw ERR.invalidEnvelope(`出现非法信封字段: ${k}`);
  }
  const request_id = strField(raw, "request_id", 128);
  if (!ID_PATTERN.test(request_id)) throw ERR.invalidEnvelope("request_id 字符非法");

  const operation = strField(raw, "operation", 64);
  if (!OPERATIONS.has(operation)) throw ERR.unsupportedOperation(operation);

  const case_id = strField(raw, "case_id", 64);
  if (!ID_PATTERN.test(case_id)) throw ERR.invalidEnvelope("case_id 字符非法");

  const actor_role = strField(raw, "actor_role", 64);
  const occurred_at = strField(raw, "occurred_at", 40);
  parseIso(occurred_at, "occurred_at"); // 仅校验合法性
  if (!isObj(raw.payload)) throw ERR.invalidEnvelope("payload 必须是对象");

  return {
    request_id,
    operation: operation as Envelope["operation"],
    case_id,
    actor_role,
    occurred_at,
    payload: raw.payload,
  };
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw ERR.invalidEnvelope(`字段 ${key} 必须是字符串`);
  if (v.length > MAX_TEXT) throw ERR.invalidEnvelope(`字段 ${key} 超长`);
  return v;
}

function stringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw ERR.invalidEnvelope(`字段 ${key} 必须是字符串数组`);
  }
  return v as string[];
}

/** 附件列表：校验类型、摘要格式、行内 attachment_id 唯一与数量上限（不做跨案去重） */
export function validateAttachments(policy: Policy, raw: unknown): AttachmentInput[] {
  if (!Array.isArray(raw)) throw ERR.invalidEnvelope("attachments 必须是数组");
  if (raw.length === 0) throw ERR.invalidEnvelope("attachments 不能为空");
  if (raw.length > policy.attachments.max_per_request) {
    throw ERR.tooManyAttachments(raw.length, policy.attachments.max_per_request);
  }
  const digestRe = new RegExp(policy.attachments.digest_pattern);
  const seenId = new Set<string>();
  const seenDigest = new Set<string>();
  const out: AttachmentInput[] = [];
  for (const item of raw) {
    if (!isObj(item)) throw ERR.invalidEnvelope("附件项必须是对象");
    const id = item.attachment_id;
    const kind = item.kind;
    const digest = item.digest;
    if (typeof id !== "string" || !ATTACHMENT_ID_PATTERN.test(id)) {
      throw ERR.invalidEnvelope("附件 attachment_id 缺失或非法");
    }
    if (seenId.has(id)) throw ERR.duplicateInlineId(id);
    if (typeof kind !== "string" || !policy.attachments.kinds.includes(kind)) {
      throw ERR.badKind(String(kind));
    }
    if (typeof digest !== "string" || !digestRe.test(digest)) {
      throw ERR.badDigest(digest);
    }
    seenId.add(id);
    seenDigest.add(digest);
    out.push({ attachment_id: id, kind, digest });
  }
  return out;
}

export function validateRegisterCasePayload(
  policy: Policy,
  p: Record<string, unknown>
): RegisterCasePayload {
  const source_channel = strField(p, "source_channel", 64);
  if (!policy.source_channels[source_channel]) throw ERR.unknownChannel(source_channel);

  const retention_days = p.retention_days;
  if (typeof retention_days !== "number" || !Number.isInteger(retention_days)) {
    throw ERR.invalidEnvelope("retention_days 必须是整数");
  }
  const ch = policy.source_channels[source_channel]!;
  if (
    retention_days < ch.retention_min_days ||
    retention_days > ch.retention_max_days ||
    retention_days < policy.retention.absolute_min_days ||
    retention_days > policy.retention.absolute_max_days
  ) {
    throw ERR.badRetention(
      source_channel,
      retention_days,
      Math.max(ch.retention_min_days, policy.retention.absolute_min_days),
      Math.min(ch.retention_max_days, policy.retention.absolute_max_days)
    );
  }

  const risk_tags = stringArray(p, "risk_tags");
  if (risk_tags) {
    for (const t of risk_tags) {
      if (!(t in policy.risk_tags)) {
        throw new AppError("INVALID_RISK_TAG", `未知风险标签: ${t}`);
      }
    }
  }
  const evidence_urls = stringArray(p, "evidence_urls");

  return {
    source_channel,
    retention_days,
    attachments:
      p.attachments === undefined ? undefined : validateAttachments(policy, p.attachments),
    risk_tags,
    evidence_urls,
    summary: optString(p, "summary"),
    reporter_contact: optString(p, "reporter_contact"),
    subject_real_name: optString(p, "subject_real_name"),
    subject_id_number: optString(p, "subject_id_number"),
    subject_address: optString(p, "subject_address"),
    internal_note: optString(p, "internal_note"),
  };
}

export function validateRegisterAttachmentsPayload(
  policy: Policy,
  p: Record<string, unknown>
): RegisterAttachmentsPayload {
  return { attachments: validateAttachments(policy, p.attachments) };
}

export function validateRecalculatePayload(
  policy: Policy,
  p: Record<string, unknown>
): RecalculatePayload {
  const tags = stringArray(p, "risk_tags");
  if (tags) {
    for (const t of tags) {
      if (!(t in policy.risk_tags)) {
        throw new AppError("INVALID_RISK_TAG", `未知风险标签: ${t}`);
      }
    }
    return { risk_tags: tags };
  }
  return {};
}

export function validateCleanupPayload(
  p: Record<string, unknown>
): { now?: string; case_id?: string; limit?: number } {
  const out: { now?: string; case_id?: string; limit?: number } = {};
  if (p.now !== undefined) {
    if (typeof p.now !== "string") throw ERR.invalidEnvelope("now 必须是 ISO8601 字符串");
    parseIso(p.now, "now");
    out.now = p.now;
  }
  if (p.case_id !== undefined) {
    if (typeof p.case_id !== "string" || !ID_PATTERN.test(p.case_id)) {
      throw ERR.invalidEnvelope("case_id 非法");
    }
    out.case_id = p.case_id;
  }
  if (p.limit !== undefined) {
    if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > 1000) {
      throw ERR.invalidEnvelope("limit 必须是 1-1000 的整数");
    }
    out.limit = p.limit;
  }
  return out;
}

export function validateRunCleanupPayload(p: Record<string, unknown>): RunCleanupPayload {
  const base = validateCleanupPayload(p);
  const execute = p.execute === undefined ? true : Boolean(p.execute);
  return { ...base, execute };
}

export function validateExportPayload(
  policy: Policy,
  p: Record<string, unknown>
): ExportPayload {
  const role = strField(p, "role", 64);
  if (!(role in policy.roles)) throw ERR.roleDenied(role);
  const out: ExportPayload = { role };
  if (p.case_ids !== undefined) {
    const ids = p.case_ids;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !ID_PATTERN.test(x))) {
      throw ERR.invalidEnvelope("case_ids 必须是合法 ID 数组");
    }
    out.case_ids = ids as string[];
  }
  if (p.fields !== undefined) {
    const fields = p.fields;
    if (!Array.isArray(fields) || fields.some((x) => typeof x !== "string")) {
      throw ERR.invalidEnvelope("fields 必须是字符串数组");
    }
    out.fields = fields as string[];
  }
  return out;
}
