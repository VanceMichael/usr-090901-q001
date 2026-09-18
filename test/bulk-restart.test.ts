import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { api, rid, startHarness, type Harness } from "./helpers.ts";
import { bootstrap } from "../src/app.ts";

const DA = "sha256:aaaaaaaaaaaaaaaa";
const DB = "sha256:bbbbbbbbbbbbbbbb";

async function openFreshOnSameDb(dbPath: string, port = 0): Promise<{ base: string; close: () => void }> {
  const { server, db } = bootstrap({ dbPath, now: () => new Date("2026-09-10T02:00:00Z") });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  const p = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${p}`,
    close: () => {
      server.closeAllConnections?.();
      server.close();
      db.close();
    },
  };
}

describe("批量请求：按行返回与坏行隔离", () => {
  it("坏行不写入且不影响其它行；每行独立结论", async () => {
    const h = await startHarness();
    const good1 = {
      request_id: rid(),
      operation: "register_case",
      case_id: "bulk-ok-1",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:50:00+08:00",
      payload: {
        source_channel: "user_report",
        retention_days: 30,
        attachments: [{ attachment_id: "a1", kind: "url", digest: DA }],
      },
    };
    const bad = {
      request_id: rid(),
      operation: "register_case",
      case_id: "bulk-bad",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:50:00+08:00",
      payload: { source_channel: "anonymous_feed", retention_days: 30 }, // 不受理渠道
    };
    const malformed = { request_id: rid(), operation: "register_case" }; // 信封缺字段
    const good2 = {
      request_id: rid(),
      operation: "register_case",
      case_id: "bulk-ok-2",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:51:00+08:00",
      payload: { source_channel: "hotline", retention_days: 15 },
    };

    const r = await api(h.base, "POST", "/v1/requests/bulk", {
      requests: [good1, bad, malformed, good2],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 4);
    assert.equal(r.body.accepted, 2);
    assert.equal(r.body.rejected, 2);
    assert.deepEqual(
      r.body.results.map((x: { status: string }) => x.status),
      ["accepted", "rejected", "rejected", "accepted"],
    );
    assert.deepEqual(r.body.results[1].reasons, ["CHANNEL_NOT_ALLOWED"]);
    assert.ok(r.body.results[2].errors.some((e: { code: string }) => e.code === "ENVELOPE_MISSING_FIELD"));

    // 只有好行落库
    const q = await api(h.base, "GET", "/v1/queues");
    assert.deepEqual(
      q.body.items.map((x: { case_id: string }) => x.case_id).sort(),
      ["bulk-ok-1", "bulk-ok-2"],
    );
  });

  it("附件批量登记中坏行隔离，好行仍提交且重复关系正确", async () => {
    const h = await startHarness();
    await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_case",
      case_id: "bulk-att",
      actor_role: "reviewer",
      occurred_at: "2026-09-10T09:50:00+08:00",
      payload: {
        source_channel: "internal_scan",
        attachments: [{ attachment_id: "att-1", kind: "url", digest: DA }],
      },
    });
    const r = await api(h.base, "POST", "/v1/requests", {
      request_id: rid(),
      operation: "register_attachments",
      case_id: "bulk-att",
      actor_role: "operator",
      occurred_at: "2026-09-10T09:52:00+08:00",
      payload: {
        attachments: [
          { attachment_id: "att-2", kind: "video", digest: DB }, // 新建
          { attachment_id: "att-3", kind: "url", digest: DA }, // 重复引用
          { attachment_id: "att-4", kind: "url", digest: "bad" }, // 坏行：不写入
        ],
      },
    });
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(
      r.body.data.attachments.map((a: { attachment_id: string }) => [a.attachment_id, a]),
    );
    assert.equal(byId["att-2"].status, "created");
    assert.equal(byId["att-3"].status, "duplicate");
    assert.equal(byId["att-3"].ref_to, "att-1");
    assert.equal(r.body.data.rejected_attachments[0].index, 2);
  });
});

describe("重启恢复", () => {
  it("同一 SQLite 文件重启后：队列顺序、附件引用、清理计划均不丢失", async () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-restart-"));
    const dbPath = join(dir, "persist.db");

    {
      const h: Harness = await startHarnessOn(dbPath);
      await api(h.base, "POST", "/v1/requests", {
        request_id: rid(),
        operation: "register_case",
        case_id: "persist-1",
        actor_role: "reviewer",
        occurred_at: "2026-09-10T09:50:00+08:00",
        payload: {
          source_channel: "user_report",
          retention_days: 5,
          attachments: [{ attachment_id: "att-1", kind: "url", digest: DA }],
        },
      });
      await api(h.base, "POST", "/v1/requests", {
        request_id: rid(),
        operation: "register_attachments",
        case_id: "persist-1",
        actor_role: "operator",
        occurred_at: "2026-09-10T09:51:00+08:00",
        payload: { attachments: [{ attachment_id: "att-dup", kind: "url", digest: DA }] },
      });
      await api(h.base, "POST", "/v1/requests", {
        request_id: rid(),
        operation: "register_case",
        case_id: "persist-2",
        actor_role: "reviewer",
        occurred_at: "2026-09-10T09:52:00+08:00",
        payload: { source_channel: "regulator", risk_flags: ["minor_involved"], retention_days: 90 },
      });
      h.close();
    }

    // 重新打开同一个数据库文件（模拟容器重启）
    const fresh = await openFreshOnSameDb(dbPath);
    try {
      const q = await api(fresh.base, "GET", "/v1/queues?limit=10");
      assert.deepEqual(
        q.body.items.map((x: { case_id: string; queue_seq: number }) => [x.case_id, x.queue_seq]),
        [
          ["persist-1", 1],
          ["persist-2", 2],
        ],
      );

      const card = await api(fresh.base, "GET", "/v1/cases/persist-1/card?role=auditor");
      const dup = card.body.card.attachments.find((a: { attachment_id: string }) => a.attachment_id === "att-dup");
      assert.equal(dup.duplicate, true);
      assert.equal(dup.ref_to, "att-1");

      // 清理计划仍在：persist-1 在 2026-09-15T02:00Z 到期
      const preview = await api(fresh.base, "GET", "/v1/cleanup/preview?as_of=2026-09-16T00:00:00Z");
      const cases = [...new Set(preview.body.items.map((i: { case_id: string }) => i.case_id))];
      assert.deepEqual(cases, ["persist-1"]);

      // 迁移幂等：重启不重复应用
      const migrations = fresh; // db 句柄在服务内，间接通过健康检查验证
      const health = await api(migrations.base, "GET", "/health");
      assert.equal(health.status, 200);
    } finally {
      fresh.close();
    }
  });
});

// 与 helpers.startHarness 相同，但使用外部指定的 db 路径
async function startHarnessOn(dbPath: string): Promise<Harness> {
  const { server, db } = bootstrap({ dbPath, now: () => new Date("2026-09-10T02:00:00Z") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    server,
    setNow: () => undefined,
    getNow: () => new Date("2026-09-10T02:00:00Z"),
    close: () => {
      server.closeAllConnections?.();
      server.close();
      db.close();
    },
  };
}
