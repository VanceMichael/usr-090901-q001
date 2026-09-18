import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, envelope, rid, startHarness } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sampleRequests = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "sample-requests.json"), "utf8"),
) as Record<string, unknown>[];

const DIGEST_A = "sha256:aaaaaaaaaaaaaaaa";
const DIGEST_B = "sha256:bbbbbbbbbbbbbbbb";
const DIGEST_C = "sha256:cccccccccccccccc";

describe("登记：信封、渠道、时间窗、保留期", () => {
  it("健康检查返回策略版本", async () => {
    const h = await startHarness();
    const r = await api(h.base, "GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ok");
    assert.match(r.body.policy_version, /2026/);
  });

  it("受理合法举报并返回优先级与队列", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-ok-1" }),
      request_id: rid(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "accepted");
    // user_report 20 + url 5 = 25 → P3 / q_review
    assert.equal(r.body.data.priority, "P3");
    assert.equal(r.body.data.queue, "q_review");
  });

  it("拒绝未受理来源渠道 anonymous_feed", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-bad-channel", source_channel: "anonymous_feed" }),
      request_id: rid(),
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.status, "rejected");
    assert.deepEqual(r.body.reasons, ["CHANNEL_NOT_ALLOWED"]);
  });

  it("拒绝未知渠道", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-unknown-channel", source_channel: "totally_unknown" }),
      request_id: rid(),
    });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some((e: { code: string }) => e.code === "UNKNOWN_CHANNEL"));
  });

  it("拒绝超出受理时间窗的 occurred_at（8 天前）", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-old" }),
      request_id: rid(),
      occurred_at: "2026-09-01T00:00:00Z",
    });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some((e: { code: string }) => e.code === "TIME_OUT_OF_WINDOW"));
  });

  it("拒绝超过时钟偏差的未来 occurred_at", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-future" }),
      request_id: rid(),
      occurred_at: "2026-09-10T03:00:00Z",
    });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some((e: { code: string }) => e.code === "TIME_IN_FUTURE"));
  });

  it("拒绝非 ISO8601 时间戳", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-bad-ts" }),
      request_id: rid(),
      occurred_at: "2026/09/10 10:00",
    });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some((e: { code: string }) => e.code === "BAD_TIMESTAMP"));
  });

  it("拒绝越界保留天数（0 天与 400 天）", async () => {
    const h = await startHarness();
    for (const days of [0, 400]) {
      const r = await api(h.base, "POST", "/v1/requests", {
        ...envelope({ case_id: `case-ret-${days}`, retention_days: days }),
        request_id: rid(),
      });
      assert.equal(r.status, 422, `days=${days}`);
      assert.ok(r.body.errors.some((e: { code: string }) => e.code === "RETENTION_OUT_OF_RANGE"));
    }
  });

  it("缺省保留天数按渠道默认（regulator=90）", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_case",
      case_id: "case-regulator",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:55:00+08:00",
      payload: {
        source_channel: "regulator",
        risk_flags: ["minor_involved"],
        attachments: [{ attachment_id: "a1", kind: "url", digest: DIGEST_A }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.retention_days, 90);
    // 55 + 40 + 5 = 100 → P0
    assert.equal(r.body.data.priority, "P0");
    assert.equal(r.body.data.queue, "q_critical");
  });

  it("重复 case_id 被拒绝且不覆盖原案", async () => {
    const h = await startHarness();
    const first = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-dup", source_channel: "user_report" }),
      request_id: rid(),
    });
    assert.equal(first.status, 200);
    const again = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-dup", source_channel: "regulator" }),
      request_id: rid(),
    });
    assert.equal(again.status, 422);
    assert.deepEqual(again.body.reasons, ["CASE_ALREADY_EXISTS"]);
    const card = await api(h.base, "GET", "/v1/cases/case-dup/card?role=admin");
    assert.equal(card.body.card.source_channel, "user_report");
  });

  it("重复 request_id 幂等拒绝", async () => {
    const h = await startHarness();
    const body = { ...envelope({ case_id: "case-idem" }), request_id: "fixed-req-1" };
    const r1 = await api(h.base, "POST", "/v1/requests", body);
    assert.equal(r1.status, 200);
    const r2 = await api(h.base, "POST", "/v1/requests", body);
    assert.equal(r2.status, 422);
    assert.deepEqual(r2.body.reasons, ["REQUEST_DUPLICATE"]);
  });

  it("无权角色执行登记被拒绝（不接入身份服务）", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-role-deny" }),
      request_id: rid(),
      actor_role: "operator",
    });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.reasons, ["ROLE_FIELD_DENIED"]);
  });

  it("仓库脱敏样例 fixtures/sample-requests.json 可直接登记", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", sampleRequests[0]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.case_id, "case-7");
    assert.equal(r.body.data.attachments[0].attachment_id, "att-1");
  });

  it("信封出现未声明字段被拒绝（契约 additionalProperties:false）", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      ...envelope({ case_id: "case-extra" }),
      request_id: rid(),
      unexpected: "x",
    });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some((e: { code: string }) => e.code === "ENVELOPE_EXTRA_FIELD"));
  });
});

describe("登记：附件引用与去重", () => {
  it("单案登记时附件坏行导致整案拒绝（全有或全无）", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_case",
      case_id: "case-att-bad",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:55:00+08:00",
      payload: {
        source_channel: "user_report",
        retention_days: 30,
        attachments: [
          { attachment_id: "a1", kind: "url", digest: DIGEST_A },
          { attachment_id: "a2", kind: "exe", digest: DIGEST_B }, // 非法 kind
        ],
      },
    });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.reasons, ["ATTACHMENTS_REJECTED"]);
    const q = await api(h.base, "GET", "/v1/queues");
    assert.equal(q.body.items.length, 0);
  });

  it("重复摘要只保留一份并返回引用关系（跨批次）", async () => {
    const h = await startHarness();
    const reg = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_case",
      case_id: "case-dedup",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:55:00+08:00",
      payload: {
        source_channel: "internal_scan",
        retention_days: 60,
        subject_name: "张三",
        attachments: [
          { attachment_id: "att-1", kind: "url", digest: DIGEST_A, url: "https://example.test/p1" },
          { attachment_id: "att-2", kind: "screenshot", digest: DIGEST_B },
        ],
      },
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.deepEqual(
      reg.body.data.attachments.map((a: { status: string }) => a.status),
      ["created", "created"],
    );

    const add = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_attachments",
      case_id: "case-dedup",
      actor_role: "operator",
      occurred_at: "2026-09-10T09:56:00+08:00",
      payload: {
        attachments: [
          { attachment_id: "att-3", kind: "url", digest: DIGEST_A }, // 与 att-1 同摘要
          { attachment_id: "att-4", kind: "video", digest: DIGEST_C }, // 全新
          { attachment_id: "att-5", kind: "screenshot", digest: DIGEST_B }, // 与 att-2 同摘要
          { attachment_id: "att-6", kind: "url", digest: "not-a-digest" }, // 坏行：不写入
        ],
      },
    });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const byId = Object.fromEntries(
      add.body.data.attachments.map((a: { attachment_id: string }) => [a.attachment_id, a]),
    );
    assert.equal(byId["att-3"].status, "duplicate");
    assert.equal(byId["att-3"].ref_to, "att-1");
    assert.equal(byId["att-5"].status, "duplicate");
    assert.equal(byId["att-5"].ref_to, "att-2");
    assert.equal(byId["att-4"].status, "created");
    assert.equal(add.body.data.rejected_attachments.length, 1);
    assert.equal(add.body.data.rejected_attachments[0].index, 3);
    assert.ok(add.body.reasons.includes("DUPLICATE_ATTACHMENT"));

    // 规范附件仍只有 3 份；引用关系 2 条
    const canonical = h.db.prepare("SELECT COUNT(*) AS c FROM attachments WHERE case_id='case-dedup'").get() as { c: number };
    assert.equal(canonical.c, 3);
    const refs = h.db.prepare("SELECT submitted_attachment_id, canonical_attachment_id FROM attachment_refs WHERE case_id='case-dedup' ORDER BY id").all() as {
      submitted_attachment_id: string;
      canonical_attachment_id: string;
    }[];
    assert.deepEqual(
      refs.map((r) => [r.submitted_attachment_id, r.canonical_attachment_id]),
      [
        ["att-3", "att-1"],
        ["att-5", "att-2"],
      ],
    );

    // 卡片中重复附件以 duplicate/ref_to 表示
    const card = await api(h.base, "GET", "/v1/cases/case-dedup/card?role=auditor");
    const duplicates = card.body.card.attachments.filter((a: { duplicate: boolean }) => a.duplicate);
    assert.equal(duplicates.length, 2);
    assert.equal(duplicates.find((a: { attachment_id: string }) => a.attachment_id === "att-3").ref_to, "att-1");
  });

  it("批次内自相重复的 attachment_id 被判坏行", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_case",
      case_id: "case-selfdup",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:55:00+08:00",
      payload: {
        source_channel: "user_report",
        attachments: [
          { attachment_id: "same", kind: "url", digest: DIGEST_A },
          { attachment_id: "same", kind: "url", digest: DIGEST_C },
        ],
      },
    });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some((e: { code: string }) => e.code === "ATTACHMENT_ID_DUPLICATE_IN_BATCH"));
  });

  it("附件登记到不存在的案件返回 CASE_NOT_FOUND", async () => {
    const h = await startHarness();
    const r = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_attachments",
      case_id: "case-ghost",
      actor_role: "operator",
      occurred_at: "2026-09-10T09:55:00+08:00",
      payload: { attachments: [{ attachment_id: "a1", kind: "url", digest: DIGEST_A }] },
    });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.reasons, ["CASE_NOT_FOUND"]);
  });
});
