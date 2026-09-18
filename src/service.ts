import type Database from "better-sqlite3";
import type {
  AttachmentInput,
  Envelope,
  ExpiryAction,
  Policy,
  RolePolicy,
  RowError,
  RowResult,
} from "./types.js";
import {
  validateAttachmentRows,
  validateChannel,
  resolveRetentionDays,
  err,
} from "./validation.js";
import { calculateRisk } from "./risk.js";
import { addDays, parseIso, toUtcIso } from "./time.js";
import { anonymizeValue, isFieldAllowed, maskValue, projectForRole } from "./masking.js";

interface CaseRow {
  case_id: string;
  source_channel: string;
  occurred_at: string;
  registered_at: string;
  queue_seq: number;
  priority: string;
  queue: string;
  risk_score: number;
  status: string;
  retention_days: number;
  expires_at: string;
  expiry_action: ExpiryAction;
  risk_flags: string;
  record_json: string;
  last_request_id: string | null;
  version: number;
}

interface AttRow {
  id: number;
  case_id: string;
  attachment_id: string;
  kind: string;
  digest: string;
  position: number;
  meta_json: string;
}

interface RefRow {
  submitted_attachment_id: string;
  canonical_attachment_id: string;
  digest: string;
}

// 各操作允许的角色（不满足时返回 ROLE_FIELD_DENIED，全程不接入外部身份服务）
const OPERATION_ROLES: Record<string, string[]> = {
  register_case: ["admin", "reviewer"],
  register_attachments: ["admin", "reviewer", "operator"],
  recalculate: ["admin", "reviewer"],
  cleanup: ["admin"],
};

export interface ServiceResult {
  status: "accepted" | "rejected";
  reasons: string[];
  data?: unknown;
  errors?: RowError[];
}

export class TriageService {
  private db: Database.Database;
  private policy: Policy;
  private now: () => Date;

  constructor(db: Database.Database, policy: Policy, now: () => Date = () => new Date()) {
    this.db = db;
    this.policy = policy;
    this.now = now;
  }

  // ---------- 信封处理总入口（单条，业务写入整体在一个事务中） ----------

  handleEnvelope(env: Envelope): ServiceResult {
    // 幂等证据链：同一 request_id 只处理一次（不依赖任何外部身份服务）
    if (this.auditExists(env.request_id)) {
      return {
        status: "rejected",
        reasons: ["REQUEST_DUPLICATE"],
        errors: [err("REQUEST_DUPLICATE", `request_id 已处理过: ${env.request_id}`, "request_id")],
      };
    }
    const roleDenied = this.assertOperationRole(env);
    if (roleDenied) return { status: "rejected", reasons: ["ROLE_FIELD_DENIED"], errors: [roleDenied] };

    if (env.operation === "register_case") return this.registerCase(env);
    if (env.operation === "register_attachments") return this.registerAttachments(env);
    if (env.operation === "recalculate") return this.recalculate(env);
    return this.executeCleanup(env);
  }

  /** 批量：逐行独立事务，坏行隔离，不影响其它行提交。 */
  handleBulk(envelopes: Envelope[]): RowResult[] {
    return envelopes.map((env, index) => {
      try {
        const r = this.handleEnvelope(env);
        return {
          index,
          request_id: env.request_id,
          case_id: env.case_id,
          operation: env.operation,
          status: r.status,
          reasons: r.reasons,
          data: r.data,
          errors: r.errors,
        };
      } catch (e) {
        return {
          index,
          request_id: env.request_id,
          case_id: env.case_id,
          operation: env.operation,
          status: "rejected",
          errors: [err("INTERNAL", e instanceof Error ? e.message : String(e))],
        };
      }
    });
  }

  private assertOperationRole(env: Envelope): RowError | null {
    const allowed = OPERATION_ROLES[env.operation] ?? [];
    if (!allowed.includes(env.actor_role)) {
      return err(
        "ROLE_FIELD_DENIED",
        `角色 ${env.actor_role} 无权执行 ${env.operation}（允许：${allowed.join("/")}）`,
        "actor_role",
      );
    }
    return null;
  }

  // ---------- 单案登记 ----------

  private registerCase(env: Envelope): ServiceResult {
    const payload = env.payload;
    const reasons: string[] = [];

    if (this.getCase(env.case_id)) {
      return this.rejectCase(env, ["CASE_ALREADY_EXISTS"], [err("CASE_ALREADY_EXISTS", `案件已存在: ${env.case_id}`, "case_id")]);
    }
    const channelCheck = validateChannel(payload.source_channel, this.policy);
    if (channelCheck.errors.length) return this.rejectCase(env, ["CHANNEL_NOT_ALLOWED"], channelCheck.errors);
    const channel = channelCheck.channel!;

    const retentionCheck = resolveRetentionDays(payload, channel, this.policy);
    if (retentionCheck.errors.length) return this.rejectCase(env, ["RETENTION_POLICY_VIOLATION"], retentionCheck.errors);
    const retentionDays = retentionCheck.days!;

    const flagsCheck = this.extractFlags(payload.risk_flags);
    if (flagsCheck.errors.length) return this.rejectCase(env, ["BAD_RISK_FLAGS"], flagsCheck.errors);
    if (flagsCheck.unknown.length) reasons.push(...flagsCheck.unknown.map((f) => `UNKNOWN_RISK_FLAG:${f}`));

    const attCheck = validateAttachmentRows(payload.attachments ?? [], this.policy);
    const fatal = attCheck.errors.filter((e) => e.index === -1);
    if (fatal.length) return this.rejectCase(env, ["ATTACHMENTS_REJECTED"], fatal[0].errors);
    // 单案登记遵循全有或全无：任一附件坏行都会拒绝整个信封，事务内不产生半截数据。
    if (attCheck.errors.length > 0) {
      return this.rejectCase(
        env,
        ["ATTACHMENTS_REJECTED"],
        attCheck.errors.flatMap((e) => e.errors),
      );
    }

    const registeredAt = toUtcIso(this.now());
    const expiresAt = addDays(registeredAt, retentionDays);
    const validRows = attCheck.rows.filter((r): r is NonNullable<typeof r> => r !== null);
    const kinds = validRows.map((r) => r.kind);
    const risk = calculateRisk(channel, kinds, flagsCheck.flags, this.policy);
    if (risk.unknown_flags.length) reasons.push(...risk.unknown_flags.map((f) => `UNKNOWN_RISK_FLAG:${f}`));

    const record = this.buildRecord(payload);

    // 登记写入：案件、附件、引用、清理计划、成功审计在同一事务内，任一失败整体回滚。
    const attResults = this.db.transaction(() => {
      const seq = this.nextSeq();
      this.db
        .prepare(
          `INSERT INTO cases(case_id, source_channel, occurred_at, registered_at, queue_seq, priority, queue,
             risk_score, status, retention_days, expires_at, expiry_action, risk_flags, record_json, last_request_id)
           VALUES (@case_id,@source_channel,@occurred_at,@registered_at,@queue_seq,@priority,@queue,
             @risk_score,'open',@retention_days,@expires_at,@expiry_action,@risk_flags,@record_json,@last_request_id)`,
        )
        .run({
          case_id: env.case_id,
          source_channel: channel,
          occurred_at: toUtcIso(new Date(env.occurred_at)),
          registered_at: registeredAt,
          queue_seq: seq,
          priority: risk.priority,
          queue: risk.queue,
          risk_score: risk.score,
          retention_days: retentionDays,
          expires_at: expiresAt,
          expiry_action: risk.expiry_action,
          risk_flags: JSON.stringify(flagsCheck.flags),
          record_json: JSON.stringify(record),
          last_request_id: env.request_id,
        });
      const inserted = this.insertAttachmentRows(
        env.case_id,
        validRows.map((r, index) => ({ row: r.row, index })),
      );
      this.rebuildCleanupPlan(env.case_id);
      this.writeAudit(env, "accepted", reasons, {
        priority: risk.priority,
        queue: risk.queue,
        risk_score: risk.score,
        expires_at: expiresAt,
      });
      return inserted;
    })();

    return {
      status: "accepted",
      reasons,
      data: {
        case_id: env.case_id,
        source_channel: channel,
        priority: risk.priority,
        queue: risk.queue,
        risk_score: risk.score,
        retention_days: retentionDays,
        expires_at: expiresAt,
        expiry_action: risk.expiry_action,
        queue_seq: this.getCase(env.case_id)!.queue_seq,
        attachments: attResults,
        rejected_attachments: attCheck.errors.map((e) => ({ index: e.index, errors: e.errors })),
      },
    };
  }

  // ---------- 附件批量登记（重复摘要只保留一份，返回引用关系） ----------

  private registerAttachments(env: Envelope): ServiceResult {
    const caseRow = this.getCase(env.case_id);
    if (!caseRow) {
      return this.rejectCase(env, ["CASE_NOT_FOUND"], [err("CASE_NOT_FOUND", `案件不存在: ${env.case_id}`, "case_id")]);
    }
    const attCheck = validateAttachmentRows(env.payload.attachments, this.policy);
    const fatal = attCheck.errors.filter((e) => e.index === -1);
    if (fatal.length) return this.rejectCase(env, ["ATTACHMENTS_REJECTED"], fatal[0].errors);

    const reasons: string[] = [];
    const validRows = attCheck.rows
      .map((r, index) => (r === null ? null : { ...r, index }))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const results = this.db.transaction(() => {
      const inserted = this.insertAttachmentRows(
        env.case_id,
        validRows.map((r) => ({ row: r.row, index: r.index })),
      );
      this.rebuildCleanupPlan(env.case_id);
      this.writeAudit(env, "accepted", reasons, { added: inserted.filter((r) => (r as { status: string }).status === "created").length });
      return inserted;
    })();

    const list = results as { status: string }[];
    if (list.some((r) => r.status === "duplicate")) reasons.push("DUPLICATE_ATTACHMENT");

    return {
      status: "accepted",
      reasons,
      data: {
        case_id: env.case_id,
        attachments: results,
        rejected_attachments: attCheck.errors.map((e) => ({ index: e.index, errors: e.errors })),
      },
    };
  }

  /**
   * 逐行落库：行可能创建规范附件，也可能命中已有摘要而只新增引用关系；
   * id 冲突等单行问题不抛异常，标记为 rejected 由调用方随事务提交（坏行隔离）。
   * 调用方必须已在事务内。
   */
  private insertAttachmentRows(
    caseId: string,
    rows: { row: AttachmentInput; index: number }[],
  ): unknown[] {
    const existing = new Map<string, AttRow>(
      (this.db.prepare("SELECT * FROM attachments WHERE case_id = ?").all(caseId) as AttRow[]).map((row) => [
        row.digest,
        row,
      ]),
    );
    const batchDigestOwner = new Map<string, string>();
    const results: unknown[] = [];

    for (const { row: a, index } of rows) {
      const ownerId = existing.get(a.digest)?.attachment_id ?? batchDigestOwner.get(a.digest);
      if (ownerId) {
        // 重复摘要：只写引用关系，不保留第二份材料
        this.db
          .prepare(
            `INSERT INTO attachment_refs(case_id, submitted_attachment_id, canonical_attachment_id, digest, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(caseId, a.attachment_id, ownerId, a.digest, toUtcIso(this.now()));
        results.push({
          index,
          attachment_id: a.attachment_id,
          kind: a.kind,
          digest: a.digest,
          status: "duplicate",
          ref_to: ownerId,
        });
        continue;
      }
      if (this.attachmentIdTaken(caseId, a.attachment_id)) {
        results.push({
          index,
          attachment_id: a.attachment_id,
          status: "rejected",
          errors: [err("ATTACHMENT_ID_EXISTS", `attachment_id 已被占用: ${a.attachment_id}`, "attachment_id")],
        });
        continue;
      }
      const meta = this.extractMeta(a);
      this.db
        .prepare(
          `INSERT INTO attachments(case_id, attachment_id, kind, digest, position, meta_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(caseId, a.attachment_id, a.kind, a.digest, this.nextPosition(caseId), JSON.stringify(meta));
      existing.set(a.digest, { attachment_id: a.attachment_id } as AttRow);
      batchDigestOwner.set(a.digest, a.attachment_id);
      results.push({
        index,
        attachment_id: a.attachment_id,
        kind: a.kind,
        digest: a.digest,
        status: "created",
        ref_to: null,
      });
    }
    return results;
  }

  // ---------- 风险重算 ----------

  private recalculate(env: Envelope): ServiceResult {
    const caseRow = this.getCase(env.case_id);
    if (!caseRow) {
      return this.rejectCase(env, ["CASE_NOT_FOUND"], [err("CASE_NOT_FOUND", `案件不存在: ${env.case_id}`, "case_id")]);
    }
    const reasons = ["PRIORITY_RECALCULATED"];
    let flags = JSON.parse(caseRow.risk_flags) as string[];
    let retentionDays = caseRow.retention_days;

    if (env.payload.risk_flags !== undefined) {
      const flagsCheck = this.extractFlags(env.payload.risk_flags);
      if (flagsCheck.errors.length) return this.rejectCase(env, ["BAD_RISK_FLAGS"], flagsCheck.errors);
      flags = flagsCheck.flags;
      reasons.push(...flagsCheck.unknown.map((f) => `UNKNOWN_RISK_FLAG:${f}`));
    }
    if (env.payload.retention_days !== undefined) {
      const retentionCheck = resolveRetentionDays(env.payload, caseRow.source_channel, this.policy);
      if (retentionCheck.errors.length) return this.rejectCase(env, ["RETENTION_POLICY_VIOLATION"], retentionCheck.errors);
      retentionDays = retentionCheck.days!;
    }

    const kinds = (this.db.prepare("SELECT kind FROM attachments WHERE case_id = ?").all(env.case_id) as { kind: string }[]).map(
      (r) => r.kind,
    );
    const before = { priority: caseRow.priority, queue: caseRow.queue, risk_score: caseRow.risk_score };
    const risk = calculateRisk(caseRow.source_channel, kinds, flags, this.policy);
    const registeredAt = caseRow.registered_at;
    const expiresAt = addDays(registeredAt, retentionDays);

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE cases SET priority=?, queue=?, risk_score=?, expiry_action=?, risk_flags=?,
             retention_days=?, expires_at=?, status='recalculated', last_request_id=?, version=version+1 WHERE case_id=?`,
        )
        .run(risk.priority, risk.queue, risk.score, risk.expiry_action, JSON.stringify(flags), retentionDays, expiresAt, env.request_id, env.case_id);
      this.rebuildCleanupPlan(env.case_id);
      this.writeAudit(env, "accepted", reasons, { before, after: { priority: risk.priority, queue: risk.queue, risk_score: risk.score } });
    })();
    return {
      status: "accepted",
      reasons,
      data: {
        case_id: env.case_id,
        before,
        after: { priority: risk.priority, queue: risk.queue, risk_score: risk.score, expires_at: expiresAt, expiry_action: risk.expiry_action },
        changed: before.priority !== risk.priority || before.queue !== risk.queue || before.risk_score !== risk.score,
      },
    };
  }

  // ---------- 到期清理 ----------

  cleanupPreview(params: { asOfIso?: string; caseId?: string }):
    | { ok: true; as_of: string; items: Record<string, unknown>[] }
    | { ok: false; errors: RowError[] } {
    const asOf = this.resolveAsOf(params.asOfIso, true);
    if (asOf instanceof Error) return { ok: false, errors: [err("CLOCK_OVERRIDE_DISABLED", asOf.message, "as_of")] };
    const rows = this.duePlanRows(asOf, params.caseId);
    return {
      ok: true,
      as_of: toUtcIso(asOf),
      items: rows.map((r) => ({
        case_id: r.case_id,
        target_type: r.target_type,
        target_ref: r.target_ref,
        action: r.action,
        scheduled_for: r.scheduled_for,
      })),
    };
  }

  private executeCleanup(env: Envelope): ServiceResult {
    const asOfIso = (env.payload.as_of as string | undefined) ?? null;
    const asOf = this.resolveAsOf(asOfIso, false);
    if (asOf instanceof Error) {
      return this.rejectCase(env, ["CLOCK_OVERRIDE_DISABLED"], [err("CLOCK_OVERRIDE_DISABLED", asOf.message, "as_of")]);
    }
    const caseId = typeof env.payload.case_id === "string" ? env.payload.case_id : undefined;
    const dueCaseIds = this.duePlanRows(asOf, caseId).map((r) => r.case_id);
    const uniqueIds = [...new Set(dueCaseIds)];

    const outcomes = this.db.transaction(() => {
      const done: unknown[] = [];
      for (const id of uniqueIds) {
        const row = this.getCase(id);
        if (!row) {
          // 案件已被删除：取消其残留计划
          this.db.prepare("UPDATE cleanup_plan SET status='cancelled' WHERE case_id=? AND status='pending'").run(id);
          continue;
        }
        done.push(this.applyExpiry(row, asOf));
      }
      this.writeAudit(env, "accepted", ["RETENTION_DUE"], { cleaned: done.length });
      return done;
    })();

    return { status: "accepted", reasons: ["RETENTION_DUE"], data: { as_of: toUtcIso(asOf), cleaned: outcomes } };
  }

  /** 对单个案件执行到期动作并核销计划；调用方须在事务内。 */
  private applyExpiry(row: CaseRow, asOf: Date): unknown {
    const iso = toUtcIso(asOf);
    const affectedFields: string[] = [];
    const affectedAttachments: string[] = [];

    if (row.expiry_action === "delete_record") {
      this.db
        .prepare(
          "UPDATE cleanup_plan SET status='done', executed_at=? WHERE case_id=? AND status='pending' AND scheduled_for<=?",
        )
        .run(iso, row.case_id, iso);
      this.db.prepare("DELETE FROM attachment_refs WHERE case_id=?").run(row.case_id);
      this.db.prepare("DELETE FROM attachments WHERE case_id=?").run(row.case_id);
      this.db.prepare("DELETE FROM cases WHERE case_id=?").run(row.case_id);
      return { case_id: row.case_id, action: "delete_record", status_after: "deleted", deleted: true };
    }

    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    for (const key of this.policy.sensitive_fields) {
      if (key in record) {
        record[key] = row.expiry_action === "anonymize" ? anonymizeValue(record[key]) : maskValue(record[key]);
        affectedFields.push(key);
      }
    }
    const atts = this.db.prepare("SELECT * FROM attachments WHERE case_id=?").all(row.case_id) as AttRow[];
    for (const att of atts) {
      const meta = JSON.parse(att.meta_json) as Record<string, unknown>;
      let touched = false;
      for (const key of this.policy.sensitive_fields) {
        if (key in meta) {
          meta[key] = row.expiry_action === "anonymize" ? anonymizeValue(meta[key]) : maskValue(meta[key]);
          touched = true;
        }
      }
      if (touched) {
        this.db.prepare("UPDATE attachments SET meta_json=? WHERE id=?").run(JSON.stringify(meta), att.id);
        affectedAttachments.push(att.attachment_id);
      }
    }
    const statusAfter = row.expiry_action === "anonymize" ? "anonymized" : "redacted";
    this.db
      .prepare("UPDATE cases SET record_json=?, status=?, version=version+1 WHERE case_id=?")
      .run(JSON.stringify(record), statusAfter, row.case_id);
    this.db
      .prepare("UPDATE cleanup_plan SET status='done', executed_at=? WHERE case_id=? AND status='pending' AND scheduled_for<=?")
      .run(iso, row.case_id, iso);
    return {
      case_id: row.case_id,
      action: row.expiry_action,
      status_after: statusAfter,
      affected_fields: affectedFields,
      affected_attachments: affectedAttachments,
    };
  }

  /** 依据当前案件状态重建清理计划：旧 pending 计划取消，按 expires_at 重新编排。 */
  private rebuildCleanupPlan(caseId: string): void {
    const row = this.getCase(caseId);
    if (!row) return;
    this.db.prepare("UPDATE cleanup_plan SET status='cancelled' WHERE case_id=? AND status='pending'").run(caseId);
    const nowIso = toUtcIso(this.now());
    const insert = this.db.prepare(
      `INSERT INTO cleanup_plan(case_id, target_type, target_ref, action, scheduled_for, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    );
    insert.run(caseId, "case", caseId, row.expiry_action, row.expires_at, nowIso);
    if (row.expiry_action === "delete_record") return; // 整案删除只需案件级一条计划
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    const fieldTargets = this.policy.sensitive_fields.filter((f) => f in record);
    for (const f of fieldTargets) insert.run(caseId, "case_field", f, row.expiry_action, row.expires_at, nowIso);
    // 每个含敏感字段的附件元数据生成一条附件级计划（动作覆盖其全部敏感键）
    const atts = this.db.prepare("SELECT attachment_id, meta_json FROM attachments WHERE case_id=?").all(caseId) as AttRow[];
    for (const att of atts) {
      const meta = JSON.parse(att.meta_json) as Record<string, unknown>;
      const hasSensitive = this.policy.sensitive_fields.some((f) => f in meta);
      if (hasSensitive || row.expiry_action === "anonymize") {
        insert.run(caseId, "attachment", att.attachment_id, row.expiry_action, row.expires_at, nowIso);
      }
    }
  }

  private resolveAsOf(asOfIso: string | null | undefined, allowFuture: boolean): Date | Error {
    if (asOfIso === undefined || asOfIso === null) return this.now();
    const d = parseIso(asOfIso);
    if (!d) return new Error("as_of 必须是带时区的 ISO8601 时间");
    const skew = this.policy.future_skew_seconds * 1000;
    if (d.getTime() > this.now().getTime() + skew && !allowFuture && process.env.ALLOW_CLOCK_OVERRIDE !== "true") {
      return new Error("未来时间点的清理执行需在本地验证环境显式启用 ALLOW_CLOCK_OVERRIDE=true");
    }
    return d;
  }

  private duePlanRows(asOf: Date, caseId?: string): { case_id: string; target_type: string; target_ref: string; action: string; scheduled_for: string }[] {
    const iso = toUtcIso(asOf);
    const sql = `SELECT case_id, target_type, target_ref, action, scheduled_for FROM cleanup_plan
                 WHERE status='pending' AND scheduled_for <= ? ${caseId ? "AND case_id = ?" : ""}
                 ORDER BY scheduled_for, id`;
    return this.db.prepare(sql).all(iso, ...(caseId ? [caseId] : [])) as never;
  }

  // ---------- 队列分页 ----------

  listQueues(opts: { queue?: string; limit: number; cursor?: number }): {
    queue?: string;
    limit: number;
    next_cursor: number | null;
    items: Record<string, unknown>[];
  } {
    const limit = Math.min(Math.max(opts.limit, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.queue) {
      where.push("queue = ?");
      params.push(opts.queue);
    }
    if (opts.cursor !== undefined) {
      where.push("queue_seq > ?");
      params.push(opts.cursor);
    }
    const rows = this.db
      .prepare(
        `SELECT case_id, queue, priority, queue_seq, risk_score, status, registered_at, expires_at
         FROM cases ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY queue_seq ASC LIMIT ?`,
      )
      .all(...params, limit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1] as { queue_seq?: number } | undefined;
    return {
      ...(opts.queue ? { queue: opts.queue } : {}),
      limit,
      next_cursor: hasMore && last ? (last.queue_seq as number) : null,
      items,
    };
  }

  // ---------- 处理卡片 / 角色导出 ----------

  getCard(caseId: string, roleName: string): { ok: true; card: Record<string, unknown>; role: string } | { ok: false; errors: RowError[] } {
    const role = this.policy.roles[roleName];
    if (!role) return { ok: false, errors: [err("UNKNOWN_ROLE", `未知角色: ${roleName}`, "role")] };
    const view = this.buildCaseView(caseId);
    if (!view) return { ok: false, errors: [err("CASE_NOT_FOUND", `案件不存在: ${caseId}`, "case_id")] };
    return { ok: true, role: roleName, card: projectForRole(view.view, view.attachments, role, this.policy) };
  }

  exportForRole(roleName: string, caseIds?: string[]):
    | { ok: true; role: string; reason_codes: string[]; exported: unknown[] }
    | { ok: false; errors: RowError[] } {
    const role = this.policy.roles[roleName];
    if (!role) return { ok: false, errors: [err("UNKNOWN_ROLE", `未知角色: ${roleName}`, "role")] };
    let ids: string[];
    if (Array.isArray(caseIds)) {
      ids = caseIds.filter((x): x is string => typeof x === "string");
    } else {
      ids = (this.db.prepare("SELECT case_id FROM cases ORDER BY queue_seq").all() as { case_id: string }[]).map((r) => r.case_id);
    }
    const exported = ids.map((id) => {
      const built = this.buildCaseView(id);
      if (!built) return { case_id: id, found: false as const };
      const denied = Object.keys(built.view).filter((k) => !isFieldAllowed(role, k));
      return {
        case_id: id,
        found: true as const,
        reason_codes: built.view.reason_codes,
        denied_fields: denied,
        fields: projectForRole(built.view, built.attachments, role, this.policy),
      };
    });
    return { ok: true, role: roleName, reason_codes: deniedRoleHint(exported), exported };
  }

  private buildCaseView(caseId: string): { view: Record<string, unknown>; attachments: Record<string, unknown>[] } | null {
    const row = this.getCase(caseId);
    if (!row) return null;
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    const flags = JSON.parse(row.risk_flags) as string[];
    const refs = this.db.prepare("SELECT * FROM attachment_refs WHERE case_id=? ORDER BY id").all(caseId) as RefRow[];
    const atts = this.db.prepare("SELECT * FROM attachments WHERE case_id=? ORDER BY position, id").all(caseId) as AttRow[];

    const nextDue = this.db
      .prepare("SELECT MIN(scheduled_for) AS s FROM cleanup_plan WHERE case_id=? AND status='pending'")
      .get(caseId) as { s: string | null };

    const reasonCodes: string[] = [];
    if (refs.length) reasonCodes.push("DUPLICATE_ATTACHMENT");
    if (row.version > 1 && row.status !== "redacted" && row.status !== "anonymized") reasonCodes.push("PRIORITY_RECALCULATED");
    if (row.status === "redacted" || row.status === "anonymized") reasonCodes.push("RETENTION_DUE");

    const view: Record<string, unknown> = {
      ...record,
      case_id: row.case_id,
      request_id: row.last_request_id,
      source_channel: row.source_channel,
      occurred_at: row.occurred_at,
      registered_at: row.registered_at,
      queue_seq: row.queue_seq,
      priority: row.priority,
      queue: row.queue,
      risk_score: row.risk_score,
      status: row.status,
      retention_days: row.retention_days,
      expires_at: row.expires_at,
      expiry_action: row.expiry_action,
      scheduled_for: nextDue?.s ?? null,
      risk_flags: flags,
      reason_codes: reasonCodes,
    };

    const attachments: Record<string, unknown>[] = atts.map((a) => ({
      attachment_id: a.attachment_id,
      kind: a.kind,
      digest: a.digest,
      position: a.position,
      duplicate: false,
      ref_to: null,
      meta: JSON.parse(a.meta_json),
    }));
    for (const ref of refs) {
      attachments.push({
        attachment_id: ref.submitted_attachment_id,
        digest: ref.digest,
        duplicate: true,
        ref_to: ref.canonical_attachment_id,
        meta: {},
      });
    }
    return { view, attachments };
  }

  // ---------- 辅助 ----------

  private getCase(caseId: string): CaseRow | undefined {
    return this.db.prepare("SELECT * FROM cases WHERE case_id=?").get(caseId) as CaseRow | undefined;
  }

  private auditExists(requestId: string): boolean {
    return (this.db.prepare("SELECT 1 FROM request_audit WHERE request_id=?").get(requestId) as unknown) !== undefined;
  }

  private writeAudit(env: Envelope, status: "accepted" | "rejected", reasons: string[], result: unknown): void {
    this.db
      .prepare(
        `INSERT INTO request_audit(request_id, case_id, operation, actor_role, occurred_at, accepted_at, status, reasons, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        env.request_id,
        env.case_id,
        env.operation,
        env.actor_role,
        toUtcIso(new Date(env.occurred_at)),
        toUtcIso(this.now()),
        status,
        JSON.stringify(reasons),
        JSON.stringify(result),
      );
  }

  /** 拒绝：不写任何业务数据，仅留一条拒绝审计作为证据。 */
  private rejectCase(env: Envelope, reasons: string[], errors: RowError[]): ServiceResult {
    this.writeAudit(env, "rejected", reasons, { errors });
    return { status: "rejected", reasons, errors };
  }

  private nextSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS s FROM cases").get() as { s: number };
    return row.s;
  }

  private nextPosition(caseId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS s FROM attachments WHERE case_id=?").get(caseId) as { s: number };
    return row.s;
  }

  private attachmentIdTaken(caseId: string, attachmentId: string): boolean {
    const inAttachments = this.db
      .prepare("SELECT 1 FROM attachments WHERE case_id=? AND attachment_id=?")
      .get(caseId, attachmentId);
    if (inAttachments) return true;
    // 重复摘要提交时 id 只落在 refs 表，同样视为占用
    return (
      (this.db
        .prepare("SELECT 1 FROM attachment_refs WHERE case_id=? AND submitted_attachment_id=?")
        .get(caseId, attachmentId) as unknown) !== undefined
    );
  }

  private buildRecord(payload: Record<string, unknown>): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === "attachments" || k === "retention_days") continue;
      record[k] = v;
    }
    return record;
  }

  private extractMeta(a: AttachmentInput): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (k === "attachment_id" || k === "kind" || k === "digest") continue;
      meta[k] = v;
    }
    return meta;
  }

  private extractFlags(v: unknown): { flags: string[]; unknown: string[]; errors: RowError[] } {
    if (v === undefined) return { flags: [], unknown: [], errors: [] };
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      return { flags: [], unknown: [], errors: [err("BAD_RISK_FLAGS", "risk_flags 必须是字符串数组", "risk_flags")] };
    }
    const flags = [...new Set(v as string[])];
    const unknown = flags.filter((f) => !Object.prototype.hasOwnProperty.call(this.policy.risk.flags, f));
    return { flags, unknown, errors: [] };
  }
}

function deniedRoleHint(exported: unknown[]): string[] {
  const list = exported as { denied_fields?: string[] }[];
  return list.some((e) => (e.denied_fields?.length ?? 0) > 0) ? ["ROLE_FIELD_DENIED"] : [];
}

export type { RolePolicy };
