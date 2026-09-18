# 网络开盒举报分派与材料保留服务

平台安全团队高峰期的网络开盒/人肉搜索举报分派后台：单案登记、附件批量登记、风险重算、到期清理四类操作，自动按规则计算优先级与处理队列、全局去重附件摘要、按角色白名单导出脱敏字段，并在保留期到期后自动清除敏感字段。

纯后台 HTTP 服务：**Node.js 22 + TypeScript + 内置 `node:sqlite`**，零运行时第三方依赖，单进程、WAL 持久化，所有登记与清理均在 SQLite 事务内、失败整体回滚，重启后队列顺序与清理计划不丢失。运行时不连接任何外部内容识别或身份服务。

> 持久化选型：脚手架 README 曾提及 PostgreSQL，但本任务明确要求“在 SQLite 事务中回滚、重启后队列顺序和清理计划不丢失”，因此实现以需求为准采用 Node 22 内置 `node:sqlite`，不再需要数据库容器。`scaffold/` 契约自检保持不变。

## 目录结构

```
contracts/request.schema.json  入站信封契约（request_id/operation/case_id/actor_role/occurred_at/payload）
fixtures/                      脱敏样例与规则说明
rules/policy.json              本地风险/保留/角色白名单规则（运行时唯一事实来源，可热挂载覆盖）
migrations/001_init.sql        SQLite 初始迁移
src/                           领域服务、校验、HTTP、入口
test/                          node:test 真实 HTTP 自动化测试（含事务回滚与进程重启恢复）
scripts/blackbox.mjs           纯 HTTP 黑盒（suite / pre / post）
scripts/blackbox-container.sh  可重复容器黑盒（全新卷→起服→重启→恢复校验）
scripts/blackbox-local.sh      无 Docker 环境的等价黑盒
Dockerfile / compose.yaml      多阶段镜像、app 服务、健康检查、blackbox one-shot
```

## 快速开始（本地）

```sh
npm ci
npm run build
SQLITE_PATH=./data/dispatch.db npm start          # 默认 0.0.0.0:8080
curl -s http://127.0.0.1:8080/healthz
```

开发模式（tsx 直跑 TS）：`npm run dev`

环境变量：`PORT`（8080）、`HOST`（0.0.0.0）、`SQLITE_PATH`（/data/dispatch.db）、`POLICY_FILE`、`MIGRATIONS_DIR`。

## HTTP 接口

所有业务操作使用统一信封 `POST /v1/requests`（单条）或 `POST /v1/requests/batch`（信封数组，逐行返回、坏行隔离）。

| 操作 `operation` | 说明 |
| --- | --- |
| `register_case` | 单案登记：校验来源渠道、时间窗、保留策略、附件摘要/类型；计算优先级/队列/到期时间；写清理计划 |
| `register_attachments` | 附件批量登记：**按行返回**，坏行不写入，合法行在单事务内写入并重算风险 |
| `recalculate_risk` | 依据渠道+风险标签+去重后附件重算优先级，队列迁移并返回 `previous` 对比与原因码 |
| `preview_cleanup` | 预览到期清理计划（可用 `payload.now` 指定评估时间），不落库 |
| `run_cleanup` | 执行到期清理（`execute:false` 等同预览），单事务清除敏感字段并写审计事件 |
| `export_fields` | 按角色字段白名单导出，越权字段进入 `denied_fields`（原因码 `ROLE_FIELD_DENIED`） |

只读接口：

- `GET /v1/queues` —— 队列总览与计数
- `GET /v1/queues/:queue?limit=&cursor=&role=` —— 队列 **FIFO 分页**（游标为 `queue_seq`），按角色脱敏
- `GET /v1/cases/:caseId?role=` —— 案件脱敏处理卡片
- `GET /healthz` / `/readyz` —— 健康检查

### 登记示例

```sh
curl -s -X POST http://127.0.0.1:8080/v1/requests -H 'content-type: application/json' -d '{
  "request_id": "req-1001",
  "operation": "register_case",
  "case_id": "case-7",
  "actor_role": "reviewer",
  "occurred_at": "2026-09-18T10:30:00+08:00",
  "payload": {
    "source_channel": "user_report",
    "retention_days": 30,
    "risk_tags": ["minor_involved"],
    "attachments": [{ "attachment_id": "att-1", "kind": "url", "digest": "sha256:abc123" }],
    "reporter_contact": "13800000000",
    "evidence_urls": ["https://example.test/dox"]
  }
}'
```

## 关键规则（见 `rules/policy.json`）

- **来源渠道与保留期**：每个渠道有基础风险分与保留期上下限，越界拒绝（`RETENTION_OUT_OF_POLICY`）。
- **时间窗**：`occurred_at` 不得早于当前 30 天，或晚于当前 300 秒（`TIME_WINDOW_VIOLATION`，HTTP 422）。
- **优先级**：渠道基础分 + 风险标签分 + 去重后附件权重，封顶 100；映射到
  `critical/triage-urgent`、`high/triage-high`、`normal/triage-standard`、`low/triage-low`。
- **附件去重**：`attachments` 表以 `digest` 为主键**全局只存一份**，`ref_count` 记引用数；
  重复摘要只在 `case_attachments` 建引用并返回 `duplicate / already_linked / original_case_id / original_attachment_id / original_request_id` 引用关系，重复附件不重复计分。
- **到期动作**：到 `expires_at` 后清除六类敏感字段
  （`reporter_contact`、`subject_real_name`、`subject_id_number`、`subject_address`、`evidence_urls`、`internal_note`），
  保留案件卡片与 `cleanup_events` 审计轨迹，动作可重复执行且幂等。
- **角色白名单**：`triager / analyst / reviewer / auditor / admin`，`*card*` 为处理卡片字段集，`admin` 为 `*`；越权字段不返回并列入 `denied_fields`。

## 事务与恢复保证

- 单案登记（案件+附件索引+引用+清理计划+审计）在一个 `BEGIN IMMEDIATE` 事务内，失败整体回滚。
- 附件批量登记：逐行宽松校验做坏行隔离，**仅合法行**进入事务并与风险重算一起提交；事务失败则全部合法行回滚。
- 到期清理：多行清除+事件写入+计划删除在单事务内，中途失败全部回滚（测试用 SQLite 触发器注入故障验证敏感字段不被半清除）。
- 队列顺序由持久化的 `queue_seq`（`queue_counters` 单调计数）决定，清理计划与附件索引全部落盘（WAL + `synchronous=FULL`）；重启后顺序、计数器续接、判重索引、清理计划均保留（有进程级重启测试）。

## 测试

```sh
npm test          # node:test，真实拉起 HTTP 进程，28 个用例
npm run typecheck
npm run validate:scaffold
```

覆盖：来源/保留/时间窗/附件校验、附件跨案与同案去重及引用关系、优先级重算与队列迁移、队列 FIFO 分页、角色字段白名单、到期预览/执行/幂等、附件批与信封批的坏行隔离、**注入故障的登记与清理事务回滚**、以及**杀进程重启后的队列顺序/计数器/去重索引/清理计划恢复**。

## 容器

```sh
docker compose build app
docker compose up -d app           # 命名卷 app-data 持久化 /data，内置 healthcheck
docker compose run --rm blackbox suite       # 容器内真实 HTTP 黑盒
```

一键可重复容器黑盒（全新卷 → 构建 → 起服 → suite → pre → **重启容器** → post 恢复校验 → 清理）：

```sh
./scripts/blackbox-container.sh
```

本机无 Docker 时的等价验证（编译产物 + 杀进程重启）：

```sh
./scripts/blackbox-local.sh
```

脚手架契约自检（与原仓库一致）：

```sh
docker compose run --rm --no-deps scaffold-check
```

所有验证只访问本地 HTTP 与本地 SQLite，不访问任何外部网络服务。
