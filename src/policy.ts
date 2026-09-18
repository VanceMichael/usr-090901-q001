import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ChannelPolicy {
  base_score: number;
  retention_min_days: number;
  retention_max_days: number;
}
interface PriorityBand {
  min_score: number;
  level: string;
  queue: string;
}

export interface Policy {
  version: string;
  source_channels: Record<string, ChannelPolicy>;
  time_window: { max_age_days: number; future_skew_seconds: number };
  retention: { absolute_min_days: number; absolute_max_days: number };
  attachments: {
    kinds: string[];
    digest_pattern: string;
    max_per_request: number;
    kind_weights: Record<string, number>;
  };
  risk_tags: Record<string, number>;
  risk: { first_attachment_weight: number; score_cap: number };
  priority_levels: PriorityBand[];
  sensitive_fields: string[];
  cleanup_action: string;
  card_fields: string[];
  roles: Record<string, string[]>;
  reason_codes: string[];
}

let cached: Policy | null = null;

/** 规则文件随源码打入镜像（rules/policy.json），也可用 POLICY_FILE 覆盖路径 */
export function loadPolicy(): Policy {
  if (cached) return cached;
  const path = process.env.POLICY_FILE ?? join(process.cwd(), "rules", "policy.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Policy;
  if (!raw.version || !raw.source_channels || !raw.priority_levels?.length) {
    throw new Error("规则文件缺少必要字段");
  }
  cached = raw;
  return raw;
}
