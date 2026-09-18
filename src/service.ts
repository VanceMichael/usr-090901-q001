import type { DB } from "./db.js";
import { transaction } from "./db.js";
import { ERR } from "./errors.js";
import type { Policy } from "./policy.js";
import { addDaysIso, nowIso, parseIso, toIso, withinWindow } from "./time.js";
import type {
  AttachmentInput,
  AttachmentRef,
  AttachmentRowResult,
  CleanupPlanItem,
  CleanupResultItem,
  Envelope,
  ExportPayload,
  RecalculatePayload,
  RegisterAttachmentsPayload,
  RegisterCasePayload,
  RiskFactor,
} from "./types.js";

interface CaseRow {
  case_id: string;
  source_channel: string;
  actor_role: string;
  occurred_at: string;
  registered_at: string;
  recalculated_at: string | null;
  retention_days: number;
  expires_at: string;
  priority_score: number;
  priority_level: string;
  queue: string;
  queue_seq: number;
  status: string;
  risk_tags: string;
  risk_factors: string;
  summary: string | null;
  reporter_contact: string | null;
  subject_real_name: string | null;
  subject_id_number: string | null;
  subject_address: string | null;
  evidence_urls: string;
  internal_note: string | null;
  purged_at: string | null;
  purge_status: string;
}

interface AttRow {
  digest: string;
  kind: string;
  first_case_id: string;
  first_request: string;
}
interface CaseAttRow {
  digest: string;
  attachment_id: string;
  request_id: string;
  is_duplicate: number;
}

export interface RiskResult {
  score: number;
  level: string;
  queue: string;
  factors: RiskFactor[];
}

function bandFor(policy: Policy, score: number) {
  const band =
    policy.priority_levels.find((b) => score >= b.min_score) ??
    policy.priority_levels[policy.priority_levels.length - 1]!;
  return band;
}

export class DispatchService {
  constructor(
    private db: DB,
    private policy: Policy
  ) {}

  // ---------- 风险计算 ----------

  /** 依据规则重算分数：渠道基础分 + 风险标签 + 去重后附件权重 */
  private computeRisk(
    sourceChannel: string,
    tags: string[],
    uniqueDigests: { digest: string; kind: string }[]
  ): RiskResult {
    const factors: RiskFactor[] = [];
    const base = this.policy.source_channels[sourceChannel]!.base_score;
    factors.push({ code: `channel:${sourceChannel}`, points: base });

    for (const tag of tags) {
      const w = this.policy.risk_tags[tag] ?? 0;
      if (w > 0) factors.push({ code: `tag:${tag}`, points: w });
    }

    for (const a of uniqueDigests) {
      const kindW = this.policy.attachments.kind_weights[a.kind] ?? 0;
      const w = this.policy.risk.first_attachment_weight + kindW;
      factors.push({ code: `attachment:${a.kind}`, points: w });
    }

    const raw = factors.reduce((s, f) => s + f.points, 0);
    const score = Math.max(0, Math.min(raw, this.policy.risk.score_cap));
    const band = bandFor(this.policy, score);
    return { score, level: band.level, queue: band.queue, factors };
  }

  private uniqueCaseAttachments(caseId: string): { digest: string; kind: string }[] {
    const rows = this.db
      .prepare(
        `SELECT ca.digest AS digest, a.kind AS kind
         FROM case_attachments ca JOIN attachments a ON a.digest = ca.digest
         WHERE ca.case_id = ?
         GROUP BY ca.digest`
      )
      .all(caseId) as { digest: string; kind: string }[];
    return rows;
  }

  private nextQueueSeq(queue: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO queue_counters(queue, last_seq) VALUES(?, 1)
         ON CONFLICT(queue) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`
      )
      .get(queue) as { last_seq: number };
    return row.last_seq;
  }

  private assertTimeWindow(envelope: Envelope): void {
    const t = parseIso(envelope.occurred_at, "occurred_at");
    const now = Date.now();
    const ok = withinWindow(
      t,
      now,
      this.policy.time_window.max_age_days * 86_400_000,
      this.policy.time_window.future_skew_seconds * 1000
    );
    if (!ok) {
      throw ERR.timeWindow(
        `occurred_at ${envelope.occurred_at} 超出允许时间窗（最多早于当前 ${this.policy.time_window.max_age_days} 天，或晚于当前 ${this.policy.time_window.future_skew_seconds} 秒）`
      );
    }
  }

  private logRequest(
    env: Envelope,
    ok: boolean,
    err?: { code: string; message: string }
  ): void {
    this.db
      .prepare(
        `INSERT INTO request_log(request_id, operation, case_id, actor_role, ok, error_code, error_message, received_at)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        env.request_id,
        env.operation,
        env.case_id,
        env.actor_role,
        ok ? 1 : 0,
        err?.code ?? null,
        err?.message ?? null,
        nowIso()
      );
  }

  // ---------- 单案登记 ----------

  registerCase(env: Envelope, payload: RegisterCasePayload) {
    this.assertTimeWindow(env);
    const exists = this.db
      .prepare("SELECT 1 FROM cases WHERE case_id = ?")
      .get(env.case_id);
    if (exists) throw ERR.caseExists(env.case_id);

    const registeredAt = nowIso();
    const expiresAt = addDaysIso(registeredAt, payload.retention_days);
    const tags = payload.risk_tags ?? [];
    const incoming = dedupeByDigest(payload.attachments ?? []);
    const risk = this.computeRisk(payload.source_channel, tags, incoming);

    return transaction(this.db, () => {
      const seq = this.nextQueueSeq(risk.queue);
      // 先写案件（case_attachments 外键指向 cases），再写附件索引与引用
      this.db
        .prepare(
          `INSERT INTO cases(
            case_id, source_channel, actor_role, occurred_at, registered_at,
            retention_days, expires_at, priority_score, priority_level, queue, queue_seq,
            risk_tags, risk_factors, summary,
            reporter_contact, subject_real_name, subject_id_number, subject_address,
            evidence_urls, internal_note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          env.case_id,
          payload.source_channel,
          env.actor_role,
          env.occurred_at,
          registeredAt,
          payload.retention_days,
          expiresAt,
          risk.score,
          risk.level,
          risk.queue,
          seq,
          JSON.stringify(tags),
          JSON.stringify(risk.factors),
          payload.summary ?? null,
          payload.reporter_contact ?? null,
          payload.subject_real_name ?? null,
          payload.subject_id_number ?? null,
          payload.subject_address ?? null,
          JSON.stringify(payload.evidence_urls ?? []),
          payload.internal_note ?? null
        );

      const attachmentRefs: AttachmentRef[] = [];
      const seenDigestThisReq = new Map<string, AttachmentInput>();
      for (const att of payload.attachments ?? []) {
        const ref = this.linkAttachment(env, att, seenDigestThisReq);
        attachmentRefs.push(ref);
        seenDigestThisReq.set(att.digest, att);
      }

      this.db
        .prepare(
          `INSERT INTO cleanup_plan(case_id, expires_at, action, created_at)
           VALUES(?,?,?,?)`
        )
        .run(env.case_id, expiresAt, this.policy.cleanup_action, registeredAt);

      this.logRequest(env, true);
      return {
        case_id: env.case_id,
        registered_at: registeredAt,
        expires_at: expiresAt,
        priority_score: risk.score,
        priority_level: risk.level,
        queue: risk.queue,
        queue_seq: seq,
        risk_factors: risk.factors,
        attachments: attachmentRefs,
        duplicate_count: attachmentRefs.filter((r) => r.duplicate).length,
      };
    });
  }

  /** 建立/复用附件全局索引并建立案件引用；重复摘要只保留一份 */
  private linkAttachment(
    env: Envelope,
    att: AttachmentInput,
    seenThisRequest: Map<string, AttachmentInput>
  ): AttachmentRef {
    const existing = this.db
      .prepare("SELECT * FROM attachments WHERE digest = ?")
      .get(att.digest) as AttRow | undefined;
    const earlierInline = seenThisRequest.get(att.digest);
    const alreadyLinked = Boolean(
      this.db
        .prepare("SELECT 1 FROM case_attachments WHERE case_id = ? AND digest = ?")
        .get(env.case_id, att.digest)
    );

    if (existing) {
      // 仅在案件确实新增引用时增加引用计数（同案重复链接不重复计数）
      if (!alreadyLinked) {
        this.db
          .prepare("UPDATE attachments SET ref_count = ref_count + 1 WHERE digest = ?")
          .run(att.digest);
      }
      const originalLink = this.db
        .prepare(
          "SELECT attachment_id, request_id FROM case_attachments WHERE digest = ? AND case_id = ? LIMIT 1"
        )
        .get(att.digest, existing.first_case_id) as CaseAttRow | undefined;
      this.insertCaseAttachment(env, att, 1);
      return {
        attachment_id: att.attachment_id,
        digest: att.digest,
        kind: existing.kind,
        duplicate: true,
        already_linked: alreadyLinked,
        original_case_id: existing.first_case_id,
        original_attachment_id:
          earlierInline?.attachment_id ?? originalLink?.attachment_id ?? undefined,
        original_request_id: earlierInline ? env.request_id : existing.first_request,
      };
    }

    if (earlierInline) {
      // 同一请求内重复摘要：引用本次首个行，不新增附件行、不增加计数
      this.insertCaseAttachment(env, att, 1);
      return {
        attachment_id: att.attachment_id,
        digest: att.digest,
        kind: att.kind,
        duplicate: true,
        original_case_id: env.case_id,
        original_attachment_id: earlierInline.attachment_id,
        original_request_id: env.request_id,
      };
    }

    this.db
      .prepare(
        `INSERT INTO attachments(digest, kind, first_case_id, first_request, created_at, ref_count)
         VALUES(?,?,?,?,?,1)`
      )
      .run(att.digest, att.kind, env.case_id, env.request_id, nowIso());
    this.insertCaseAttachment(env, att, 0);
    return {
      attachment_id: att.attachment_id,
      digest: att.digest,
      kind: att.kind,
      duplicate: false,
    };
  }

  private insertCaseAttachment(env: Envelope, att: AttachmentInput, isDuplicate: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO case_attachments(case_id, digest, attachment_id, request_id, is_duplicate, linked_at)
         VALUES(?,?,?,?,?,?)`
      )
      .run(env.case_id, att.digest, att.attachment_id, env.request_id, isDuplicate, nowIso());
  }

  // ---------- 附件批量登记（按行隔离） ----------

  /**
   * 批量登记：逐行校验，坏行返回错误不写入；合法行在单个事务内写入并重算风险。
   * rows 为原始未可信输入。
   */
  registerAttachments(env: Envelope, rawRows: unknown[]) {
    this.assertTimeWindow(env);
    this.getCaseOrThrow(env.case_id);
    if (rawRows.length > this.policy.attachments.max_per_request) {
      throw ERR.tooManyAttachments(rawRows.length, this.policy.attachments.max_per_request);
    }

    const digestRe = new RegExp(this.policy.attachments.digest_pattern);
    const seenId = new Set<string>();
    const results: AttachmentRowResult[] = [];
    const valid: { index: number; att: AttachmentInput }[] = [];

    rawRows.forEach((raw, index) => {
      const fail = (code: string, message: string, partial?: Partial<AttachmentInput>) =>
        results.push({
          index,
          ok: false,
          attachment_id: partial?.attachment_id ?? `row[${index}]`,
          digest: partial?.digest ?? "",
          kind: partial?.kind ?? "",
          duplicate: false,
          error_code: code,
          error_message: message,
        });

      if (!isObj(raw)) return fail("INVALID_ATTACHMENT_ROW", "附件行必须是对象");
      const { attachment_id, kind, digest } = raw as Record<string, unknown>;
      if (typeof attachment_id !== "string" || !/^[\w.:-]{1,128}$/.test(attachment_id)) {
        return fail("INVALID_ATTACHMENT_ID", "附件行缺少合法 attachment_id", {
          digest: typeof digest === "string" ? digest : "",
          kind: typeof kind === "string" ? kind : "",
        });
      }
      if (typeof kind !== "string" || !this.policy.attachments.kinds.includes(kind)) {
        return fail("INVALID_ATTACHMENT_KIND", `非法附件类型: ${String(kind)}`, {
          attachment_id,
          digest: typeof digest === "string" ? digest : "",
          kind: typeof kind === "string" ? kind : "",
        });
      }
      if (typeof digest !== "string" || !digestRe.test(digest)) {
        return fail("INVALID_ATTACHMENT_DIGEST", `非法摘要: ${String(digest)}`, {
          attachment_id,
          kind,
        });
      }
      if (seenId.has(attachment_id)) {
        return fail(
          "DUPLICATE_INLINE_ATTACHMENT_ID",
          `本批 attachment_id 重复: ${attachment_id}`,
          { attachment_id, kind, digest }
        );
      }
      seenId.add(attachment_id);
      valid.push({ index, att: { attachment_id, kind, digest } });
    });

    // 仅合法行进入事务；事务抛错则全部合法行一并回滚
    const { acceptedRows, risk } = transaction(this.db, () => {
      const seenThisReq = new Map<string, AttachmentInput>();
      const out: AttachmentRowResult[] = [];
      for (const { index, att } of valid) {
        const ref = this.linkAttachment(env, att, seenThisReq);
        seenThisReq.set(att.digest, att);
        out.push({ index, ok: true, ...ref });
      }
      const risk = this.recalculateRiskInternal(env, undefined, "ATTACHMENTS_ADDED");
      this.logRequest(env, true);
      return { acceptedRows: out, risk };
    });

    results.push(...acceptedRows);
    results.sort((a, b) => a.index - b.index);

    return {
      case_id: env.case_id,
      rows: results,
      accepted: results.filter((r) => r.ok).length,
      rejected: results.filter((r) => !r.ok).length,
      risk,
    };
  }

  // ---------- 风险重算 ----------

  recalculateRisk(env: Envelope, payload: RecalculatePayload) {
    this.assertTimeWindow(env);
    this.getCaseOrThrow(env.case_id);
    const result = transaction(this.db, () => {
      const r = this.recalculateRiskInternal(env, payload.risk_tags, "MANUAL_RECALCULATE");
      this.logRequest(env, true);
      return r;
    });
    return result;
  }

  /** 必须在事务内调用；tags 为 undefined 表示仅依据现有标签/附件重算 */
  private recalculateRiskInternal(
    env: Envelope,
    tags: string[] | undefined,
    reason: string
  ) {
    const c = this.getCaseOrThrow(env.case_id);
    const oldTags = JSON.parse(c.risk_tags) as string[];
    const newTags = tags ?? oldTags;
    const risk = this.computeRisk(c.source_channel, newTags, this.uniqueCaseAttachments(env.case_id));
    const previous = {
      priority_score: c.priority_score,
      priority_level: c.priority_level,
      queue: c.queue,
      queue_seq: c.queue_seq,
    };
    const tagsChanged =
      tags !== undefined &&
      JSON.stringify([...oldTags].sort()) !== JSON.stringify([...newTags].sort());
    const changed =
      previous.priority_score !== risk.score ||
      previous.priority_level !== risk.level ||
      previous.queue !== risk.queue ||
      tagsChanged;

    let newSeq = c.queue_seq;
    if (risk.queue !== c.queue) newSeq = this.nextQueueSeq(risk.queue);

    this.db
      .prepare(
        `UPDATE cases SET
           risk_tags = ?, risk_factors = ?,
           priority_score = ?, priority_level = ?, queue = ?, queue_seq = ?,
           recalculated_at = ?
         WHERE case_id = ?`
      )
      .run(
        JSON.stringify(newTags),
        JSON.stringify(risk.factors),
        risk.score,
        risk.level,
        risk.queue,
        newSeq,
        nowIso(),
        env.case_id
      );

    return {
      case_id: env.case_id,
      reason: changed ? "PRIORITY_RECALCULATED" : reason,
      changed,
      previous,
      priority_score: risk.score,
      priority_level: risk.level,
      queue: risk.queue,
      queue_seq: newSeq,
      risk_tags: newTags,
      risk_factors: risk.factors,
    };
  }

  // ---------- 到期清理 ----------

  private purgableFields(c: CaseRow): string[] {
    const present: string[] = [];
    if (c.reporter_contact !== null) present.push("reporter_contact");
    if (c.subject_real_name !== null) present.push("subject_real_name");
    if (c.subject_id_number !== null) present.push("subject_id_number");
    if (c.subject_address !== null) present.push("subject_address");
    const urls = JSON.parse(c.evidence_urls) as string[];
    if (urls.length > 0) present.push("evidence_urls");
    if (c.internal_note !== null) present.push("internal_note");
    return present;
  }

  private dueCases(nowIsoTime: string, caseId?: string, limit = 500): CaseRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cases
         WHERE purge_status = 'pending' AND expires_at <= ?
         ${caseId ? "AND case_id = ?" : ""}
         ORDER BY expires_at ASC, case_id ASC
         LIMIT ?`
      )
      .all(...(caseId ? [nowIsoTime, caseId, limit] : [nowIsoTime, limit])) as unknown as CaseRow[];
    return rows;
  }

  previewCleanup(env: Envelope, payload: { now?: string; case_id?: string; limit?: number }) {
    const at = payload.now ?? nowIso();
    parseIso(at, "now");
    const due = this.dueCases(at, payload.case_id, payload.limit ?? 500);
    const scheduled = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM cleanup_plan cp JOIN cases c ON c.case_id = cp.case_id
         WHERE c.purge_status = 'pending' AND cp.expires_at > ?`
      )
      .get(at) as { n: number };

    const items: CleanupPlanItem[] = due.map((c) => ({
      case_id: c.case_id,
      expires_at: c.expires_at,
      action: this.policy.cleanup_action,
      purge_status: c.purge_status,
      retention_days: c.retention_days,
      purgable_fields: this.purgableFields(c),
    }));
    this.logRequest(env, true);
    return { evaluated_at: at, due: items, scheduled_future: scheduled.n };
  }

  runCleanup(
    env: Envelope,
    payload: { now?: string; case_id?: string; limit?: number; execute?: boolean }
  ) {
    const at = payload.now ?? nowIso();
    parseIso(at, "now");
    if (payload.execute === false) {
      return this.previewCleanup(env, payload);
    }
    const due = this.dueCases(at, payload.case_id, payload.limit ?? 500);
    const executed: CleanupResultItem[] = [];

    transaction(this.db, () => {
      for (const c of due) {
        const fields = this.purgableFields(c);
        this.db
          .prepare(
            `UPDATE cases SET
               reporter_contact = NULL, subject_real_name = NULL, subject_id_number = NULL,
               subject_address = NULL, evidence_urls = '[]', internal_note = NULL,
               purge_status = 'purged', purged_at = ?
             WHERE case_id = ?`
          )
          .run(at, c.case_id);
        this.db.prepare("DELETE FROM cleanup_plan WHERE case_id = ?").run(c.case_id);
        this.db
          .prepare(
            `INSERT INTO cleanup_events(case_id, action, expired_at, executed_at, purged_fields, request_id)
             VALUES(?,?,?,?,?,?)`
          )
          .run(
            c.case_id,
            this.policy.cleanup_action,
            c.expires_at,
            at,
            JSON.stringify(fields),
            env.request_id
          );
        executed.push({
          case_id: c.case_id,
          action: this.policy.cleanup_action,
          expired_at: c.expires_at,
          executed_at: at,
          purged_fields: fields,
        });
      }
      this.logRequest(env, true);
    });

    return { evaluated_at: at, executed, executed_count: executed.length };
  }

  // ---------- 导出（角色字段白名单 + 脱敏） ----------

  private getCaseOrThrow(caseId: string): CaseRow {
    const c = this.db.prepare("SELECT * FROM cases WHERE case_id = ?").get(caseId) as
      | CaseRow
      | undefined;
    if (!c) throw ERR.caseNotFound(caseId);
    return c;
  }

  private attachmentRefs(caseId: string) {
    return (this.db
      .prepare(
        `SELECT ca.attachment_id AS attachment_id, ca.digest AS digest, a.kind AS kind,
                ca.is_duplicate AS is_duplicate, a.first_case_id AS original_case_id,
                a.first_request AS original_request_id
         FROM case_attachments ca JOIN attachments a ON a.digest = ca.digest
         WHERE ca.case_id = ? ORDER BY ca.rowid`
      )
      .all(caseId) as {
      attachment_id: string;
      digest: string;
      kind: string;
      is_duplicate: number;
      original_case_id: string;
      original_request_id: string;
    }[]).map((r) => ({
      attachment_id: r.attachment_id,
      digest: r.digest,
      kind: r.kind,
      duplicate: r.is_duplicate === 1,
      original_case_id: r.is_duplicate === 1 ? r.original_case_id : undefined,
      original_request_id: r.is_duplicate === 1 ? r.original_request_id : undefined,
    }));
  }

  private cleanupEvents(caseId: string) {
    return this.db
      .prepare(
        `SELECT id, action, expired_at, executed_at, purged_fields
         FROM cleanup_events WHERE case_id = ? ORDER BY id`
      )
      .all(caseId)
      .map((r) => {
        const row = r as {
          id: number;
          action: string;
          expired_at: string;
          executed_at: string;
          purged_fields: string;
        };
        return { ...row, purged_fields: JSON.parse(row.purged_fields) as string[] };
      });
  }

  /** 组装案件的全字段视图（未脱敏），随后按角色投影 */
  private fullView(c: CaseRow) {
    return {
      case_id: c.case_id,
      source_channel: c.source_channel,
      occurred_at: c.occurred_at,
      registered_at: c.registered_at,
      recalculated_at: c.recalculated_at,
      retention_days: c.retention_days,
      expires_at: c.expires_at,
      purged_at: c.purged_at,
      purge_status: c.purge_status,
      priority_score: c.priority_score,
      priority_level: c.priority_level,
      queue: c.queue,
      queue_seq: c.queue_seq,
      status: c.status,
      risk_tags: JSON.parse(c.risk_tags) as string[],
      risk_factors: JSON.parse(c.risk_factors) as RiskFactor[],
      summary: c.summary,
      reporter_contact: c.reporter_contact,
      subject_real_name: c.subject_real_name,
      subject_id_number: c.subject_id_number,
      subject_address: c.subject_address,
      evidence_urls: JSON.parse(c.evidence_urls) as string[],
      internal_note: c.internal_note,
      attachment_count:
        (this.db
          .prepare("SELECT COUNT(*) AS n FROM case_attachments WHERE case_id = ?")
          .get(c.case_id) as { n: number }).n,
      duplicate_count:
        (this.db
          .prepare("SELECT COUNT(*) AS n FROM case_attachments WHERE case_id = ? AND is_duplicate = 1")
          .get(c.case_id) as { n: number }).n,
      attachment_refs: this.attachmentRefs(c.case_id),
      cleanup_events: this.cleanupEvents(c.case_id),
    };
  }

  private allowedFields(role: string): { all: boolean; fields: Set<string> } {
    const spec = this.policy.roles[role]!;
    if (spec.includes("*")) return { all: true, fields: new Set() };
    const fields = new Set<string>();
    for (const f of spec) {
      if (f === "*card*") this.policy.card_fields.forEach((x) => fields.add(x));
      else fields.add(f);
    }
    return { all: false, fields };
  }

  exportFields(env: Envelope, payload: ExportPayload) {
    const ids =
      payload.case_ids && payload.case_ids.length > 0 ? payload.case_ids : [env.case_id];
    const { all, fields } = this.allowedFields(payload.role);

    return transaction(this.db, () => {
      const records = ids.map((id) => {
        const c = this.getCaseOrThrow(id);
        const view = this.fullView(c);
        const denied: string[] = [];
        const projected: Record<string, unknown> = {};
        const wanted = payload.fields ?? Object.keys(view);
        for (const f of wanted) {
          if (all || fields.has(f)) {
            projected[f] = (view as Record<string, unknown>)[f];
          } else {
            denied.push(f);
          }
        }
        return { case_id: id, fields: projected, denied_fields: denied };
      });
      this.logRequest(env, true);
      return { role: payload.role, records, denied_fields: [...new Set(records.flatMap((r) => r.denied_fields))] };
    });
  }

  // ---------- 队列分页与处理卡片 ----------

  listQueues() {
    const rows = this.db
      .prepare(
        `SELECT queue, COUNT(*) AS case_count, MIN(queue_seq) AS head_seq, MAX(queue_seq) AS tail_seq
         FROM cases GROUP BY queue ORDER BY queue`
      )
      .all() as { queue: string; case_count: number; head_seq: number; tail_seq: number }[];
    return { queues: rows };
  }

  listQueue(queue: string, limit: number, cursor?: number, role = "triager") {
    if (!(role in this.policy.roles)) throw ERR.roleDenied(role);
    const maxLimit = 200;
    const take = Math.min(Math.max(1, limit), maxLimit);
    const { all, fields } = this.allowedFields(role);
    const after = cursor ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM cases WHERE queue = ? AND queue_seq > ? ORDER BY queue_seq ASC LIMIT ?`
      )
      .all(queue, after, take + 1) as unknown as CaseRow[]
    const hasMore = rows.length > take;
    const page = rows.slice(0, take);
    const items = page.map((c) => this.projectCard(c, all, fields));
    const nextCursor = hasMore ? String(page[page.length - 1]!.queue_seq) : null;
    return { queue, limit: take, cursor: String(after), next_cursor: nextCursor, has_more: hasMore, items };
  }

  private projectCard(c: CaseRow, all: boolean, fields: Set<string>) {
    const view = this.fullView(c);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(view)) {
      if (all || fields.has(k)) out[k] = v;
    }
    return out;
  }

  caseCard(caseId: string, role = "triager") {
    if (!(role in this.policy.roles)) throw ERR.roleDenied(role);
    const c = this.getCaseOrThrow(caseId);
    const { all, fields } = this.allowedFields(role);
    return { case_id: caseId, role, card: this.projectCard(c, all, fields) };
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 同一登记请求内可能出现重复 digest，计分只计一次 */
function dedupeByDigest(atts: AttachmentInput[]): { digest: string; kind: string }[] {
  const map = new Map<string, { digest: string; kind: string }>();
  for (const a of atts) if (!map.has(a.digest)) map.set(a.digest, { digest: a.digest, kind: a.kind });
  return [...map.values()];
}
