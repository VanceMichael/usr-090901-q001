import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { envelope, getJson, postJson, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await startHarness("batch-restart");
});
after(async () => {
  await h.stop();
});

test("附件批量登记：逐行返回，坏行隔离不写入，合法行生效并重算优先级", async () => {
  // 先建低分案件
  await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-batch-1", {
      source_channel: "self_submission",
      retention_days: 30,
    })
  );

  const res = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_attachments", "case-batch-1", {
      attachments: [
        { attachment_id: "ok-1", kind: "video", digest: "sha256:aaaa01" },
        { attachment_id: "ok-2", kind: "document", digest: "sha256:aaaa02" },
        { attachment_id: "bad-digest", kind: "url", digest: "sha1:nope" }, // 坏行
        { attachment_id: "bad-kind", kind: "exe", digest: "sha256:aaaa03" }, // 坏行
        { attachment_id: "ok-1", kind: "url", digest: "sha256:aaaa04" }, // 行内 ID 重复 -> 坏行
        { attachment_id: "ok-3", kind: "url", digest: "sha256:aaaa01" }, // 合法：跨请求重复摘要
        "not-an-object", // 结构性坏行
      ],
    })
  );
  assert.equal(res.status, 200);
  const r = res.json.result;
  assert.equal(r.accepted, 3);
  assert.equal(r.rejected, 4);

  const goodById = Object.fromEntries(
    r.rows.filter((x: { ok: boolean }) => x.ok).map((x: { attachment_id: string }) => [x.attachment_id, x])
  );
  assert.equal(goodById["ok-1"].ok, true);
  assert.equal(goodById["ok-2"].ok, true);
  assert.equal(goodById["ok-3"].ok, true);
  assert.equal(goodById["ok-3"].duplicate, true);
  assert.equal(goodById["ok-3"].original_attachment_id, "ok-1"); // 同案首次引用行
  const dupInline = r.rows.find(
    (x: { error_code?: string }) => x.error_code === "DUPLICATE_INLINE_ATTACHMENT_ID"
  );
  assert.ok(dupInline, "行内 ID 重复必须作为坏行返回");
  const badDigest = r.rows.find(
    (x: { attachment_id?: string }) => x.attachment_id === "bad-digest"
  );
  assert.equal(badDigest.ok, false);
  assert.equal(badDigest.error_code, "INVALID_ATTACHMENT_DIGEST");
  const badKind = r.rows.find(
    (x: { attachment_id?: string }) => x.attachment_id === "bad-kind"
  );
  assert.equal(badKind.error_code, "INVALID_ATTACHMENT_KIND");

  // 坏行 digest 未写入：尝试把 aaaa03 当“新”附件登记应是非重复
  const probe = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_attachments", "case-batch-1", {
      attachments: [{ attachment_id: "probe", kind: "url", digest: "sha256:aaaa03" }],
    })
  );
  assert.equal(probe.json.result.rows[0].duplicate, false);

  // 附件增加触发了重算（结果中带 risk）
  assert.ok(r.risk.priority_score >= 0);
});

test("信封级批量：逐行返回结果，单行坏不影响其他行写入", async () => {
  const res = await postJson(`${h.url}/v1/requests/batch`, [
    envelope("register_case", "case-envbatch-1", {
      source_channel: "self_submission",
      retention_days: 30,
    }),
    { operation: "register_case", payload: {} }, // 信封缺字段 -> 坏行
    envelope("register_case", "case-envbatch-2", {
      source_channel: "user_report",
      retention_days: 30,
    }),
    envelope("register_case", "case-envbatch-1", {
      source_channel: "user_report",
      retention_days: 30,
    }), // 重复案件 -> 坏行（409）
  ]);
  assert.equal(res.status, 200);
  assert.equal(res.json.accepted, 2);
  assert.equal(res.json.rejected, 2);
  const statuses = res.json.results.map((x: { status: number }) => x.status);
  assert.deepEqual(statuses, [201, 400, 201, 409]);

  // 两个合法案件确实存在，坏行没有产生案件
  const c1 = await getJson(`${h.url}/v1/cases/case-envbatch-1?role=admin`);
  const c2 = await getJson(`${h.url}/v1/cases/case-envbatch-2?role=admin`);
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);
});

test("事务回滚：清理执行中途失败时敏感字段不得被清除", async () => {
  // 建两个 1 天保留期、带敏感字段的案件，用未来时间一次性清理
  for (const id of ["case-rollback-1", "case-rollback-2"]) {
    const r = await postJson(
      `${h.url}/v1/requests`,
      envelope("register_case", id, {
        source_channel: "self_submission",
        retention_days: 1,
        reporter_contact: "SECRET-555",
      })
    );
    assert.equal(r.status, 201);
  }

  // 直接在 SQLite 上安装持久触发器（对服务进程连接同样可见）：
  // 对第二个案件的清除 UPDATE 抛错，迫使 run_cleanup 事务在处理中途失败并整体回滚
  const db = new DatabaseSync(h.dbPath, { enableDoubleQuotedStringLiterals: true });
  db.exec("PRAGMA busy_timeout=5000");
  try {
    db.exec(`
      CREATE TRIGGER fail_second_purge
      BEFORE UPDATE OF reporter_contact ON cases
      WHEN NEW.case_id = 'case-rollback-2' AND NEW.reporter_contact IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected purge failure');
      END`);

    const run = await postJson(
      `${h.url}/v1/requests`,
      envelope("run_cleanup", "case-rollback-1", { now: "2030-01-02T00:00:00Z" })
    );
    // 两个案件都到期（dueCases 按到期时间排序，两个都在窗口内）
    assert.equal(run.status, 500);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_second_purge");
    db.close();
  }

  // 回滚后：两个案件的敏感字段都还在，清理事件为 0，计划行仍在
  for (const id of ["case-rollback-1", "case-rollback-2"]) {
    const card = await getJson(`${h.url}/v1/cases/${id}?role=admin`);
    assert.equal(card.json.card.reporter_contact, "SECRET-555", `${id} 应随事务回滚保留`);
    assert.equal(card.json.card.purge_status, "pending");
  }
});

test("登记事务回滚：附件写入后若清理计划插入失败，案件与附件不落库", async () => {
  const db = new DatabaseSync(h.dbPath, { enableDoubleQuotedStringLiterals: true });
  let reg: { status: number };
  try {
    db.exec(`
      CREATE TRIGGER fail_cleanup_plan
      BEFORE INSERT ON cleanup_plan
      BEGIN
        SELECT RAISE(ABORT, 'injected plan failure');
      END`);
    reg = await postJson(
      `${h.url}/v1/requests`,
      envelope("register_case", "case-register-rollback", {
        source_channel: "user_report",
        retention_days: 30,
        attachments: [{ attachment_id: "z1", kind: "url", digest: "sha256:dd99" }],
      })
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_cleanup_plan");
    db.close();
  }
  assert.equal(reg.status, 500);

  const card = await getJson(`${h.url}/v1/cases/case-register-rollback?role=admin`);
  assert.equal(card.status, 404);
  // 该 digest 未成为任何案件的首个附件（可被后续重新以非重复方式登记）
  const again = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-after-rollback", {
      source_channel: "user_report",
      retention_days: 30,
      attachments: [{ attachment_id: "z1", kind: "url", digest: "sha256:dd99" }],
    })
  );
  assert.equal(again.status, 201);
  assert.equal(again.json.result.attachments[0].duplicate, false);
});
