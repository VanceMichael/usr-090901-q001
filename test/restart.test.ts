import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { envelope, getJson, postJson, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await startHarness("restart");
});
after(async () => {
  await h.stop();
});

test("重启恢复：队列顺序、队列计数器、附件去重索引与清理计划在重启后不丢失", async () => {
  // 登记 3 个低分案件进 triage-low，记录各自 queue_seq
  for (let i = 0; i < 3; i++) {
    const r = await postJson(
      `${h.url}/v1/requests`,
      envelope("register_case", `case-restart-${i}`, {
        source_channel: "self_submission",
        retention_days: 30,
        attachments: [{ attachment_id: `att-${i}`, kind: "url", digest: `sha256:beef0${i}` }],
      })
    );
    assert.equal(r.status, 201);
  }
  // 一个高分案件进 triage-urgent
  await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-restart-urgent", {
      source_channel: "government_notice",
      retention_days: 30,
      risk_tags: ["minor_involved"],
    })
  );

  const before = await getJson(`${h.url}/v1/queues/triage-low?limit=10`);
  const orderBefore = before.json.items.map((i: { case_id: string }) => i.case_id);
  const seqsBefore = before.json.items.map((i: { queue_seq: number }) => i.queue_seq);
  assert.deepEqual(orderBefore, ["case-restart-0", "case-restart-1", "case-restart-2"]);

  // 重启服务进程（同一 SQLite 文件）
  await h.restart();

  // 健康检查通过且迁移幂等
  const health = await getJson(`${h.url}/healthz`);
  assert.equal(health.json.status, "ok");

  // 队列顺序一致
  const after = await getJson(`${h.url}/v1/queues/triage-low?limit=10`);
  assert.deepEqual(
    after.json.items.map((i: { case_id: string }) => i.case_id),
    orderBefore
  );
  assert.deepEqual(
    after.json.items.map((i: { queue_seq: number }) => i.queue_seq),
    seqsBefore
  );

  // 计数器持久化：重启后新案件继续在旧序号之后递增，不复用
  const add = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-restart-after", {
      source_channel: "self_submission",
      retention_days: 30,
    })
  );
  assert.equal(add.status, 201);
  assert.equal(add.json.result.queue_seq, seqsBefore[seqsBefore.length - 1] + 1);

  // 附件全局索引存活：旧 digest 仍被判为重复并指向原案件
  const dup = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-restart-dup", {
      source_channel: "self_submission",
      retention_days: 30,
      attachments: [{ attachment_id: "copy", kind: "url", digest: "sha256:beef01" }],
    })
  );
  assert.equal(dup.json.result.attachments[0].duplicate, true);
  assert.equal(dup.json.result.attachments[0].original_case_id, "case-restart-1");

  // 清理计划存活：未来时间预览能看到重启前登记的案件
  const plan = await postJson(
    `${h.url}/v1/requests`,
    envelope("preview_cleanup", "case-restart-0", { now: "2030-01-01T00:00:00Z" })
  );
  assert.ok(
    plan.json.result.due.some((d: { case_id: string }) => d.case_id === "case-restart-0")
  );

  // urgent 队列也恢复
  const urgent = await getJson(`${h.url}/v1/queues/triage-urgent?limit=10`);
  assert.ok(
    urgent.json.items.some((i: { case_id: string }) => i.case_id === "case-restart-urgent")
  );

  // 队列总览计数正确（3 个初始 + 重启后新增 + 重复摘要案，均为 self_submission 低分队列）
  const overview = await getJson(`${h.url}/v1/queues`);
  const low = overview.json.queues.find((q: { queue: string }) => q.queue === "triage-low");
  assert.equal(low.case_count, 5);
});
