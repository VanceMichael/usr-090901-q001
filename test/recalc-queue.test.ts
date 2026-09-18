import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { api, envelope, rid, startHarness } from "./helpers.ts";

const DA = "sha256:aaaaaaaaaaaaaaaa";
const DB = "sha256:bbbbbbbbbbbbbbbb";
const DC = "sha256:cccccccccccccccc";

async function registerCase(
  h: { base: string },
  caseId: string,
  payloadOver: Record<string, unknown> = {},
) {
  const body = envelope({ attachments: [{ attachment_id: "a1", kind: "url", digest: DA }], ...payloadOver });
  return api(h.base, "POST", "/v1/requests", { ...body, request_id: rid(), case_id: caseId });
}

describe("风险重算", () => {
  it("新增风险标记后优先级与队列提升，原因码 PRIORITY_RECALCULATED", async () => {
    const h = await startHarness();
    // user_report 20 + url 5 = 25 → P3
    const reg = await registerCase(h, "case-rc-1");
    assert.equal(reg.body.data.priority, "P3");

    const rc = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "recalculate",
      case_id: "case-rc-1",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:57:00+08:00",
      payload: { risk_flags: ["coordinated", "real_name_leak"] }, // +25 +30 = 80 → P0
    });
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    assert.equal(rc.body.data.changed, true);
    assert.equal(rc.body.data.before.priority, "P3");
    assert.equal(rc.body.data.after.priority, "P0");
    assert.equal(rc.body.data.after.queue, "q_critical");
    assert.ok(rc.body.reasons.includes("PRIORITY_RECALCULATED"));

    const card = await api(h.base, "GET", "/v1/cases/case-rc-1/card?role=reviewer");
    assert.equal(card.body.card.priority, "P0");
    assert.deepEqual(card.body.card.risk_flags, ["coordinated", "real_name_leak"]);
  });

  it("重算保留期会重建到期时间与清理计划", async () => {
    const h = await startHarness();
    await registerCase(h, "case-rc-2", { retention_days: 10 });
    const before = await api(h.base, "GET", "/v1/cleanup/preview?case_id=case-rc-2&as_of=2099-01-01T00:00:00Z");
    assert.ok(before.body.items.length > 0);

    const rc = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "recalculate",
      case_id: "case-rc-2",
      actor_role: "admin",
      occurred_at: "2026-09-10T09:58:00+08:00",
      payload: { retention_days: 120 },
    });
    assert.equal(rc.status, 200);
    // registered_at=2026-09-10T02:00Z + 120d
    assert.equal(rc.body.data.after.expires_at, "2027-01-08T02:00:00Z");

    // 旧的 10 天到期计划已取消：以第 11 天视角预览不应出现
    const early = await api(h.base, "GET", "/v1/cleanup/preview?case_id=case-rc-2&as_of=2026-09-25T00:00:00Z");
    assert.equal(early.body.items.length, 0);
  });

  it("operator 无权重算", async () => {
    const h = await startHarness();
    await registerCase(h, "case-rc-3");
    const r = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "recalculate",
      case_id: "case-rc-3",
      actor_role: "operator",
      occurred_at: "2026-09-10T09:58:00+08:00",
      payload: {},
    });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.reasons, ["ROLE_FIELD_DENIED"]);
  });
});

describe("队列分页与顺序", () => {
  it("按登记序号稳定排序，游标分页不重不漏", async () => {
    const h = await startHarness();
    for (let i = 1; i <= 5; i++) {
      const r = await registerCase(h, `case-page-${i}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const p1 = await api(h.base, "GET", "/v1/queues?limit=2");
    assert.equal(p1.body.items.length, 2);
    assert.equal(p1.body.items[0].case_id, "case-page-1");
    assert.equal(p1.body.next_cursor, 2);

    const p2 = await api(h.base, "GET", `/v1/queues?limit=2&cursor=${p1.body.next_cursor}`);
    assert.equal(p2.body.items.map((x: { case_id: string }) => x.case_id).join(","), "case-page-3,case-page-4");

    const p3 = await api(h.base, "GET", `/v1/queues?limit=2&cursor=${p2.body.next_cursor}`);
    assert.equal(p3.body.items.length, 1);
    assert.equal(p3.body.next_cursor, null);
  });

  it("可按队列名过滤", async () => {
    const h = await startHarness();
    await registerCase(h, "case-q-low"); // P3
    const high = await api(h.base, "POST", "/v1/requests", {
      ...envelope({
        case_id: "case-q-high",
        source_channel: "regulator",
        risk_flags: ["minor_involved"],
      }),
      request_id: rid(),
    });
    assert.equal(high.body.data.queue, "q_critical");
    const q = await api(h.base, "GET", "/v1/queues?queue=q_critical");
    assert.deepEqual(q.body.items.map((x: { case_id: string }) => x.case_id), ["case-q-high"]);
  });
});
