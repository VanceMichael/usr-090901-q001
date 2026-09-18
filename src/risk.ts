import type { Policy } from "./types.js";

export interface RiskResult {
  score: number;
  priority: string;
  queue: string;
  expiry_action: "anonymize" | "redact_sensitive" | "delete_record";
  unknown_flags: string[];
}

/**
 * 依据本地规则计算风险：渠道基础分 + 规范附件（重复摘要不重复计分）+ 命中风险标记。
 * 分数封顶 100，按 levels 阈值映射优先级与处理队列。
 */
export function calculateRisk(
  channel: string,
  canonicalAttachmentKinds: string[],
  flags: string[],
  policy: Policy,
): RiskResult {
  const base = policy.source_channels[channel]?.base_risk ?? 0;
  let score = base;
  for (const kind of canonicalAttachmentKinds) {
    score += policy.attachment.kind_weights[kind] ?? 0;
  }
  const unknown_flags: string[] = [];
  for (const flag of flags) {
    if (Object.prototype.hasOwnProperty.call(policy.risk.flags, flag)) {
      score += policy.risk.flags[flag];
    } else {
      unknown_flags.push(flag);
    }
  }
  score = Math.max(0, Math.min(100, score));
  const levels = [...policy.risk.levels].sort((a, b) => b.min - a.min);
  const level = levels.find((l) => score >= l.min) ?? levels[levels.length - 1];
  return {
    score,
    priority: level.priority,
    queue: level.queue,
    expiry_action: policy.expiry_by_priority[level.priority] ?? "redact_sensitive",
    unknown_flags,
  };
}
