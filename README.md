# 隧道疏散演练指挥系统

隧道疏散演练中，指挥席依次收到三项现场确认：**横通道开启 → 上游封闭 → 人员清点**。
本项目让指挥员在一个页面上按固定顺序逐项确认；为防止网络重试导致“旧按钮请求晚到”而
把尚未完成的节点错误推进，每一步都用 **(当前节点名, 页面已见版本号)** 做乐观锁校验。

- 前端：React 18 + TypeScript + Vite（页面真实调用 FastAPI，无 mock、无固定响应）
- 后端：FastAPI + SQLite（单表单行，只保存唯一一场“当前演练”）
- 编排：Docker Compose 只运行 `web`、`api` 两个长驻服务，另有一次性 `verify` 验收服务

## 状态机与实现说明

固定顺序与版本如下，启动后首节点版本恒为 `1`，每成功确认一次版本加一：

```
横通道开启(cross_passage_open, v1)
  └─ 上游封闭(upstream_seal, v2)
       └─ 人员清点(headcount, v3)
            └─ completed(v4)   # 最后一次确认后标记完成，完成结果只产生一次
```

每次确认，前端都必须**同时**提交“当前节点名”和“页面已见到的版本号”。后端在
**一个数据库事务**中执行 compare-and-set（`BEGIN IMMEDIATE` 串行化并发请求）：

- 仅当提交的 `node` 与 `version` **都**与库中当前行匹配时才推进，并把 `version + 1`；
- 到最后一个节点后，把状态置为 `completed`（节点名停在 `headcount`，版本变为 4）；
- 以下情况一律返回 **HTTP 409**，响应体带回服务器**实际**的 `node` / `version`，
  且**绝不改变状态**：
  - 重复确认（`duplicate_confirmation`，旧节点名晚到）
  - 旧版本（`old_version`，节点对但版本号落后）
  - 版本号超前/不一致（`version_mismatch`）
  - 跳过节点（`skipped_node`）、未知节点（`unknown_node`）
  - 已完成后再次确认（`drill_completed`）
  - 演练已存在时再次启动（`drill_already_exists`）

浏览器收到 409 后会显示错误信息，并**立即重新拉取服务器状态**刷新页面，因此晚到的重试
不可能让页面停留在“领先于服务器”的错误位置。SQLite 文件挂载在独立卷上，**即使 API 在
任意一次成功确认后重启**，指挥员刷新后仍从唯一正确的下一节点继续。

## 预计用时与节奏提示

指挥员启动演练时可填写**预计用时**（整数，`5`–`180` 分钟，默认 `30` 分钟）。启动后：

- 服务端以**自己的 UTC 时钟**在写入事务中记录启动时刻 `started_at`，并计算
  `planned_end_at = started_at + planned_minutes`；
- 查询演练始终返回 `started_at` / `planned_minutes` / `planned_end_at`（均为 UTC ISO-8601）；
- 指挥页面持续显示**已用时间**、**剩余时间**，超过预计结束时刻后切换为
  **“已超出预计”**（如 `已超出预计 01:23`，超过一小时会带小时位）；预计结束时刻按浏览器本地时区展示；
- 计时完全由服务端返回的结束时刻驱动，页面每秒仅做本地计算，**不产生额外 API 请求**；
  刷新页面后按同一结束时刻继续，计时器卸载即清理；
- 三项确认的固定顺序、节点/版本语义与超时与否**完全无关**，超时后仍可正常完成确认。

旧客户端 POST 启动请求时不带请求体（或传空对象 / `null`），服务端按 **30 分钟**处理。
旧数据库无需删库重建：初始化会对已有的单行表做**可重复执行**的字段迁移；旧行缺少时间
数据时，在**首次读取/确认**中以当时服务端时间为基准一次性补齐 30 分钟计划（并发首读由
写事务保证只写入一个一致基准）。非法时长（超出 5–180、非整数等）返回 **422 且不创建
演练**；页面在启动前也会做同样的范围校验并给出提示。

## 启动方式（Docker Compose）

需要 Docker 与 Compose 插件。默认在宿主暴露 `http://localhost:5173`（页面）与
`http://localhost:8000`（API）：

```bash
docker compose up --build
```

页面打开 `http://localhost:5173`，点击“启动演练”，再依次确认三个节点。
浏览器只访问同源 `/api`，由 nginx 反代到 `api` 容器。

宿主端口可用 `WEB_PORT` / `API_PORT` 覆盖：

```bash
WEB_PORT=8080 API_PORT=9000 docker compose up --build
# 页面 http://localhost:8080 ，API http://localhost:9000
```

### 一次性验收服务 verify

`verify` 不常驻，它在容器内启动**真实的 uvicorn 和构建后的 Vite preview**（各自独立
进程、使用全新 SQLite 文件），然后依次运行 pytest、Vitest、Playwright（测试中还会真正
杀掉并重启 uvicorn）：

```bash
docker compose run --rm verify
```

`verify` 位于 `profiles: ["verify"]` 下，因此普通的 `docker compose up` 只启动
`web` 和 `api`，不会运行它。

## 本地开发（不使用 Docker）

后端（建议虚拟环境）：

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
export DRILL_DB_PATH=/tmp/drill.db
uvicorn app.main:app --reload --port 8000
```

前端：

```bash
cd frontend
npm install
npm run dev          # Vite dev server 把同源 /api 代理到 http://127.0.0.1:8000
```

`API_ORIGIN` 可改变代理目标（`API_ORIGIN=http://127.0.0.1:9000 npm run dev`）。
生产预览用 `npm run build && npm run preview`。

## API 契约

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | `/api/health` | 健康检查 |
| GET  | `/api/drills` | 查询唯一演练；不存在返回 404；返回 `started_at`、`planned_minutes`、`planned_end_at`（UTC） |
| POST | `/api/drills/start` | 仅在无演练时创建固定顺序、版本 1；请求体可空，可选 `{"planned_minutes": N}`（5–180，缺省 30）；超范围返回 422 且不建演练；已存在返回 409 |
| POST | `/api/drills/confirm` | 提交 `{"node": "...", "version": N}`，单事务比对推进 |

成功与冲突响应示例：

```jsonc
// POST /api/drills/start {"planned_minutes":45}  → 201
// （旧客户端不带请求体同样兼容，此时 planned_minutes 为 30）
{ "status": "in_progress", "node": "cross_passage_open", "version": 1,
  "steps": ["cross_passage_open", "upstream_seal", "headcount"],
  "planned_minutes": 45,
  "started_at": "2026-09-15T10:00:00+00:00",
  "planned_end_at": "2026-09-15T10:45:00+00:00" }

// POST /api/drills/confirm {"node":"cross_passage_open","version":1}  → 200
{ "status": "in_progress", "node": "upstream_seal", "version": 2,
  "steps": ["cross_passage_open", "upstream_seal", "headcount"],
  "planned_minutes": 45,
  "started_at": "2026-09-15T10:00:00+00:00",
  "planned_end_at": "2026-09-15T10:45:00+00:00" }

// POST /api/drills/start {"planned_minutes":181}  → 422（不创建演练）
{ "detail": "预计用时需在 5 至 180 分钟之间，收到 181。" }

// 旧按钮请求晚到 → 409（带回服务器实际状态，且状态不变）
{ "error": "old_version", "detail": "提交的是旧版本 1，服务器当前版本为 2。",
  "node": "upstream_seal", "version": 2, "drill_status": "in_progress" }
```

## 测试

三层测试全部针对真实联调，不使用固定响应或“未实现”桩分支：

```bash
# 后端：pytest（含真实 uvicorn 子进程重启持久性用例、并发双发只推进一次）
cd backend && python -m pytest

# 前端单元：Vitest（API 客户端 + React 页面冲突后刷新服务器状态）
cd frontend && npm run test

# 端到端：Playwright（真实 Chromium ← Vite preview ← 真实 FastAPI/SQLite）
# globalSetup 会自动 npm run build、拉起 uvicorn 与 vite preview；
# 用例中会真正 stop/start API。可用环境变量指定端口与 Python：
cd frontend
PYTHON_BIN=/path/to/venv/bin/python E2E_API_PORT=18000 E2E_WEB_PORT=14173 \
  npx playwright install --with-deps chromium   # 首次需要浏览器与系统库
  npm run test:e2e
```

Playwright 覆盖：固定顺序与首节点 v1、旧请求晚到的 409 与页面刷新、成功确认后重启仍在
正确节点、最终节点双发竞态只完成一次且重启后仍只有一次完成结果；预计用时覆盖默认 30 分钟、
指定时长（45 分钟）写入与查询且刷新后按同一结束时刻继续、非法时长启动前拦截且服务端无演练、
以及注入可控时钟后页面从“剩余时间”切换为“已超出预计”并仍能完成全部三步确认。

## 目录结构

```
.
├── backend/            FastAPI 应用、SQLite 访问层、pytest
│   ├── app/main.py     状态机与单事务 compare-and-set、预计用时与 UTC 时间基准
│   ├── app/database.py 单表单行 drill(id=1)，可重复执行的字段迁移
│   └── tests/
├── frontend/           React + TS + Vite、Vitest、Playwright
│   ├── src/            api.ts（真实 /api 调用）、App.tsx、Timer.tsx、types.ts
│   └── tests/{unit,e2e}/
├── docker-compose.yml  仅 web、api 长驻 + verify 一次性服务
├── Dockerfile.verify   verify 服务镜像（Playwright 官方镜像 + Python venv）
└── verify.sh           verify 容器内执行的验收编排
```
