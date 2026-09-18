/** 可预期的业务/校验错误，携带稳定 error_code，映射为 HTTP 4xx（坏行隔离用） */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export const ERR = {
  invalidEnvelope: (m: string) => new AppError("INVALID_ENVELOPE", m),
  unsupportedOperation: (op: string) =>
    new AppError("UNSUPPORTED_OPERATION", `不支持的操作: ${op}`, 404),
  roleDenied: (role: string) =>
    new AppError("ROLE_FIELD_DENIED", `角色 ${role} 无权执行字段导出或角色未知`, 403),
  unknownChannel: (ch: string) =>
    new AppError("UNKNOWN_SOURCE_CHANNEL", `未知来源渠道: ${ch}`),
  badRetention: (ch: string, got: number, min: number, max: number) =>
    new AppError(
      "RETENTION_OUT_OF_POLICY",
      `渠道 ${ch} 的保留期只允许 ${min}-${max} 天，收到 ${got} 天`
    ),
  timeWindow: (m: string) => new AppError("TIME_WINDOW_VIOLATION", m, 422),
  badDigest: (d: unknown) =>
    new AppError("INVALID_ATTACHMENT_DIGEST", `非法附件摘要: ${String(d)}`),
  badKind: (k: string) => new AppError("INVALID_ATTACHMENT_KIND", `非法附件类型: ${k}`),
  tooManyAttachments: (n: number, max: number) =>
    new AppError("TOO_MANY_ATTACHMENTS", `附件 ${n} 个，超过单次上限 ${max}`),
  duplicateInlineId: (id: string) =>
    new AppError("DUPLICATE_INLINE_ATTACHMENT_ID", `本次请求内 attachment_id 重复: ${id}`),
  caseExists: (id: string) =>
    new AppError("CASE_ALREADY_EXISTS", `案件 ${id} 已存在`, 409),
  caseNotFound: (id: string) =>
    new AppError("CASE_NOT_FOUND", `案件 ${id} 不存在`, 404),
  noChange: (m: string) => new AppError("NO_CHANGE", m, 422),
};
