import type { IncomingMessage, ServerResponse } from "node:http";
import type { DB } from "./db.js";
import { transaction } from "./db.js";
import { AppError } from "./errors.js";
import type { Policy } from "./policy.js";
import { DispatchService } from "./service.js";
import { nowIso } from "./time.js";
import type { Envelope } from "./types.js";
import {
  validateEnvelope,
  validateExportPayload,
  validateRecalculatePayload,
  validateRegisterCasePayload,
  validateRunCleanupPayload,
  validateCleanupPayload,
} from "./validate.js";

interface ErrorBody {
  code: string;
  message: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "请求体超过大小上限", 413);
    chunks.push(buf);
  }
  if (chunks.length === 0) throw new AppError("EMPTY_BODY", "请求体为空");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

export function createHandler(db: DB, policy: Policy) {
  const svc = new DispatchService(db, policy);

  function logFailure(env: Partial<Envelope> | null, err: AppError): void {
    try {
      transaction(db, () => {
        db.prepare(
          `INSERT INTO request_log(request_id, operation, case_id, actor_role, ok, error_code, error_message, received_at)
           VALUES(?,?,?,?,?,?,?,?)`
        ).run(
          env?.request_id ?? null,
          env?.operation ?? null,
          env?.case_id ?? null,
          env?.actor_role ?? null,
          0,
          err.code,
          err.message,
          nowIso()
        );
      });
    } catch {
      // 审计写入失败不应掩盖原始错误
    }
  }

  /** 分发单条已解析信封；未知异常转 500 */
  function dispatch(env: Envelope): { status: number; body: unknown } {
    const p = env.payload as Record<string, unknown>;
    switch (env.operation) {
      case "register_case":
        return { status: 201, body: svc.registerCase(env, validateRegisterCasePayload(policy, p)) };
      case "register_attachments": {
        if (!Array.isArray(p.attachments)) {
          throw new AppError("INVALID_ENVELOPE", "payload.attachments 必须是数组");
        }
        return { status: 200, body: svc.registerAttachments(env, p.attachments) };
      }
      case "recalculate_risk":
        return { status: 200, body: svc.recalculateRisk(env, validateRecalculatePayload(policy, p)) };
      case "preview_cleanup":
        return { status: 200, body: svc.previewCleanup(env, validateCleanupPayload(p)) };
      case "run_cleanup":
        return { status: 200, body: svc.runCleanup(env, validateRunCleanupPayload(p)) };
      case "export_fields":
        return { status: 200, body: svc.exportFields(env, validateExportPayload(policy, p)) };
      default:
        throw new AppError("UNSUPPORTED_OPERATION", `不支持的操作: ${String(env.operation)}`, 404);
    }
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // ---------- 健康检查 ----------
      if ((path === "/healthz" || path === "/readyz") && method === "GET") {
        db.prepare("SELECT 1").get();
        return send(res, 200, {
          status: "ok",
          database: "sqlite",
          policy_version: policy.version,
          time: nowIso(),
        });
      }

      // ---------- 单条信封 ----------
      if (path === "/v1/requests" && method === "POST") {
        const raw = await readJson(req, 2_000_000);
        let env: Envelope;
        try {
          env = validateEnvelope(raw);
        } catch (err) {
          if (err instanceof AppError) {
            logFailure((raw as Record<string, unknown>) ?? null, err);
            return send(res, err.status, { error: { code: err.code, message: err.message } });
          }
          throw err;
        }
        try {
          const { status, body } = dispatch(env);
          return send(res, status, {
            request_id: env.request_id,
            case_id: env.case_id,
            operation: env.operation,
            result: body,
          });
        } catch (err) {
          if (err instanceof AppError) {
            logFailure(env, err);
            return send(res, err.status, {
              request_id: env.request_id,
              case_id: env.case_id,
              error: { code: err.code, message: err.message },
            });
          }
          throw err;
        }
      }

      // ---------- 信封级批量：逐行返回，单行独立事务，坏行不影响他行 ----------
      if (path === "/v1/requests/batch" && method === "POST") {
        const raw = await readJson(req, 10_000_000);
        if (!Array.isArray(raw)) {
          throw new AppError("INVALID_ENVELOPE", "批量请求体必须是信封数组");
        }
        if (raw.length > 1000) throw new AppError("TOO_MANY_ROWS", "批量最多 1000 行");
        const results = raw.map((item, index) => {
          let env: Envelope;
          try {
            env = validateEnvelope(item);
          } catch (err) {
            if (err instanceof AppError) {
              logFailure((item as Record<string, unknown>) ?? null, err);
              return {
                index,
                ok: false,
                status: err.status,
                error: { code: err.code, message: err.message } satisfies ErrorBody,
              };
            }
            throw err;
          }
          try {
            const { status, body } = dispatch(env);
            return {
              index,
              ok: true,
              status,
              request_id: env.request_id,
              case_id: env.case_id,
              operation: env.operation,
              result: body,
            };
          } catch (err) {
            if (err instanceof AppError) {
              logFailure(env, err);
              return {
                index,
                ok: false,
                status: err.status,
                request_id: env.request_id,
                case_id: env.case_id,
                operation: env.operation,
                error: { code: err.code, message: err.message } satisfies ErrorBody,
              };
            }
            throw err;
          }
        });
        const accepted = results.filter((r) => r.ok).length;
        return send(res, 200, {
          total: results.length,
          accepted,
          rejected: results.length - accepted,
          results,
        });
      }

      // ---------- 队列总览 ----------
      if (path === "/v1/queues" && method === "GET") {
        return send(res, 200, svc.listQueues());
      }

      // ---------- 队列分页 ----------
      {
        const m = path.match(/^\/v1\/queues\/([\w.-]+)$/);
        if (m && method === "GET") {
          const queue = decodeURIComponent(m[1]!);
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const cursorParam = url.searchParams.get("cursor");
          const cursor = cursorParam ? Number(cursorParam) : undefined;
          const role = url.searchParams.get("role") ?? "triager";
          if (!Number.isFinite(limit)) throw new AppError("INVALID_QUERY", "limit 非法");
          if (cursorParam !== null && !Number.isFinite(cursor)) {
            throw new AppError("INVALID_QUERY", "cursor 非法");
          }
          return send(res, 200, svc.listQueue(queue, limit, cursor, role));
        }
      }

      // ---------- 案件脱敏处理卡片 ----------
      {
        const m = path.match(/^\/v1\/cases\/([\w.-]+)$/);
        if (m && method === "GET") {
          const caseId = decodeURIComponent(m[1]!);
          const role = url.searchParams.get("role") ?? "triager";
          return send(res, 200, svc.caseCard(caseId, role));
        }
      }

      if (path === "/" || path === "/v1") {
        return send(res, 200, {
          service: "unboxing-report-dispatch",
          policy_version: policy.version,
          endpoints: [
            "POST /v1/requests",
            "POST /v1/requests/batch",
            "GET /v1/queues",
            "GET /v1/queues/:queue",
            "GET /v1/cases/:caseId",
            "GET /healthz",
          ],
        });
      }

      throw new AppError("NOT_FOUND", `路径不存在: ${method} ${path}`, 404);
    } catch (err) {
      if (err instanceof AppError) {
        return send(res, err.status, { error: { code: err.code, message: err.message } });
      }
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("unhandled error:", err);
      return send(res, 500, { error: { code: "INTERNAL_ERROR", message } });
    }
  };
}
