import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { envelope, getJson, postJson, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await startHarness("roles");
});
after(async () => {
  await h.stop();
});

const SENSITIVE = [
  "reporter_contact",
  "subject_real_name",
  "subject_id_number",
  "subject_address",
  "evidence_urls",
  "internal_note",
];

async function registerFullCase(caseId: string) {
  const res = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", caseId, {
      source_channel: "government_notice",
      retention_days: 30,
      risk_tags: ["credible_threat"],
      attachments: [{ attachment_id: "a1", kind: "screenshot", digest: "sha256:0fface99" }],
      summary: "开盒信息在群组内传播",
      reporter_contact: "alice@example.test",
      subject_real_name: "王五",
      subject_id_number: "11010120000101002X",
      subject_address: "某市某街道",
      evidence_urls: ["https://evidence.test/1", "https://evidence.test/2"],
      internal_note: "敏感内部研判",
    })
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
}

test("triager 处理卡片：仅白名单字段，敏感字段全部脱敏（不出现）", async () => {
  await registerFullCase("case-role-1");
  const card = await getJson(`${h.url}/v1/cases/case-role-1?role=triager`);
  assert.equal(card.status, 200);
  const keys = Object.keys(card.json.card);
  for (const f of SENSITIVE) assert.ok(!keys.includes(f), `triager 不应看到 ${f}`);
  assert.equal(keys.includes("summary"), false);
  assert.equal(card.json.card.priority_level, "critical"); // 80+20+16=116 cap 100
  assert.equal(card.json.card.attachment_count, 1);
});

test("analyst 可看卡片含 summary 与 attachment_refs，但不含个人敏感字段", async () => {
  const card = await getJson(`${h.url}/v1/cases/case-role-1?role=analyst`);
  assert.equal(card.json.card.summary, "开盒信息在群组内传播");
  assert.ok(Array.isArray(card.json.card.attachment_refs));
  for (const f of ["reporter_contact", "subject_id_number", "subject_address"]) {
    assert.ok(!Object.keys(card.json.card).includes(f));
  }
});

test("reviewer 可见联系/真实姓名/地址/证据，不可见证件号；显式导出时进 denied_fields", async () => {
  const card = await getJson(`${h.url}/v1/cases/case-role-1?role=reviewer`);
  assert.equal(card.json.card.reporter_contact, "alice@example.test");
  assert.equal(card.json.card.subject_real_name, "王五");
  assert.deepEqual(card.json.card.evidence_urls, [
    "https://evidence.test/1",
    "https://evidence.test/2",
  ]);
  assert.ok(!Object.keys(card.json.card).includes("subject_id_number"));

  const exp = await postJson(
    `${h.url}/v1/requests`,
    envelope("export_fields", "case-role-1", {
      role: "reviewer",
      fields: ["case_id", "subject_id_number", "reporter_contact"],
    })
  );
  assert.equal(exp.status, 200);
  assert.equal(exp.json.result.records[0].fields.subject_id_number, undefined);
  assert.deepEqual(exp.json.result.denied_fields, ["subject_id_number"]);
});

test("auditor 可见证件号与清理事件，但不可见联系方式/内部备注", async () => {
  const exp = await postJson(
    `${h.url}/v1/requests`,
    envelope("export_fields", "case-role-1", {
      role: "auditor",
      fields: ["case_id", "subject_id_number", "reporter_contact", "internal_note", "cleanup_events"],
    })
  );
  assert.equal(exp.json.result.records[0].fields.subject_id_number, "11010120000101002X");
  assert.deepEqual(exp.json.result.denied_fields.sort(), ["internal_note", "reporter_contact"]);
});

test("admin 可见全部字段", async () => {
  const card = await getJson(`${h.url}/v1/cases/case-role-1?role=admin`);
  assert.equal(card.json.card.subject_id_number, "11010120000101002X");
  assert.equal(card.json.card.internal_note, "敏感内部研判");
});

test("未知角色导出被拒（403 ROLE_FIELD_DENIED），未知卡片角色同样拒绝", async () => {
  const exp = await postJson(
    `${h.url}/v1/requests`,
    envelope("export_fields", "case-role-1", { role: "guest", fields: ["case_id"] })
  );
  assert.equal(exp.status, 403);
  assert.equal(exp.json.error.code, "ROLE_FIELD_DENIED");

  const card = await getJson(`${h.url}/v1/cases/case-role-1?role=guest`);
  assert.equal(card.status, 403);
});
