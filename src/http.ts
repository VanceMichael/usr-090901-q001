import type { IncomingMessage, ServerResponse } from "node:http";
import type { TriageService } from "./service.js";
import { validateEnvelope } from "./validation.js";
import type { Envelope, Policy, RowResult } from "./types.js";
import { err } from "./validation.js";

interface RouteContext {
  service: TriageService;
  policy: Policy;
  clock: () => Date;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage, limitBytes = 2_000_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `请求体超过 ${limitBytes} 字节`);
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) throw new HttpError(400, "EMPTY_BODY", "请求体为空");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_JSON", "请求体不是合法 JSON");
  }
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function processOne(raw: unknown, ctx: RouteContext): RowResult {
  const { envelope, errors } = validateEnvelope(raw, ctx.policy, ctx.clock());
  if (!envelope) {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      index: 0,
      request_id: typeof o.request_id === "string" ? o.request_id : undefined,
      case_id: typeof o.case_id === "string" ? o.case_id : undefined,
      operation: typeof o.operation === "string" ? (o.operation as RowResult["operation"]) : undefined,
      status: "rejected",
      errors,
    };
  }
  const r = ctx.service.handleEnvelope(envelope);
  return {
    index: 0,
    request_id: envelope.request_id,
    case_id: envelope.case_id,
    operation: envelope.operation,
    status: r.status,
    reasons: r.reasons,
    data: r.data,
    errors: r.errors,
  };
}

export function createRequestHandler(ctx: RouteContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { status: "ok", time: ctx.clock().toISOString(), policy_version: ctx.policy.version });
        return;
      }

      // 单案登记 / 附件批量登记 / 风险重算 / 到期清理（单信封）
      if (method === "POST" && path === "/v1/requests") {
        const raw = await readJson(req);
        const row = processOne(raw, ctx);
        sendJson(res, row.status === "accepted" ? 200 : 422, row);
        return;
      }

      // 批量请求：逐行返回，坏行隔离不写入、不影响其它行
      if (method === "POST" && path === "/v1/requests/bulk") {
        const raw = await readJson(req);
        if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { requests?: unknown }).requests)) {
          throw new HttpError(400, "BULK_SHAPE", "请求体须为 { requests: [...] }");
        }
        const raws = (raw as { requests: unknown[] }).requests;
        if (raws.length > 500) throw new HttpError(400, "BULK_TOO_LARGE", "单次最多 500 行");
        const results: RowResult[] = raws.map((item, index) => {
          const row = processOne(item, ctx);
          return { ...row, index };
        });
        const accepted = results.filter((r) => r.status === "accepted").length;
        sendJson(res, 200, {
          total: results.length,
          accepted,
          rejected: results.length - accepted,
          results,
        });
        return;
      }

      // 按队列分页
      if (method === "GET" && path === "/v1/queues") {
        const queue = url.searchParams.get("queue") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const cursorRaw = url.searchParams.get("cursor");
        if (!Number.isFinite(limit)) throw new HttpError(400, "BAD_QUERY", "limit 必须是数字");
        const cursor = cursorRaw === null ? undefined : Number(cursorRaw);
        if (cursorRaw !== null && !Number.isFinite(cursor)) throw new HttpError(400, "BAD_QUERY", "cursor 必须是数字");
        sendJson(res, 200, ctx.service.listQueues({ queue, limit, cursor }));
        return;
      }

      // 脱敏后的案件处理卡片
      const cardMatch = /^\/v1\/cases\/([A-Za-z0-9_.:-]+)\/card$/.exec(path);
      if (method === "GET" && cardMatch) {
        const role = url.searchParams.get("role") ?? "reviewer";
        const out = ctx.service.getCard(cardMatch[1], role);
        if (!out.ok) {
          const status = out.errors[0]?.code === "UNKNOWN_ROLE" ? 403 : 404;
          sendJson(res, status, { status: "error", errors: out.errors });
          return;
        }
        sendJson(res, 200, { case_id: cardMatch[1], role: out.role, card: out.card });
        return;
      }

      // 清理计划预览
      if (method === "GET" && path === "/v1/cleanup/preview") {
        const asOf = url.searchParams.get("as_of") ?? undefined;
        const caseId = url.searchParams.get("case_id") ?? undefined;
        const out = ctx.service.cleanupPreview({ asOfIso: asOf, caseId });
        if (!out.ok) sendJson(res, 400, { status: "error", errors: out.errors });
        else sendJson(res, 200, out);
        return;
      }

      // 按角色导出可见字段
      if (method === "POST" && path === "/v1/export") {
        const raw = (await readJson(req)) as { role?: unknown; case_ids?: unknown };
        if (typeof raw.role !== "string") throw new HttpError(400, "ROLE_REQUIRED", "body.role 必填");
        const out = ctx.service.exportForRole(raw.role, Array.isArray(raw.case_ids) ? (raw.case_ids as string[]) : undefined);
        if (!out.ok) sendJson(res, 403, { status: "error", errors: out.errors });
        else sendJson(res, 200, out);
        return;
      }

      sendJson(res, 404, { status: "error", errors: [err("NOT_FOUND", `无此路由: ${method} ${path}`)] });
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { status: "error", errors: [{ code: e.code, message: e.message }] });
        return;
      }
      // 不把内部错误细节外泄
      const message = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.error("[http]", e);
      sendJson(res, 500, { status: "error", errors: [{ code: "INTERNAL", message }] });
    }
  };
}
