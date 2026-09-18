#!/usr/bin/env node
// 容器黑盒脚本：仅通过真实 HTTP 验证，不直接读库、不连任何外部服务。
// 用法：
//   node scripts/blackbox.mjs suite   完整流程（去重/重算/白名单/清理/坏行隔离）
//   node scripts/blackbox.mjs pre     重启前：写入并校验即时结果
//   node scripts/blackbox.mjs post    重启后：校验队列顺序/计数器/去重索引/清理计划存活
// 环境：BASE_URL（默认 http://127.0.0.1:8080）、RUN_ID（默认 bb，全新库上可重复）

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const RUN = process.env.RUN_ID ?? "bb";
const FUTURE = "2031-01-01T00:00:00Z";

// 摘要只允许十六进制，把 RUN_ID 派生成稳定的 hex 串（不引入加密依赖）
function hexOf(s) {
  let h = "";
  for (let i = 0; i < s.length; i++) h += (s.charCodeAt(i) & 0xff).toString(16).padStart(2, "0");
  return h;
}
const RUNHEX = hexOf(RUN).slice(0, 24).padEnd(24, "0");
const digest = `sha256:${RUNHEX}deadbeef`;
const dg = (suffix) => `sha256:${(RUNHEX + hexOf(suffix)).slice(0, 40).padEnd(40, "0")}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${name}${extra ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

async function call(operation, caseId, payload, opts = {}) {
  const res = await fetch(`${BASE}/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: opts.request_id ?? `${RUN}-${Math.random().toString(36).slice(2, 8)}`,
      operation,
      case_id: caseId,
      actor_role: opts.actor_role ?? "reviewer",
      occurred_at: opts.occurred_at ?? new Date().toISOString(),
      payload,
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪: ${last}`);
}

// ---------- suite：去重、重算、角色白名单、到期清理、坏行隔离 ----------
async function suite() {
  console.log("[health]");
  await waitHealthy();
  const h = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz 返回 sqlite 与策略版本", h.database === "sqlite" && !!h.policy_version, h);

  console.log("[register + attachment dedup]");
  const r1 = await call("register_case", `${RUN}-case-a`, {
    source_channel: "user_report",
    retention_days: 30,
    attachments: [{ attachment_id: "att-orig", kind: "document", digest }],
    reporter_contact: "13800001111",
    subject_real_name: "赵六",
    evidence_urls: ["https://evidence.test/a"],
  });
  eq("首案 201", r1.status, 201);
  eq("首案附件非重复", r1.body.result.attachments[0].duplicate, false);

  const r2 = await call("register_case", `${RUN}-case-b`, {
    source_channel: "hotline",
    retention_days: 10,
    attachments: [
      { attachment_id: "att-copy", kind: "document", digest },
      { attachment_id: "att-copy-2", kind: "document", digest },
    ],
  });
  eq("第二案 201", r2.status, 201);
  const refs = r2.body.result.attachments;
  eq("重复摘要标记 duplicate", refs[0].duplicate, true);
  eq("重复摘要指向原案件", refs[0].original_case_id, `${RUN}-case-a`);
  eq("重复摘要指向原附件行", refs[0].original_attachment_id, "att-orig");
  eq("同案二次链接标记 already_linked", refs[1].already_linked, true);

  console.log("[priority recalculation]");
  const low = await call("register_case", `${RUN}-case-c`, {
    source_channel: "self_submission",
    retention_days: 30,
  });
  eq("低分案初始队列 triage-low", low.body.result.queue, "triage-low");
  const rc = await call("recalculate_risk", `${RUN}-case-c`, {
    risk_tags: ["minor_involved", "self_harm_risk", "ongoing_harassment"],
  });
  eq("重算原因码", rc.body.result.reason, "PRIORITY_RECALCULATED");
  eq("重算后迁移到 triage-urgent", rc.body.result.queue, "triage-urgent");
  eq("重算后级别 critical", rc.body.result.priority_level, "critical");
  eq("previous 记录旧队列", rc.body.result.previous.queue, "triage-low");

  console.log("[role field whitelist]");
  const triager = await (await fetch(`${BASE}/v1/cases/${RUN}-case-a?role=triager`)).json();
  check("triager 卡片无敏感字段", !("reporter_contact" in triager.card), Object.keys(triager.card));
  const reviewer = await call("export_fields", `${RUN}-case-a`, {
    role: "reviewer",
    fields: ["case_id", "reporter_contact", "subject_id_number"],
  });
  eq("reviewer 可见联系方式", reviewer.body.result.records[0].fields.reporter_contact, "13800001111");
  eq("reviewer 不可见证件号 -> denied", reviewer.body.result.denied_fields, ["subject_id_number"]);
  const denied = await call("export_fields", `${RUN}-case-a`, { role: "stranger", fields: ["case_id"] });
  eq("未知角色 403", denied.status, 403);

  console.log("[bad-row isolation in batch attachment register]");
  const batch = await call("register_attachments", `${RUN}-case-a`, {
    attachments: [
      { attachment_id: "g1", kind: "video", digest: dg("g1") },
      { attachment_id: "g2", kind: "url", digest: "sha1:bad" },
      "not-object",
    ],
  });
  eq("批量整体 200 按行返回", batch.status, 200);
  eq("合法行计数", batch.body.result.accepted, 1);
  eq("坏行计数", batch.body.result.rejected, 2);

  console.log("[cleanup preview + execute]");
  const preview = await call("preview_cleanup", `${RUN}-case-a`, { now: FUTURE });
  const dueItem = preview.body.result.due.find((d) => d.case_id === `${RUN}-case-a`);
  check("未来时间预览到到期案件", !!dueItem, preview.body.result.due);
  check("预览列出待清除字段", (dueItem?.purgable_fields ?? []).includes("reporter_contact"));

  const exec = await call("run_cleanup", `${RUN}-case-a`, { now: FUTURE });
  const done = exec.body.result.executed.find((e) => e.case_id === `${RUN}-case-a`);
  check("清理执行返回案件", !!done);
  const after = await (await fetch(`${BASE}/v1/cases/${RUN}-case-a?role=admin`)).json();
  eq("清理后联系方式为空", after.card.reporter_contact, null);
  eq("清理后证据 URL 清空", after.card.evidence_urls, []);
  check("清理后 purged_at 已写入", !!after.card.purged_at);
  const again = await call("run_cleanup", `${RUN}-case-a`, { now: FUTURE });
  eq("清理幂等：第二次 0 行", again.body.result.executed_count, 0);

  console.log("[envelope batch row isolation]");
  const eb = await fetch(`${BASE}/v1/requests/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      {
        request_id: `${RUN}-eb1`,
        operation: "register_case",
        case_id: `${RUN}-case-d`,
        actor_role: "r",
        occurred_at: new Date().toISOString(),
        payload: { source_channel: "self_submission", retention_days: 2 },
      },
      { operation: "register_case", payload: {} },
    ]),
  });
  const ebj = await eb.json();
  eq("信封批量 accepted=1", ebj.accepted, 1);
  eq("信封批量 rejected=1", ebj.rejected, 1);
  eq("好行 201/坏行 400", ebj.results.map((x) => x.status), [201, 400]);
}

// ---------- 重启前 ----------
async function pre() {
  console.log("[pre-restart] 写入用于恢复校验的数据");
  await waitHealthy();
  for (let i = 0; i < 3; i++) {
    const r = await call("register_case", `${RUN}-q-${i}`, {
      source_channel: "self_submission",
      retention_days: 45,
      attachments: [{ attachment_id: `a-${i}`, kind: "url", digest: dg(`f${i}`) }],
    });
    eq(`重启前案件 ${i} 登记 201`, r.status, 201);
  }
  const urgent = await call("register_case", `${RUN}-urgent`, {
    source_channel: "government_notice",
    retention_days: 60,
    risk_tags: ["minor_involved"],
  });
  eq("重启前 urgent 入队", urgent.body.result.queue, "triage-urgent");
  console.log("[pre-restart] 完成，可安全重启服务");
}

// ---------- 重启后 ----------
async function post() {
  console.log("[post-restart] 校验持久化状态");
  await waitHealthy();
  const page = await (await fetch(`${BASE}/v1/queues/triage-low?limit=10`)).json();
  const ids = page.items.map((i) => i.case_id).filter((id) => id.startsWith(`${RUN}-q-`));
  eq("队列 FIFO 顺序恢复", ids, [`${RUN}-q-0`, `${RUN}-q-1`, `${RUN}-q-2`]);
  const seqs = page.items.filter((i) => i.case_id.startsWith(`${RUN}-q-`)).map((i) => i.queue_seq);
  check("队列序号随卡片返回", seqs.every((n) => typeof n === "number"), seqs);

  // 计数器续接：新案件序号必须大于重启前最大序号
  const add = await call("register_case", `${RUN}-q-after`, {
    source_channel: "self_submission",
    retention_days: 30,
  });
  check("重启后队列计数器续接不复用", add.body.result.queue_seq === Math.max(...seqs) + 1, {
    got: add.body.result.queue_seq,
    prevMax: Math.max(...seqs),
  });

  // 去重索引存活
  const dup = await call("register_case", `${RUN}-q-dup`, {
    source_channel: "self_submission",
    retention_days: 30,
    attachments: [{ attachment_id: "copy", kind: "url", digest: dg("f1") }],
  });
  eq("重启后旧摘要仍判重", dup.body.result.attachments[0].duplicate, true);
  eq("重启后判重指向原案件", dup.body.result.attachments[0].original_case_id, `${RUN}-q-1`);

  // 清理计划存活
  const plan = await call("preview_cleanup", `${RUN}-q-0`, { now: FUTURE });
  check(
    "重启后清理计划仍在",
    plan.body.result.due.some((d) => d.case_id === `${RUN}-q-0`),
    plan.body.result.due
  );

  // urgent 队列恢复
  const urgent = await (await fetch(`${BASE}/v1/queues/triage-urgent?limit=10`)).json();
  check("urgent 队列恢复", urgent.items.some((i) => i.case_id === `${RUN}-urgent`));
}

const phase = process.argv[2] ?? "suite";
try {
  if (phase === "suite") await suite();
  else if (phase === "pre") await pre();
  else if (phase === "post") await post();
  else if (phase === "health") await waitHealthy();
  else throw new Error(`未知阶段: ${phase}`);
  if (failures > 0) {
    console.error(`\n黑盒校验失败 ${failures} 项`);
    process.exit(1);
  }
  console.log(`\n黑盒校验通过（${phase}）`);
} catch (e) {
  console.error("黑盒脚本异常:", e);
  process.exit(2);
}
