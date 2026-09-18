#!/usr/bin/env node
// 容器黑盒脚本：通过真实 HTTP 验证
// 附件去重 / 优先级重算 / 角色字段白名单 / 到期清理 / 坏行隔离 / 重启恢复。
// 用法：
//   node scripts/blackbox.mjs seed <stateFile>     # 首次启动后执行
//   node scripts/blackbox.mjs verify <stateFile>   # 重启后执行
// 环境：BASE_URL（默认 http://app:8080）
import { writeFileSync, readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://app:8080";
const FUTURE = "2099-01-01T00:00:00Z";
const DA = "sha256:aaaaaaaaaaaaaaaa";
const DB_ = "sha256:bbbbbbbbbbbbbbbb";
const DC = "sha256:cccccccccccccccc";

let passed = 0;
function check(name, cond, extra) {
  if (!cond) {
    throw new Error(`断言失败: ${name}${extra ? `\n实际: ${JSON.stringify(extra)}` : ""}`);
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function nowOffsetIso(minutes = 0) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function waitHealthy(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await req("GET", "/health");
      if (r.status === 200) return r.body;
    } catch {
      /* 服务尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("服务健康检查未通过");
}

async function seed(stateFile) {
  console.log("[seed] 阶段 1：登记 / 去重 / 批量 / 重算 / 预览 / 清理（重启前）");
  await waitHealthy();

  // 1) 单案登记：P0 案件（regulator 55 + minor 40 + url 5 = 100 → anonymize）
  const r1 = await req("POST", "/v1/requests", {
    request_id: "bb-req-critical",
    operation: "register_case",
    case_id: "bb-critical",
    actor_role: "reviewer",
    occurred_at: nowOffsetIso(-1),
    payload: {
      source_channel: "regulator",
      retention_days: 2,
      subject_name: "王五",
      subject_phone: "13911112222",
      risk_flags: ["minor_involved"],
      attachments: [{ attachment_id: "att-a", kind: "url", digest: DA, url: "https://evidence.test/a" }],
    },
  });
  check("P0 案件登记成功", r1.status === 200 && r1.body.status === "accepted", r1.body);
  check("分派到 q_critical / anonymize", r1.body.data.priority === "P0" && r1.body.data.queue === "q_critical" && r1.body.data.expiry_action === "anonymize", r1.body.data);

  // 2) 单案登记：低分案件（user_report 20 + screenshot 10 = 30 → P2）
  const r2 = await req("POST", "/v1/requests", {
    request_id: "bb-req-low",
    operation: "register_case",
    case_id: "bb-low",
    actor_role: "reviewer",
    occurred_at: nowOffsetIso(-1),
    payload: {
      source_channel: "user_report",
      retention_days: 1,
      subject_name: "赵六",
      attachments: [{ attachment_id: "att-b", kind: "screenshot", digest: DB_ }],
    },
  });
  check("低分案件登记为 P2/q_standard", r2.body.data.priority === "P2" && r2.body.data.queue === "q_standard", r2.body.data);

  // 3) 附件批量登记：跨批次重复摘要只保留一份
  const r3 = await req("POST", "/v1/requests", {
    request_id: "bb-req-attachments",
    operation: "register_attachments",
    case_id: "bb-critical",
    actor_role: "operator",
    occurred_at: nowOffsetIso(-1),
    payload: {
      attachments: [
        { attachment_id: "att-dup-a", kind: "url", digest: DA },       // 与 att-a 重复
        { attachment_id: "att-c", kind: "video", digest: DC },         // 全新
        { attachment_id: "att-bad", kind: "url", digest: "oops" },     // 坏行
      ],
    },
  });
  check("附件批次整体受理且坏行被标记", r3.status === 200 && r3.body.data.rejected_attachments.length === 1, r3.body);
  const byId = Object.fromEntries(r3.body.data.attachments.map((a) => [a.attachment_id, a]));
  check("重复摘要返回引用关系 att-dup-a → att-a", byId["att-dup-a"].status === "duplicate" && byId["att-dup-a"].ref_to === "att-a", byId);
  check("新摘要 att-c 创建", byId["att-c"].status === "created", byId);
  check("响应带 DUPLICATE_ATTACHMENT 原因码", r3.body.reasons.includes("DUPLICATE_ATTACHMENT"), r3.body.reasons);

  // 4) 批量请求按行返回，坏行隔离
  const bulk = await req("POST", "/v1/requests/bulk", {
    requests: [
      { request_id: "bb-bulk-good", operation: "register_case", case_id: "bb-bulk-good", actor_role: "reviewer", occurred_at: nowOffsetIso(-1),
        payload: { source_channel: "hotline", retention_days: 1, attachments: [] } },
      { request_id: "bb-bulk-bad-channel", operation: "register_case", case_id: "bb-bulk-bad", actor_role: "reviewer", occurred_at: nowOffsetIso(-1),
        payload: { source_channel: "anonymous_feed" } },
      { request_id: "bb-bulk-malformed", operation: "register_case" },
    ],
  });
  check("批量 3 行：1 受理 2 拒绝（坏渠道 + 信封坏行）", bulk.body.total === 3 && bulk.body.accepted === 1 && bulk.body.rejected === 2, bulk.body);
  check("坏行原因码为 CHANNEL_NOT_ALLOWED", bulk.body.results[1].reasons?.[0] === "CHANNEL_NOT_ALLOWED", bulk.body.results[1]);

  // 5) 风险重算：bb-low +coordinated(25) → 55 → P1/q_high
  const rc = await req("POST", "/v1/requests", {
    request_id: "bb-req-recalc",
    operation: "recalculate",
    case_id: "bb-low",
    actor_role: "reviewer",
    occurred_at: nowOffsetIso(-1),
    payload: { risk_flags: ["coordinated"] },
  });
  check("重算提升到 P1/q_high", rc.body.data.before.priority === "P2" && rc.body.data.after.priority === "P1" && rc.body.data.after.queue === "q_high", rc.body.data);

  // 6) 角色字段白名单
  const op = await req("GET", "/v1/cases/bb-critical/card?role=operator");
  check("operator 不可见 subject_name", !("subject_name" in op.body.card) && "priority" in op.body.card, op.body.card);
  const rv = await req("GET", "/v1/cases/bb-critical/card?role=reviewer");
  check("reviewer 的 subject_name 已脱敏", typeof rv.body.card.subject_name === "string" && rv.body.card.subject_name.includes("***"), rv.body.card);
  const adm = await req("GET", "/v1/cases/bb-critical/card?role=admin");
  check("admin 可见 PII 原文", adm.body.card.subject_name === "王五", adm.body.card);
  const ex = await req("POST", "/v1/export", { role: "auditor" });
  check("导出按角色投影并提示 ROLE_FIELD_DENIED", ex.body.reason_codes.includes("ROLE_FIELD_DENIED") && Array.isArray(ex.body.exported), ex.body);

  // 7) 队列分页
  const q1 = await req("GET", "/v1/queues?limit=2");
  check("首页 2 条且有游标", q1.body.items.length === 2 && typeof q1.body.next_cursor === "number", q1.body);
  const q2 = await req("GET", `/v1/queues?limit=2&cursor=${q1.body.next_cursor}`);
  check("分页不重不漏（首页与次页无交集）", !q2.body.items.some((i) => i.case_id === q1.body.items[0].case_id), q2.body);

  // 8) 清理计划预览（未来时点）
  const preview = await req("GET", `/v1/cleanup/preview?as_of=${FUTURE}`);
  const cases = [...new Set(preview.body.items.map((i) => i.case_id))].sort();
  check("预览覆盖全部 3 个在办案件", JSON.stringify(cases) === JSON.stringify(["bb-bulk-good", "bb-critical", "bb-low"]), cases);

  // 9) 仅对 bb-critical 执行到期匿名化（重启前）
  const clean = await req("POST", "/v1/requests", {
    request_id: "bb-req-cleanup-critical",
    operation: "cleanup",
    case_id: "bb-critical",
    actor_role: "admin",
    occurred_at: nowOffsetIso(),
    payload: { as_of: FUTURE, case_id: "bb-critical" },
  });
  check("bb-critical 到期匿名化", clean.status === 200 && clean.body.data.cleaned[0].status_after === "anonymized", clean.body);
  const afterCard = await req("GET", "/v1/cases/bb-critical/card?role=admin");
  check("匿名化后 subject_name 已清空", afterCard.body.card.subject_name === null, afterCard.body.card);

  // 10) 幂等：重放 request_id 被拒绝
  const replay = await req("POST", "/v1/requests", {
    request_id: "bb-req-critical",
    operation: "register_case",
    case_id: "bb-critical",
    actor_role: "reviewer",
    occurred_at: nowOffsetIso(-1),
    payload: { source_channel: "regulator" },
  });
  check("重复 request_id 幂等拒绝", replay.status === 422 && replay.body.reasons.includes("REQUEST_DUPLICATE"), replay.body);

  const queueSnapshot = (await req("GET", "/v1/queues?limit=100")).body.items.map((i) => [i.case_id, i.queue_seq, i.queue]);
  writeFileSync(stateFile, JSON.stringify({ queueSnapshot, seededAt: new Date().toISOString() }, null, 2));
  console.log(`[seed] 完成，${passed} 项检查通过；状态写入 ${stateFile}`);
}

async function verify(stateFile) {
  console.log("[verify] 阶段 2：重启后恢复 + 剩余清理");
  await waitHealthy();
  const state = JSON.parse(readFileSync(stateFile, "utf8"));

  // 队列顺序与序号不丢失
  const q = await req("GET", "/v1/queues?limit=100");
  const snapshot = q.body.items.map((i) => [i.case_id, i.queue_seq, i.queue]);
  check("重启后队列顺序与序号一致", JSON.stringify(snapshot) === JSON.stringify(state.queueSnapshot), { got: snapshot, want: state.queueSnapshot });

  // 已匿名化案件状态持久
  const crit = await req("GET", "/v1/cases/bb-critical/card?role=admin");
  check("bb-critical 重启后仍为 anonymized 且 PII 为空", crit.body.card.status === "anonymized" && crit.body.card.subject_name === null, crit.body.card);

  // 附件引用关系不丢失
  const refs = crit.body.card.attachments.filter((a) => a.duplicate);
  check("重复附件引用关系重启后仍在", refs.some((a) => a.attachment_id === "att-dup-a" && a.ref_to === "att-a"), refs);

  // 其余案件清理计划不丢失
  const preview = await req("GET", `/v1/cleanup/preview?as_of=${FUTURE}`);
  const dueCases = [...new Set(preview.body.items.map((i) => i.case_id))].sort();
  check("bb-low 与 bb-bulk-good 的清理计划重启后仍在", JSON.stringify(dueCases) === JSON.stringify(["bb-bulk-good", "bb-low"]), dueCases);

  // 健康检查仍可用
  const health = await req("GET", "/health");
  check("健康检查返回策略版本", health.status === 200 && /2026/.test(health.body.policy_version), health.body);

  // 执行剩余清理：bb-low 重算后为 P1 → redact；bb-bulk-good 为 P3 → delete
  const clean = await req("POST", "/v1/requests", {
    request_id: "bb-req-cleanup-rest",
    operation: "cleanup",
    case_id: "global",
    actor_role: "admin",
    occurred_at: nowOffsetIso(),
    payload: { as_of: FUTURE },
  });
  check("剩余清理执行成功", clean.status === 200 && clean.body.data.cleaned.length === 2, clean.body);
  const outcomes = Object.fromEntries(clean.body.data.cleaned.map((c) => [c.case_id, c]));
  check("bb-low 字段脱敏", outcomes["bb-low"].status_after === "redacted", outcomes);
  check("bb-bulk-good 整案删除", outcomes["bb-bulk-good"].status_after === "deleted", outcomes);

  const gone = await req("GET", "/v1/cases/bb-bulk-good/card?role=admin");
  check("删除案件卡片 404", gone.status === 404, gone.status);
  const low = await req("GET", "/v1/cases/bb-low/card?role=admin");
  check("bb-low 敏感字段已掩码", String(low.body.card.subject_name).includes("***"), low.body.card);

  // 坏行确实从未写入
  const bad = await req("GET", "/v1/cases/bb-bulk-bad/card?role=admin");
  check("坏行案件重启后仍不存在", bad.status === 404, bad.status);

  console.log(`[verify] 完成，累计 ${passed} 项检查通过`);
}

const [, , phase, stateFile = "/data/blackbox-state.json"] = process.argv;
if (phase === "seed") {
  await seed(stateFile);
} else if (phase === "verify") {
  await verify(stateFile);
} else {
  console.error("用法: node scripts/blackbox.mjs <seed|verify> [stateFile]");
  process.exit(2);
}
