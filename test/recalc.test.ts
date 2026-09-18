import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { envelope, getJson, postJson, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await startHarness("recalc");
});
after(async () => {
  await h.stop();
});

async function registerCase(caseId: string, payload: Record<string, unknown> = {}) {
  const res = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", caseId, {
      source_channel: "self_submission", // base 15 -> low
      retention_days: 30,
      ...payload,
    })
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

test("优先级重算：新增高危标签后分数与队列迁移，带 previous 对比与原因码", async () => {
  await registerCase("case-rc-1");
  const before = await getJson(`${h.url}/v1/cases/case-rc-1?role=admin`);
  assert.equal(before.json.card.priority_level, "low");
  assert.equal(before.json.card.queue, "triage-low");

  const recalc = await postJson(
    `${h.url}/v1/requests`,
    envelope("recalculate_risk", "case-rc-1", {
      risk_tags: ["minor_involved", "ongoing_harassment", "credible_threat"],
    })
  );
  assert.equal(recalc.status, 200);
  const r = recalc.json.result;
  assert.equal(r.reason, "PRIORITY_RECALCULATED");
  assert.equal(r.changed, true);
  assert.equal(r.previous.priority_level, "low");
  assert.equal(r.priority_level, "critical"); // 15+35+25+20=95 -> cap 100 band
  assert.equal(r.queue, "triage-urgent");
  assert.ok(r.queue_seq >= 1);

  const after = await getJson(`${h.url}/v1/cases/case-rc-1?role=admin`);
  assert.equal(after.json.card.queue, "triage-urgent");
  assert.equal(after.json.card.priority_score, 95);
});

test("重算无变化：相同标签返回 changed=false", async () => {
  await registerCase("case-rc-2", { risk_tags: ["repeat_offender"] });
  const again = await postJson(
    `${h.url}/v1/requests`,
    envelope("recalculate_risk", "case-rc-2", { risk_tags: ["repeat_offender"] })
  );
  assert.equal(again.status, 200);
  assert.equal(again.json.result.changed, false);
});

test("未知风险标签拒绝（400 INVALID_RISK_TAG）", async () => {
  await registerCase("case-rc-3");
  const res = await postJson(
    `${h.url}/v1/requests`,
    envelope("recalculate_risk", "case-rc-3", { risk_tags: ["nuclear_launch_codes"] })
  );
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "INVALID_RISK_TAG");
});

test("队列分页：FIFO 顺序稳定，cursor 翻页无重复无遗漏", async () => {
  // 连续登记 5 个 self_submission（无标签无附件）-> 全部 triage-low，按 queue_seq 升序
  const seqs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const reg = await registerCase(`case-page-${i}`);
    seqs.push(reg.result.queue_seq);
  }
  const startCursor = seqs[0]! - 1;

  const page1 = await getJson(`${h.url}/v1/queues/triage-low?limit=2&cursor=${startCursor}`);
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.has_more, true);
  assert.ok(page1.json.next_cursor);
  const seqs1 = page1.json.items.map((i: { case_id: string }) => i.case_id);
  assert.deepEqual(seqs1, ["case-page-0", "case-page-1"]);

  const page2 = await getJson(`${h.url}/v1/queues/triage-low?limit=2&cursor=${page1.json.next_cursor}`);
  assert.deepEqual(
    page2.json.items.map((i: { case_id: string }) => i.case_id),
    ["case-page-2", "case-page-3"]
  );
  assert.equal(page2.json.has_more, true);

  const page3 = await getJson(`${h.url}/v1/queues/triage-low?limit=2&cursor=${page2.json.next_cursor}`);
  assert.deepEqual(
    page3.json.items.map((i: { case_id: string }) => i.case_id),
    ["case-page-4"]
  );
  assert.equal(page3.json.has_more, false);
  assert.equal(page3.json.next_cursor, null);
});

test("队列迁移后旧队列不再包含该案件", async () => {
  await registerCase("case-move-1");
  await postJson(
    `${h.url}/v1/requests`,
    envelope("recalculate_risk", "case-move-1", {
      risk_tags: ["minor_involved", "self_harm_risk", "ongoing_harassment"],
    })
  );
  const low = await getJson(`${h.url}/v1/queues/triage-low`);
  assert.ok(!low.json.items.some((i: { case_id: string }) => i.case_id === "case-move-1"));
  const urgent = await getJson(`${h.url}/v1/queues/triage-urgent`);
  assert.ok(urgent.json.items.some((i: { case_id: string }) => i.case_id === "case-move-1"));
});
