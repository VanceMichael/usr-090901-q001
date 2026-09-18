import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { envelope, getJson, nowIso, postJson, rid, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await startHarness("register");
});
after(async () => {
  await h.stop();
});

test("单案登记：合法信封返回优先级、队列与到期时间", async () => {
  const { status, json } = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-gov-1", {
      source_channel: "government_notice",
      retention_days: 30,
      risk_tags: ["minor_involved"],
      attachments: [{ attachment_id: "att-1", kind: "url", digest: "sha256:aaa111" }],
      reporter_contact: "13800000000",
      evidence_urls: ["https://example.test/dox"],
    })
  );
  assert.equal(status, 201);
  assert.equal(json.result.queue, "triage-urgent");
  assert.ok(json.result.priority_score >= 85);
  assert.equal(json.result.attachments[0].duplicate, false);
  // expires_at = registered_at + 30 天
  const diff = Date.parse(json.result.expires_at) - Date.parse(json.result.registered_at);
  assert.equal(Math.round(diff / 86_400_000), 30);
});

test("来源渠道校验：未知渠道拒绝且不写入", async () => {
  const { status, json } = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-bad-channel", {
      source_channel: "anonymous_darkweb",
      retention_days: 30,
    })
  );
  assert.equal(status, 400);
  assert.equal(json.error.code, "UNKNOWN_SOURCE_CHANNEL");
  const card = await getJson(`${h.url}/v1/cases/case-bad-channel?role=admin`);
  assert.equal(card.status, 404);
});

test("保留策略：政府通知渠道 1 天低于最短保留期，拒绝", async () => {
  const { status, json } = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-bad-retention", {
      source_channel: "government_notice",
      retention_days: 1,
    })
  );
  assert.equal(status, 400);
  assert.equal(json.error.code, "RETENTION_OUT_OF_POLICY");
});

test("时间窗：30 天前的 occurred_at 拒绝（422）", async () => {
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const { status, json } = await postJson(
    `${h.url}/v1/requests`,
    envelope(
      "register_case",
      "case-old-window",
      { source_channel: "user_report", retention_days: 30 },
      { occurred_at: old }
    )
  );
  assert.equal(status, 422);
  assert.equal(json.error.code, "TIME_WINDOW_VIOLATION");
});

test("时间窗：超过时钟偏差的未来时间拒绝", async () => {
  const future = new Date(Date.now() + 600_000).toISOString();
  const { status, json } = await postJson(
    `${h.url}/v1/requests`,
    envelope(
      "register_case",
      "case-future-window",
      { source_channel: "user_report", retention_days: 30 },
      { occurred_at: future }
    )
  );
  assert.equal(status, 422);
  assert.equal(json.error.code, "TIME_WINDOW_VIOLATION");
});

test("附件引用校验：非法 digest/kind 拒绝", async () => {
  const badDigest = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-bad-digest", {
      source_channel: "user_report",
      retention_days: 30,
      attachments: [{ attachment_id: "a1", kind: "url", digest: "md5:zzz" }],
    })
  );
  assert.equal(badDigest.status, 400);
  assert.equal(badDigest.json.error.code, "INVALID_ATTACHMENT_DIGEST");

  const badKind = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-bad-kind", {
      source_channel: "user_report",
      retention_days: 30,
      attachments: [{ attachment_id: "a1", kind: "malware", digest: "sha256:deadbeef" }],
    })
  );
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.error.code, "INVALID_ATTACHMENT_KIND");
});

test("重复附件摘要：跨案全局只保留一份，返回引用关系", async () => {
  const digest = "sha256:c0ffee0001";
  const first = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-dup-first", {
      source_channel: "user_report",
      retention_days: 30,
      attachments: [{ attachment_id: "orig", kind: "document", digest }],
    })
  );
  assert.equal(first.status, 201);
  assert.equal(first.json.result.attachments[0].duplicate, false);

  const second = await postJson(
    `${h.url}/v1/requests`,
    envelope("register_case", "case-dup-second", {
      source_channel: "hotline",
      retention_days: 10,
      attachments: [
        { attachment_id: "copy-1", kind: "document", digest },
        { attachment_id: "copy-2", kind: "document", digest },
      ],
    })
  );
  assert.equal(second.status, 201);
  const [r1, r2] = second.json.result.attachments;
  assert.equal(r1.duplicate, true);
  assert.equal(r1.already_linked, false);
  assert.equal(r1.original_case_id, "case-dup-first");
  assert.equal(r1.original_attachment_id, "orig");
  // 同案第二次链接同一摘要：标记 already_linked，不重复计分
  assert.equal(r2.duplicate, true);
  assert.equal(r2.already_linked, true);

  // 重复附件对第二案的风险分只计一次
  const factorCount = second.json.result.risk_factors.filter(
    (f: { code: string }) => f.code === "attachment:document"
  ).length;
  assert.equal(factorCount, 1);
});

test("重复案件登记冲突 409", async () => {
  const payload = { source_channel: "user_report", retention_days: 30 };
  const id = `case-conflict-${rid("x")}`;
  const first = await postJson(`${h.url}/v1/requests`, envelope("register_case", id, payload));
  assert.equal(first.status, 201);
  const second = await postJson(`${h.url}/v1/requests`, envelope("register_case", id, payload));
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, "CASE_ALREADY_EXISTS");
});

test("健康检查与非法 JSON 处理", async () => {
  const health = await getJson(`${h.url}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.json.status, "ok");

  const res = await fetch(`${h.url}/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, "INVALID_JSON");
  void nowIso;
});
