import type { AttachmentInput, Envelope, Policy, RowError } from "./types.js";
import { isInt, parseIso } from "./time.js";

export const OPERATIONS = [
  "register_case",
  "register_attachments",
  "recalculate",
  "cleanup",
] as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function err(code: string, message: string, field?: string): RowError {
  return { code, message, ...(field ? { field } : {}) };
}

/** 校验信封公共字段：来源角色、操作类型、时间窗。渠道在 register_case 载荷内校验。 */
export function validateEnvelope(
  raw: unknown,
  policy: Policy,
  now: Date,
): { envelope: Envelope | null; errors: RowError[] } {
  const errors: RowError[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { envelope: null, errors: [err("ENVELOPE_SHAPE", "请求体必须是对象")] };
  }
  const o = raw as Record<string, unknown>;
  for (const key of ["request_id", "operation", "case_id", "actor_role", "occurred_at", "payload"]) {
    if (!(key in o)) errors.push(err("ENVELOPE_MISSING_FIELD", `缺少字段 ${key}`, key));
  }
  if (Object.keys(o).some((k) => !["request_id", "operation", "case_id", "actor_role", "occurred_at", "payload"].includes(k))) {
    errors.push(err("ENVELOPE_EXTRA_FIELD", "存在未声明字段"));
  }

  let operation: Envelope["operation"] | null = null;
  if (typeof o.operation === "string" && (OPERATIONS as readonly string[]).includes(o.operation)) {
    operation = o.operation as Envelope["operation"];
  } else if ("operation" in o) {
    errors.push(err("UNKNOWN_OPERATION", `不支持的操作: ${String(o.operation)}`, "operation"));
  }

  for (const [key, value] of [["request_id", o.request_id], ["case_id", o.case_id]] as const) {
    if (typeof value !== "string" || !ID_RE.test(value)) {
      if (value !== undefined) errors.push(err("BAD_IDENTIFIER", `${key} 必须是 1-64 位字母数字 _.:-`, key));
    }
  }

  if (typeof o.actor_role !== "string" || !policy.roles[o.actor_role]) {
    errors.push(err("UNKNOWN_ROLE", `未知角色: ${String(o.actor_role)}（全程不接入外部身份服务）`, "actor_role"));
  }

  if (typeof o.occurred_at === "string") {
    const d = parseIso(o.occurred_at);
    if (!d) {
      errors.push(err("BAD_TIMESTAMP", "occurred_at 必须是带时区的 ISO8601 时间", "occurred_at"));
    } else {
      const deltaMs = d.getTime() - now.getTime();
      if (deltaMs > policy.future_skew_seconds * 1000) {
        errors.push(err("TIME_IN_FUTURE", "occurred_at 超出允许的未来时钟偏差", "occurred_at"));
      }
      if (deltaMs < -policy.time_window_minutes * 60_000) {
        errors.push(
          err("TIME_OUT_OF_WINDOW", `occurred_at 超出 ${policy.time_window_minutes} 分钟受理时间窗`, "occurred_at"),
        );
      }
    }
  } else if ("occurred_at" in o) {
    errors.push(err("BAD_TIMESTAMP", "occurred_at 必须是字符串", "occurred_at"));
  }

  if (typeof o.payload !== "object" || o.payload === null || Array.isArray(o.payload)) {
    if ("payload" in o) errors.push(err("PAYLOAD_SHAPE", "payload 必须是对象", "payload"));
  }

  if (errors.length > 0 || !operation || typeof o.payload !== "object" || o.payload === null) {
    return { envelope: null, errors };
  }
  return {
    envelope: {
      request_id: o.request_id as string,
      operation,
      case_id: o.case_id as string,
      actor_role: o.actor_role as string,
      occurred_at: o.occurred_at as string,
      payload: o.payload as Record<string, unknown>,
    },
    errors: [],
  };
}

/** 校验来源渠道（仅 register_case 需要）。 */
export function validateChannel(
  channel: unknown,
  policy: Policy,
): { channel: string | null; errors: RowError[] } {
  if (typeof channel !== "string") {
    return { channel: null, errors: [err("CHANNEL_MISSING", "payload.source_channel 必填", "source_channel")] };
  }
  const spec = policy.source_channels[channel];
  if (!spec) return { channel: null, errors: [err("UNKNOWN_CHANNEL", `未知来源渠道: ${channel}`, "source_channel")] };
  if (!spec.allowed) return { channel: null, errors: [err("CHANNEL_NOT_ALLOWED", `来源渠道不受理: ${channel}`, "source_channel")] };
  return { channel, errors: [] };
}

/** 校验保留天数：未提供时按渠道默认；必须落在本地策略区间。 */
export function resolveRetentionDays(
  payload: Record<string, unknown>,
  channel: string,
  policy: Policy,
): { days: number | null; errors: RowError[] } {
  const v = payload.retention_days;
  if (v === undefined) {
    return { days: policy.retention.by_channel[channel] ?? policy.retention.default_days, errors: [] };
  }
  if (!isInt(v)) {
    return { days: null, errors: [err("RETENTION_BAD_TYPE", "retention_days 必须是整数天", "retention_days")] };
  }
  if (v < policy.retention.min_days || v > policy.retention.max_days) {
    return {
      days: null,
      errors: [
        err(
          "RETENTION_OUT_OF_RANGE",
          `retention_days 须在 ${policy.retention.min_days}-${policy.retention.max_days} 天之间`,
          "retention_days",
        ),
      ],
    };
  }
  return { days: v, errors: [] };
}

export interface ValidatedAttachment {
  row: AttachmentInput;
  digest: string;
  kind: string;
}

/** 逐行校验附件：类型、kind、摘要格式、批次内 attachment_id/digest 重复标记。 */
export function validateAttachmentRows(
  rawRows: unknown,
  policy: Policy,
): { rows: (ValidatedAttachment | null)[]; errors: { index: number; errors: RowError[] }[] } {
  const rowErrors: { index: number; errors: RowError[] }[] = [];
  if (!Array.isArray(rawRows)) {
    return { rows: [], errors: [{ index: -1, errors: [err("ATTACHMENTS_SHAPE", "payload.attachments 必须是数组", "attachments")] }] };
  }
  if (rawRows.length > policy.attachment.max_per_request) {
    return {
      rows: [],
      errors: [
        {
          index: -1,
          errors: [err("ATTACHMENT_TOO_MANY", `单次最多 ${policy.attachment.max_per_request} 个附件`, "attachments")],
        },
      ],
    };
  }
  const digestRe = new RegExp(policy.attachment.digest_pattern);
  const seenIds = new Map<string, number>();
  const rows: (ValidatedAttachment | null)[] = rawRows.map((raw, index) => {
    const errors: RowError[] = [];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      rowErrors.push({ index, errors: [err("ATTACHMENT_BAD_ROW", "附件行必须是对象")] });
      return null;
    }
    const a = raw as Record<string, unknown>;
    const { attachment_id, kind, digest } = a;
    if (typeof attachment_id !== "string" || !ID_RE.test(attachment_id)) {
      errors.push(err("ATTACHMENT_BAD_ID", "attachment_id 必须是 1-64 位字母数字 _.:-", "attachment_id"));
    } else if (seenIds.has(attachment_id)) {
      errors.push(err("ATTACHMENT_ID_DUPLICATE_IN_BATCH", `批次内 attachment_id 与第 ${seenIds.get(attachment_id)} 行重复`, "attachment_id"));
    } else {
      seenIds.set(attachment_id, index);
    }
    if (typeof kind !== "string" || !policy.attachment.kinds.includes(kind)) {
      errors.push(err("ATTACHMENT_BAD_KIND", `kind 必须是 ${policy.attachment.kinds.join("/")}`, "kind"));
    }
    if (typeof digest !== "string" || !digestRe.test(digest)) {
      errors.push(err("ATTACHMENT_BAD_DIGEST", "digest 必须匹配 " + policy.attachment.digest_pattern, "digest"));
    }
    if (errors.length) {
      rowErrors.push({ index, errors });
      return null;
    }
    return { row: a as AttachmentInput, digest: digest as string, kind: kind as string };
  });
  return { rows, errors: rowErrors };
}
