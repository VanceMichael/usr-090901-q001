import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { envelope, getJson, nowIso, postJson, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await startHarness("cleanup");
});
after(async () => {
  await h.stop();
});

test("清理计划预览：到期案件列出待清除敏感字段，未到期不出现", async () => {
  // retention 1 天，仍未到期
  const reg = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-clean-1", {
      source_channel: "self_submission",
      retention_days: 1,
      reporter_contact: "110",
      subject_real_name: "李四",
      evidence_urls: ["http://evidence/1"],
    })
  );
  assert.equal(reg.status, 201);

  const now = await postJson(
    `${h.url}/v1/requests`,
    envelope("preview_cleanup", "case-clean-1", {})
  );
  assert.equal(now.json.result.due.length, 0);

  const future = await postJson(
    `${h.url}/v1/requests`,
    envelope("preview_cleanup", "case-clean-1", { now: "2030-01-01T00:00:00Z" })
  );
  assert.equal(future.status, 200);
  const item = future.json.result.due.find((d: { case_id: string }) => d.case_id === "case-clean-1");
  assert.ok(item);
  assert.deepEqual(item.purgable_fields.sort(), [
    "evidence_urls",
    "reporter_contact",
    "subject_real_name",
  ]);
});

test("执行到期清理：敏感字段置空、写入清理事件、计划行删除（可被角色导出验证）", async () => {
  await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-clean-2", {
      source_channel: "self_submission",
      retention_days: 1,
      reporter_contact: "120",
      subject_id_number: "11010119900101001X",
      subject_address: "某小区",
      internal_note: "内部备注",
    })
  );

  const run = await postJson(
    `${h.url}/v1/requests`,
    envelope("run_cleanup", "case-clean-2", { now: "2030-01-02T00:00:00Z" })
  );
  assert.equal(run.status, 200);
  const done = run.json.result.executed.find((e: { case_id: string }) => e.case_id === "case-clean-2");
  assert.ok(done);
  assert.deepEqual(done.purged_fields.sort(), [
    "internal_note",
    "reporter_contact",
    "subject_address",
    "subject_id_number",
  ]);

  // admin 全字段视图：敏感字段已清空，purged_at 已写入
  const card = await getJson(`${h.url}/v1/cases/case-clean-2?role=admin`);
  assert.equal(card.json.card.reporter_contact, null);
  assert.equal(card.json.card.subject_id_number, null);
  assert.equal(card.json.card.internal_note, null);
  assert.equal(card.json.card.purge_status, "purged");
  assert.ok(card.json.card.purged_at);

  // auditor 可见清理事件轨迹
  const aud = await postJson(
    `${h.url}/v1/requests`,
    envelope("export_fields", "case-clean-2", {
      role: "auditor",
      fields: ["case_id", "cleanup_events"],
    })
  );
  assert.equal(aud.status, 200);
  const ev = aud.json.result.records[0].fields.cleanup_events;
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].purged_fields.sort(), [
    "internal_note",
    "reporter_contact",
    "subject_address",
    "subject_id_number",
  ]);

  // 重复执行幂等：已清理案件不再出现
  const again = await postJson(
    `${h.url}/v1/requests`,
    envelope("run_cleanup", "case-clean-2", { now: "2030-01-03T00:00:00Z" })
  );
  assert.equal(again.json.result.executed_count, 0);
  void nowIso;
});

test("execute=false 等价于预览，不写库", async () => {
  await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-clean-3", {
      source_channel: "self_submission",
      retention_days: 1,
      reporter_contact: "119",
    })
  );
  const dry = await postJson(
    `${h.url}/v1/requests`,
    envelope("run_cleanup", "case-clean-3", { now: "2030-01-02T00:00:00Z", execute: false })
  );
  assert.ok(dry.json.result.due);
  const card = await getJson(`${h.url}/v1/cases/case-clean-3?role=admin`);
  assert.equal(card.json.card.reporter_contact, "119"); // 未被清除
});
