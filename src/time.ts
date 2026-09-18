/** ISO8601 时间工具：解析、比较、加天，统一输出毫秒精度 UTC（Z） */

export function parseIso(s: string, field = "时间"): number {
  if (typeof s !== "string" || s.length === 0) {
    throw new TypeError(`${field}必须是非空字符串`);
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new TypeError(`${field}不是合法 ISO8601 时间: ${s}`);
  }
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(iso: string, days: number): string {
  return toIso(parseIso(iso) + days * 86_400_000);
}

/** 判定 t 是否落在 [now-maxAge, now+skew] 窗口内 */
export function withinWindow(
  t: number,
  now: number,
  maxAgeMs: number,
  futureSkewMs: number
): boolean {
  return t <= now + futureSkewMs && t >= now - maxAgeMs;
}
