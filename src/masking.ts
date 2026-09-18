import type { Policy, RolePolicy } from "./types.js";

const MASK = "***";

/** 脱敏单个字段值：字符串保留首字符，数组逐元素脱敏，其余类型整体遮蔽。 */
export function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length === 0) return value;
    return value.length <= 2 ? MASK : `${value[0]}${MASK}`;
  }
  if (Array.isArray(value)) return value.map((v) => maskValue(v));
  if (typeof value === "object") return MASK;
  return value;
}

/** 匿名化：比脱敏更强，直接移除 PII 值，仅保留案件结构。 */
export function anonymizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  return null;
}

export function isFieldAllowed(role: RolePolicy, field: string): boolean {
  return role.allow.includes("*") || role.allow.includes(field);
}

const ATTACHMENT_DEFAULT_FIELDS = [
  "attachment_id",
  "kind",
  "digest",
  "position",
  "duplicate",
  "ref_to",
  "meta",
];

/**
 * 按角色白名单投影案件视图：
 * - 不在 allow 列表的字段直接剔除（denied 由调用方统计，原因码 ROLE_FIELD_DENIED）；
 * - 命中角色 redact 列表的字段保留键但值脱敏；
 * - 附件字段受 attachments_fields 约束；附件 meta 中命中 redact 的键同样脱敏。
 */
export function projectForRole(
  view: Record<string, unknown>,
  attachments: Record<string, unknown>[],
  role: RolePolicy,
  policy: Policy,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const redact = new Set(role.redact ?? []);
  for (const [key, value] of Object.entries(view)) {
    if (!isFieldAllowed(role, key)) continue;
    out[key] = redact.has(key) ? maskValue(value) : value;
  }
  const attFields = role.attachments_fields ?? ATTACHMENT_DEFAULT_FIELDS;
  out.attachments = attachments.map((a) => {
    const picked: Record<string, unknown> = {};
    for (const f of attFields) {
      if (f === "meta" && a.meta) {
        const meta = a.meta as Record<string, unknown>;
        const maskedMeta: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(meta)) {
          if (policy.sensitive_fields.includes(k)) {
            if (redact.has(k)) maskedMeta[k] = maskValue(v);
            // 未获脱敏豁免（非 admin）的敏感 meta 键：不投影
            else if (role.unredacted) maskedMeta[k] = v;
          } else {
            maskedMeta[k] = v;
          }
        }
        picked.meta = maskedMeta;
      } else if (f in a) {
        picked[f] = a[f];
      }
    }
    return picked;
  });
  return out;
}
