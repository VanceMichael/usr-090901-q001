import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { api, rid, startHarness, type Harness } from "./helpers.ts";

const DA = "sha256:aaaaaaaaaaaaaaaa";

async function seedCase(h: Harness): Promise<void> {
  const r = await api(h.base, "POST", "/v1/requests", {
    request_id: rid(),
    operation: "register_case",
    case_id: "case-rbac",
    actor_role: "reviewer",
    occurred_at: "2026-09-10T09:55:00+08:00",
    payload: {
      source_channel: "internal_scan",
      retention_days: 60,
      subject_name: "李四",
      subject_phone: "13800000000",
      subject_id_number: "11010119900101000X",
      internal_notes: "内部研判备注",
      risk_flags: ["real_name_leak"],
      attachments: [
        { attachment_id: "att-1", kind: "screenshot", digest: DA, url: "https://example.test/private" },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

describe("角色字段白名单", () => {
  it("operator 卡片只见白名单字段且不含身份证与内部备注", async () => {
    const h = await startHarness();
    await seedCase(h);
    const r = await api(h.base, "GET", "/v1/cases/case-rbac/card?role=operator");
    assert.equal(r.status, 200);
    const keys = Object.keys(r.body.card).sort();
    assert.ok(keys.includes("priority"));
    assert.ok(keys.includes("attachments"));
    assert.ok(!keys.includes("subject_name"));
    assert.ok(!keys.includes("subject_id_number"));
    assert.ok(!keys.includes("internal_notes"));
    assert.ok(!keys.includes("risk_score"));
    // operator 的附件字段白名单：无 digest、无 meta
    assert.deepEqual(Object.keys(r.body.card.attachments[0]).sort(), ["attachment_id", "kind", "ref_to"]);
  });

  it("reviewer 可见部分 PII 但取值已脱敏，且看不到身份证/内部备注", async () => {
    const h = await startHarness();
    await seedCase(h);
    const r = await api(h.base, "GET", "/v1/cases/case-rbac/card?role=reviewer");
    assert.equal(r.status, 200);
    assert.ok(String(r.body.card.subject_name).includes("***"));
    assert.ok(String(r.body.card.subject_phone).includes("***"));
    assert.ok(!("subject_id_number" in r.body.card));
    assert.ok(!("internal_notes" in r.body.card));
  });

  it("auditor 可见风险与摘要，但看不到任何 PII 原文", async () => {
    const h = await startHarness();
    await seedCase(h);
    const r = await api(h.base, "GET", "/v1/cases/case-rbac/card?role=auditor");
    assert.ok(!("subject_name" in r.body.card));
    assert.ok(!("subject_phone" in r.body.card));
    assert.equal(r.body.card.attachments[0].digest, DA);
  });

  it("admin 可见全部字段原文", async () => {
    const h = await startHarness();
    await seedCase(h);
    const r = await api(h.base, "GET", "/v1/cases/case-rbac/card?role=admin");
    assert.equal(r.body.card.subject_name, "李四");
    assert.equal(r.body.card.subject_id_number, "11010119900101000X");
    assert.equal(r.body.card.internal_notes, "内部研判备注");
    assert.equal(r.body.card.attachments[0].meta.url, "https://example.test/private");
  });

  it("未知角色 403", async () => {
    const h = await startHarness();
    await seedCase(h);
    const r = await api(h.base, "GET", "/v1/cases/case-rbac/card?role=root");
    assert.equal(r.status, 403);
  });

  it("导出接口按角色投影并给出 ROLE_FIELD_DENIED 提示与逐案 denied_fields", async () => {
    const h = await startHarness();
    await seedCase(h);
    const r = await api(h.base, "POST", "/v1/export", { role: "operator" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reason_codes, ["ROLE_FIELD_DENIED"]);
    const item = r.body.exported[0];
    assert.equal(item.found, true);
    assert.ok(item.denied_fields.includes("subject_id_number"));
    assert.ok(item.denied_fields.includes("internal_notes"));
    assert.ok(!item.denied_fields.includes("priority"));
    assert.ok(!("subject_name" in item.fields));
    // internal_scan 45 + screenshot 10 + real_name_leak 30 = 85 → P0
    assert.equal(item.fields.priority, "P0");
  });

  it("导出可限定 case_ids，缺失案件标记 found=false", async () => {
    const h = await startHarness();
    await seedCase(h);
    const r = await api(h.base, "POST", "/v1/export", { role: "auditor", case_ids: ["case-rbac", "case-missing"] });
    assert.equal(r.body.exported.length, 2);
    assert.equal(r.body.exported[0].found, true);
    assert.equal(r.body.exported[1].found, false);
  });
});
