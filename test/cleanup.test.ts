import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { api, rid, startHarness } from "./helpers.ts";

const DA = "sha256:aaaaaaaaaaaaaaaa";
const DB = "sha256:bbbbbbbbbbbbbbbb";

function regBody(caseId: string, over: Record<string, unknown> = {}) {
  return {
    request_id: rid(),
    operation: "register_case" as const,
    case_id: caseId,
    actor_role: "reviewer",
    occurred_at: "2026-09-10T09:55:00+08:00",
    payload: {
      source_channel: "user_report",
      retention_days: 2,
      subject_name: "张三",
      reporter_contact: "alice@example.test",
      attachments: [{ attachment_id: "att-1", kind: "url", digest: DA, url: "https://example.test/secret" }],
      ...over,
    },
  };
}

function cleanupBody(over: Record<string, unknown> = {}) {
  return {
    request_id: rid(),
    operation: "cleanup" as const,
    case_id: "global",
    actor_role: "admin",
    occurred_at: "2026-09-12T10:00:00+08:00",
    payload: { ...over },
  };
}

describe("到期清理：预览与执行", () => {
  it("未到期不产生计划项；到期后预览命中且执行整案删除（P3 → delete_record）", async () => {
    const h = await startHarness();
    const reg = await api(h.base, "POST", "/v1/requests", regBody("case-del"));
    assert.equal(reg.status, 200);
    assert.equal(reg.body.data.expiry_action, "delete_record");

    const nowPreview = await api(h.base, "GET", "/v1/cleanup/preview");
    assert.equal(nowPreview.body.items.length, 0);

    // 登记时间 2026-09-10T02:00Z + 2 天 = 2026-09-12T02:00Z
    const duePreview = await api(h.base, "GET", "/v1/cleanup/preview?as_of=2026-09-12T02:00:00Z");
    assert.equal(duePreview.body.items.length, 1);
    assert.equal(duePreview.body.items[0].case_id, "case-del");
    assert.equal(duePreview.body.items[0].action, "delete_record");

    // 推进服务时钟后执行（过期边界恰好到期）
    h.setNow(new Date("2026-09-12T02:00:00Z"));
    const done = await api(h.base, "POST", "/v1/requests", cleanupBody());
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.cleaned[0].status_after, "deleted");

    const card = await api(h.base, "GET", "/v1/cases/case-del/card?role=admin");
    assert.equal(card.status, 404);
    const after = await api(h.base, "GET", "/v1/cleanup/preview?as_of=2099-01-01T00:00:00Z");
    assert.equal(after.body.items.length, 0);
  });

  it("P2 到期执行字段级脱敏，原文在库中被替换（admin 也只见掩码）", async () => {
    const h = await startHarness();
    // user_report 20 + video 15 = 35 → P2 redact_sensitive
    const body = regBody("case-redact", {
      retention_days: 3,
      attachments: [{ attachment_id: "att-v", kind: "video", digest: DB, url: "https://example.test/x" }],
    });
    await api(h.base, "POST", "/v1/requests", body);

    const before = await api(h.base, "GET", "/v1/cases/case-redact/card?role=admin");
    assert.equal(before.body.card.subject_name, "张三");
    assert.equal(before.body.card.attachments[0].meta.url, "https://example.test/x");

    h.setNow(new Date("2026-09-14T00:00:00Z"));
    const done = await api(h.base, "POST", "/v1/requests", {
      ...cleanupBody(),
      occurred_at: "2026-09-14T08:00:00+08:00",
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const outcome = done.body.data.cleaned[0];
    assert.equal(outcome.action, "redact_sensitive");
    assert.ok(outcome.affected_fields.includes("subject_name"));
    assert.ok(outcome.affected_fields.includes("url") === false); // url 在附件 meta
    assert.deepEqual(outcome.affected_attachments, ["att-v"]);

    const after = await api(h.base, "GET", "/v1/cases/case-redact/card?role=admin");
    assert.equal(after.body.card.status, "redacted");
    assert.ok(String(after.body.card.subject_name).includes("***"));
    assert.ok(String(after.body.card.reporter_contact).includes("***"));
    assert.ok(String(after.body.card.attachments[0].meta.url).includes("***"));
  });

  it("P0 到期匿名化：敏感值清空，案件结构保留", async () => {
    const h = await startHarness();
    // regulator 55 + minor_involved 40 + url 5 = 100 → P0 anonymize
    const body = regBody("case-anon", {
      source_channel: "regulator",
      retention_days: 1,
      risk_flags: ["minor_involved"],
    });
    const reg = await api(h.base, "POST", "/v1/requests", body);
    assert.equal(reg.body.data.priority, "P0");
    assert.equal(reg.body.data.expiry_action, "anonymize");

    h.setNow(new Date("2026-09-12T00:00:00Z"));
    const done = await api(h.base, "POST", "/v1/requests", {
      ...cleanupBody(),
      occurred_at: "2026-09-12T08:00:00+08:00",
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.cleaned[0].status_after, "anonymized");

    const card = await api(h.base, "GET", "/v1/cases/case-anon/card?role=admin");
    assert.equal(card.body.card.status, "anonymized");
    assert.equal(card.body.card.subject_name, null);
    assert.ok(card.body.card.reason_codes.includes("RETENTION_DUE"));
    // 非敏感字段仍保留
    assert.equal(card.body.card.source_channel, "regulator");
  });

  it("可按 case_id 限定预览与执行", async () => {
    const h = await startHarness();
    const b1 = regBody("case-scope-1", { retention_days: 1 });
    b1.request_id = rid();
    const b2 = regBody("case-scope-2", { retention_days: 10 });
    b2.request_id = rid();
    await api(h.base, "POST", "/v1/requests", b1);
    await api(h.base, "POST", "/v1/requests", b2);

    h.setNow(new Date("2026-09-15T01:00:00Z"));
    const preview = await api(h.base, "GET", "/v1/cleanup/preview?case_id=case-scope-2");
    // 10 天未到期
    assert.equal(preview.body.items.length, 0);

    const done = await api(h.base, "POST", "/v1/requests", {
      ...cleanupBody({ case_id: "case-scope-1" }),
      occurred_at: "2026-09-15T09:00:00+08:00",
    });
    assert.equal(done.body.data.cleaned.length, 1);
    const still = await api(h.base, "GET", "/v1/cases/case-scope-2/card?role=admin");
    assert.equal(still.status, 200);
  });

  it("清理是单事务：中途 SQL 失败整体回滚，已删案件恢复", async () => {
    const h = await startHarness();
    await api(h.base, "POST", "/v1/requests", regBody("case-ok", { retention_days: 1 }));
    await api(h.base, "POST", "/v1/requests", regBody("case-block", { retention_days: 1 }));
    h.db.exec(`
      CREATE TRIGGER fail_delete BEFORE DELETE ON attachments
      WHEN old.case_id = 'case-block'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);
    h.setNow(new Date("2026-09-15T01:00:00Z"));
    const r = await api(h.base, "POST", "/v1/requests", {
      ...cleanupBody(),
      occurred_at: "2026-09-15T08:00:00+08:00",
    });
    assert.equal(r.status, 500);
    // 两个案件都必须还在（事务回滚）
    for (const id of ["case-ok", "case-block"]) {
      const row = h.db.prepare("SELECT case_id FROM cases WHERE case_id=?").get(id);
      assert.ok(row, `${id} 应当因回滚仍存在`);
    }
    // 拒绝/失败不写成功审计
    const audit = h.db.prepare("SELECT COUNT(*) AS c FROM request_audit WHERE operation='cleanup' AND status='accepted'").get() as { c: number };
    assert.equal(audit.c, 0);

    h.db.exec("DROP TRIGGER fail_delete");
    const retry = await api(h.base, "POST", "/v1/requests", {
      ...cleanupBody(),
      occurred_at: "2026-09-15T09:05:00+08:00",
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.cleaned.length, 2);
  });
});
