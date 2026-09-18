// 时间工具：统一使用 UTC ISO8601 文本持久化，比较用毫秒时间戳。

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_RE.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toUtcIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addDays(iso: string, days: number): string {
  return toUtcIso(new Date(new Date(iso).getTime() + days * 86_400_000));
}

export function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}
