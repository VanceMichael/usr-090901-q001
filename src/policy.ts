import { readFileSync } from "node:fs";
import type { Policy } from "./types.js";

let cached: Policy | null = null;

export function loadPolicy(path: string): Policy {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  validatePolicyShape(raw);
  return raw as Policy;
}

export function getPolicy(path: string): Policy {
  if (!cached) cached = loadPolicy(path);
  return cached;
}

function validatePolicyShape(p: Record<string, unknown>): void {
  const need = [
    "source_channels",
    "retention",
    "attachment",
    "risk",
    "expiry_by_priority",
    "sensitive_fields",
    "roles",
  ];
  for (const key of need) {
    if (p[key] === undefined || p[key] === null) {
      throw new Error(`策略文件缺少字段: ${key}`);
    }
  }
}
