# 网络开盒举报分派与材料保留服务

平台安全团队高峰期举报分派后台：登记举报信封与附件索引，按本地风险规则计算优先级与处理队列，
按角色字段白名单导出脱敏处理卡片，并在保留到期后自动脱敏/匿名化/删除敏感字段。

- 运行时：Node.js 22 + TypeScript（纯 HTTP，无 Web 框架）
- 持久化：SQLite（better-sqlite3，同步事务，WAL），数据文件落盘，**重启后队列顺序与清理计划不丢失**
- 隔离性：**全程不连接任何外部内容识别或身份服务**；角色、渠道、风险规则全部来自本地 `config/policy.json` 与 `fixtures/rules.json`

## 目录结构

```
config/policy.json          # 渠道/时间窗/保留期/风险评分/队列/到期动作/角色白名单（可执行本地策略）
contracts/request.schema.json  # 请求信封顶层契约
fixtures/                   # 脱敏样例与规则主题
src/
  migrations/001_init.sql   # SQLite 迁移（启动时自动、幂等应用）
  validation.ts             # 信封/渠道/时间窗/保留策略/附件逐行校验
  risk.ts                   # 风险评分 → 优先级/队列/到期动作
  service.ts                # 事务化业务逻辑（登记/附件/重算/清理/卡片/导出）
  masking.ts                # 脱敏、匿名化与角色字段投影
  http.ts / app.ts / server.ts
test/                       # node:test 真实 HTTP 自动化测试（临时库 + 可控时钟）
scripts/blackbox.mjs        # 可重复容器黑盒（seed/verify 两阶段，零三方依赖）
scripts/e2e.sh              # 一键容器黑盒编排（含重启恢复）
Dockerfile / compose.yaml
```

## 本地运行

```sh
npm ci
npm test          # 36 项真实 HTTP 测试
npm run build
DB_PATH=./data/triage.db PORT=8080 node dist/server.js
```

健康检查：`GET /health`。

## 四类操作（POST /v1/requests）

信封顶层严格遵循 `contracts/request.schema.json`：
`request_id / operation / case_id / actor_role / occurred_at / payload`。
`request_id` 具有幂等性：重复提交返回 `REQUEST_DUPLICATE`，不产生第二条数据。

| operation | 允许角色 | 说明 |
| --- | --- | --- |
| `register_case` | admin, reviewer | 先校验渠道、时间窗、保留策略、附件行，再计算风险并入队；**附件坏行整案拒绝** |
| `register_attachments` | admin, reviewer, operator | 附件批量登记，**逐行结果**；重复摘要只保留一份规范附件，重复行写入 `attachment_refs` 并返回 `ref_to` |
| `recalculate` | admin, reviewer | 按新风险标记/保留期重算优先级、队列与到期时间，取消并重建清理计划 |
| `cleanup` | admin | 按到期计划执行 `anonymize` / `redact_sensitive` / `delete_record`，多案在同一事务内 |

登记与清理的所有 SQL 均在 `better-sqlite3` 事务中执行，任一语句失败整体回滚（测试中以
SQLite trigger 注入失败验证已删案件恢复）。拒绝的请求不写业务数据，仅留 `request_audit` 拒绝证据。

### 校验规则（本地）

- **来源渠道**：仅 `policy.source_channels` 中 `allowed=true` 受理（`anonymous_feed` 拒绝）。
- **时间窗**：`occurred_at` 须为带时区 ISO8601，不晚于当前 +300s 时钟偏差，不早于 10080 分钟（7 天）。
- **保留策略**：`retention_days` 须在 1–365；缺省按渠道默认（regulator 90、internal_scan 60、其余 30）。
- **附件**：`kind ∈ url/screenshot/video/archive/document`，`digest` 须匹配 `sha256:[16-128 位十六进制]`；
  批次内 attachment_id 重复为坏行。

### 风险与队列

`渠道基础分 + 规范附件类型分之和（重复摘要不重复计分）+ 命中风险标记`，封顶 100：

| 分数 | 优先级 | 队列 | 到期动作 |
| --- | --- | --- | --- |
| ≥80 | P0 | q_critical | anonymize |
| ≥55 | P1 | q_high | redact_sensitive |
| ≥30 | P2 | q_standard | redact_sensitive |
| 其他 | P3 | q_review | delete_record |

## 查询接口

- `GET /v1/queues?queue=&limit=&cursor=` —— 按持久化 `queue_seq` 稳定排序的游标分页
- `GET /v1/cases/:case_id/card?role=reviewer` —— 脱敏处理卡片
- `GET /v1/cleanup/preview?as_of=&case_id=` —— 清理计划预览（不落库）
- `POST /v1/export` body `{ "role": "operator", "case_ids": [...] }` —— 按角色白名单导出；
  被剔除字段列入 `denied_fields`，存在剔除时顶层返回原因码 `ROLE_FIELD_DENIED`
- `POST /v1/requests/bulk` body `{ "requests": [...] }` —— **按行返回结果**，每行独立事务，坏行不写入且不影响其它行

角色（`config/policy.json`）：`admin`（可见原文）、`reviewer`（部分 PII 脱敏可见）、
`operator`（处置字段，附件仅 id/kind/ref）、`auditor`（风险、摘要与审计字段，无 PII）。

## Docker / Compose

```sh
# 一键：构建 → 黑盒阶段1 → 重启 app → 黑盒阶段2 → 容器内自动化测试
./scripts/e2e.sh
```

`compose.yaml` 提供：

- `app`：运行镜像，SQLite 存于命名卷 `triage-data`，内置 `/health` 健康检查
- `blackbox-seed` / `blackbox-verify`：黑盒两阶段（验证真实 HTTP 的去重、重算、白名单、到期清理、坏行隔离与重启恢复）
- `test`：容器内 `npm test`
- `scaffold-check`：仓库原始契约/样例可读性检查

黑盒脚本也可对任意已运行实例执行：

```sh
BASE_URL=http://127.0.0.1:8080 node scripts/blackbox.mjs seed /tmp/state.json
# …重启服务进程…
BASE_URL=http://127.0.0.1:8080 node scripts/blackbox.mjs verify /tmp/state.json
```

> Compose 中 `ALLOW_CLOCK_OVERRIDE=true` 仅供本地黑盒用未来时点（2099 年）触发到期清理；
> 生产部署应删除该变量，清理只按真实时钟到期执行。

## 数据保留与安全说明

- 敏感字段清单见 `policy.sensitive_fields`（姓名、证件号、联系方式、地址、账号、URL、内容摘录、内部备注等）。
- `redact_sensitive`：保留键、值替换为掩码；`anonymize`：清空 PII 值仅留案件结构；`delete_record`：整案删除（审计行保留作为处置证据）。
- 所有判断均在本地完成，无任何外部网络身份/内容识别依赖。
