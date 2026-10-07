<div align="center">

# 🔧 CSNEWS Agent · Worker

**主 Worker 部署文档 · Cloudflare Workers + Supabase + R2**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kzclaw/csnews-agent/tree/main/csnews-agent)

[![License](https://img.shields.io/github/license/kzclaw/csnews-agent?style=flat-square)](../../)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![vitest](https://img.shields.io/badge/vitest-313%20contracts-4DB899?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![CF Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cron](https://img.shields.io/badge/cron-4%20triggers-2EA44F?style=flat-square&logo=clockify&logoColor=white)](#-定时任务)

</div>

---

## ✨ 核心机制

### 两层分离

| 层 | 存储位置 | 触发条件 | 用途 |
|---|---------|---------|------|
| **打分层** | Supabase | 每条新闻都要打分 | 话题簇积分 + 升级 |
| **去重存储层** | R2 | 仅「足够不同」才存 | 持久化 + 按相似度过滤 |

### 三级自生长

| 等级 | 触发条件 | 清理周期 |
|------|---------|---------|
| 🟢 **跟进** (follow) | 建簇即得 | 7 天无新相似新闻 |
| 🟡 **重要** (important) | 积分达到 3 / 6 / 9 | 14 天无新相似新闻 |
| 🔴 **爆炸** (explosive) | 积分达到 9 | 28 天无新相似新闻 |

---

## 🔌 API 接口

> 所有端点需 `Authorization: Bearer <BEARER_TOKEN>` 鉴权（除 CORS preflight）

### 通用 pull 端点

单端点 + 16 个参数任意组合：

```bash
# 替换 YOUR-WORKER.workers.dev 为你自己的 Worker URL

# 最新 10 条新闻
curl -H "Authorization: Bearer $TOKEN" \
  "https://YOUR-WORKER.workers.dev/?action=pull&type=news&limit=10&format=summary"

# 爆炸级话题（按 score 倒序）
curl -H "Authorization: Bearer $TOKEN" \
  "https://YOUR-WORKER.workers.dev/?action=pull&type=topics&level=explosive&order_by=score"

# 待处理种子
curl -H "Authorization: Bearer $TOKEN" \
  "https://YOUR-WORKER.workers.dev/?action=pull&type=fission-pending&limit=20"

# 仅 ID（最省流量）
curl -H "Authorization: Bearer $TOKEN" \
  "https://YOUR-WORKER.workers.dev/?action=pull&type=news&format=ids&limit=20"

# 最近 24h
curl -H "Authorization: Bearer $TOKEN" \
  "https://YOUR-WORKER.workers.dev/?action=pull&type=news&since=24h"
```

**16 个支持参数**：

| 参数 | 说明 |
|------|------|
| `type` | 必填。数据源，见下方「type 一览」|
| `format` | `summary` (默认) / `full` / `ids` |
| `limit` | 1-200（默认 20）|
| `offset` | 分页偏移量，默认 0 |
| `order` | `asc` / `desc` (默认 desc) |
| `order_by` | 排序字段，**可选值随 type 而异**，见下方「type 一览」|
| `level` | `follow` / `important` / `explosive` |
| `category` | 分类字符串 |
| `since` | ISO 8601 或相对时间 (`24h` / `7d` / `30m`) |
| `until` | 同 since |
| `topic_id` | 按话题过滤（须为 UUID）|
| `status` | `open` / `acknowledged` / `validated` / `dismissed` / `closed` |
| `event_stage` | `detected` / `confirmed` / `growing` / `hot` / `archived`（仅 `topics`）|
| `stage` | `emerging` / `growing` / `hot` / `mature` / `declining`（仅 `trends`）|
| `title_like` | 模糊匹配，最长 100 字符（仅 `news`）|
| `select` | 自定义返回字段，须为该 type 默认字段的子集 |

> 过滤参数按 type 白名单校验：当前 type 不支持的过滤参数会被**静默忽略**（只有 `type` / `order_by` 不合法会报错）。
> `fission_triggered` 代码里有解析入口，但没有任何 type 在白名单里开启它，实际不生效。

### type 一览

`type` 必填，当前支持 **9 种**。`order_by` 与过滤参数的白名单**逐 type 不同**：

| type | 数据来源 | `order_by` 可选值（**加粗** = 默认值）| 过滤参数 |
|------|---------|---------------------------|---------|
| `news` | `news_hotspots` 表 | **`created_at`** / `published_at` / `hot_score` / `score` / `updated_at` | `level` `category` `topic_id` `title_like` |
| `topics` | `topics` 表 | **`score`** / `last_active_at` / `created_at` / `updated_at` / `event_stage` | `level` `event_stage` |
| `warnings` | `warnings` 表 | **`severity`** / `created_at` / `updated_at` | `status` `topic_id` `level` |
| `fission-pending` | `topics` 衍生视图（`level='explosive'` 且 `score>=6`） | **`score`** / `last_active_at` / `event_stage` | 无 |
| `fission-reports` | `fission_reports` 表 + `topics` 标题回填 | **`triggered_at`** / `completed_at` / `fission_type` / `status` | `status` `topic_id` |
| `trends` | `trend_snapshots` 表 | **`velocity`** / `acceleration` / **`topic_score`** / `created_at` | `topic_id` `stage` |
| `knowledge` | `knowledge` 表 | **`created_at`** / `confidence` / `topic_id` | `topic_id` |
| `stats` | `news_hotspots` 表 | **`created_at`** | 无 |
| `entity` | R2 `entity-finalized.json`（非 Supabase） | **`last_seen`** / `confidence` / `mention_count` / `first_seen` | `category` |

- ⚠️ **`trends` 的 `order_by` 要写 `topic_score`，不是 `score`** —— `trend_snapshots` 表的分数列实名就是 `topic_score`，写 `score` 会被白名单拒掉。返回 JSON 里的字段名仍是 `score`（对外别名，内部映射到 `topic_score`）。
- `fission-reports` 的 `fission_type` 可以用作 `order_by`，但作为**过滤**参数当前未实现解析，传了不生效。
- `entity` 的 `category` 与 `level` 最终都映射到实体的 `type` 字段；`order_by` 用的是实体专属字段（`last_seen` / `confidence` / `mention_count` / `first_seen`）。

### 全部端点一览（29 个 `action`）

分派逻辑：`src/index.ts` 命中 `diag`，其余交给 `src/dispatch.ts` 的 if 链；未匹配的 action 返 `400 { error: "unknown action" }`。

| Endpoint | Method | 说明 |
|----------|--------|------|
| **查询** | | |
| `?action=pull&type=...` | GET | **通用查询端点**：9 种 type × 16 个参数任意组合，见上方「通用 pull 端点」|
| `?action=ping` | GET | 存活探针，返 `{ok, ts}`；不带 `action` 时的默认值。免鉴权 |
| `?action=health` | GET | 多维度健康检查（cron 时效 / Supabase 可达与行数 / R2 写入 / AI 预算等），聚合出整体 `status`。免鉴权 |
| `?action=list&prefix=&limit=&order=` | GET | 列 R2 下的新闻（`prefix` 默认 `news/zaker/`，`limit` 默认 50 上限 200，`order` 默认 desc）|
| `?action=content&id=<uuid>&format=text\|html\|json` | GET | 按 UUID 读单条新闻的正文/摘要（60 req/min 限流）。`format` 默认 `json` |
| `?action=logs&date=YYYY-MM-DD&hour=HH&limit=N` | GET | 读 R2 `logs/<date>/` 下的可观测性日志，`date` 省略即今天 |
| `?action=logs-diag` | GET | 读进程内 ring buffer 最近日志；需 `DEBUG_LOG_BUFFER=1`，否则返空数组 |
| `?action=trend&type=topics\|velocity\|acceleration` | GET | Trend Engine 话题趋势：活跃话题 / 速度比 / 加速度（支持 `since` `limit`，60 req/min）|
| `?action=knowledge&type=daily\|topic` | GET | Knowledge Engine 读 R2 knowledge 索引（`daily`）或单话题金句（`topic`，须带 `topic_id`），60 req/min |
| `?action=ai-usage` | GET | 读 `AI_USAGE_KV`，近 7 天 AI 用量按日期 / 模型 / L1-L6 分层聚合 |
| `?action=proxy&url=` | GET | 服务端抓取目标 URL 并用 Readability 抽取正文，返回 `text/html`（10s 超时，60 req/min）|
| **写入 / 触发** | | |
| `?action=process` | GET ⚠️写 | 完整流程：评分→嵌入→查重→入库（cron 每小时自动跑）|
| `?action=score&title=...` | GET | 规则引擎单条评分 + 分类；`ai=false` 跳过 AI 裂变报告 |
| `?action=classify&title=...` | GET ⚠️写 | bge-m3 语义分类。`type=` 可切换：`classify`（默认）/ `seeds` / `add-seed` / `remove-seed` / `review` / `reclassify`，其中后四个会持久化改 R2 |
| `?action=batch-score` | POST | 批量评分，JSON body `{ items: [{title, summary}], use_ai }` |
| `?action=save&title=&category=&score=&source=` | GET ⚠️写 | 手动写一条新闻到 R2 `news/<source>/<id>.json` |
| `?action=embed&text=...` | GET ⚠️写 | bge-m3 向量（返维度与前 5 维采样），并把完整向量写 R2 `embeddings/` |
| `?action=zaker-hot` | GET | 拉外部热榜原始数据（10s 超时）|
| `?action=tavily` | GET ⚠️写 | Tavily 新闻抓取。带 `query=` 为单次直查测试，不带则跑动态 query 链 |
| `?action=fission&seed=` | GET ⚠️写 | AI 生成 5 条裂变搜索词；R 低于阈值直接跳过，L5 预算超限则写 degraded 占位到 R2 |
| `?action=rescore` | GET ⚠️写 | 语义重分类。**默认 `dry_run=true` 只统计不写库**，须显式 `dry_run=false` 才 UPDATE `news_hotspots`；`limit` 默认 100 |
| `?action=entity&type=...` | GET ⚠️写 | Entity Engine 实体管理，`type` 11 选 1：`candidates`（默认）/`selflearn`/`process`/`finalized`/`noise`/`noise-anchors`/`approve`/`reject`/`noise-add`/`noise-remove`/`reclassify`。除读类外均会改 R2 |
| `?action=event&type=...` | GET ⚠️写 | Event Graph 事件图谱，`type` 5 选 1：`clusters`（默认）/`cluster`/`process`/`review`/`threshold`。`cluster` `process` `review` 会跑聚类并微调阈值 |
| `?action=feedback-check` | GET ⚠️写 | 手动同步跑一轮分类反馈闭环（cron 每日 04:00 自动跑），会改写分类结果 |
| `?action=diag` | GET ⚠️写 | 诊断端点：向 Supabase 插入测试 topic / news / 关联行再回报各步状态 —— **会留测试数据** |
| **调试 / 测试** | | |
| `?action=model-test` | GET | 调一次 Workers AI LLM 验证模型连通性（消耗额度）。免鉴权 |
| `?action=ai-test&title=...` | GET | 固定按 9.0 分跑一次裂变报告，用于验证 AI 评分链路 |
| `?action=mcp-list` | GET | 列出 MCP 工具定义（`tools/list` 的 JSON-RPC 形状）|
| **MCP** | | |
| `?action=mcp` | **POST** | MCP JSON-RPC 端点，处理 `tools/list` 与 `tools/call` |

> ⚠️ **Method 列是推荐用法，不是代码强制**：只有 `?action=mcp` 校验 method（非 POST 返 405），`?action=batch-score` 必须走 POST 才能带 JSON body；其余端点代码不读 method，GET / POST 都能命中。
>
> ⚠️ **⚠️写 = 会改动生产数据**（R2 或 Supabase）。`process` `save` `embed` `diag` `feedback-check` 以及 `entity` / `event` / `classify` 的写类 `type` 都会落盘，调用前请确认。
>
> 免鉴权的只有 `ping` `health` `model-test` 三个（`src/index.ts` 的 `PUBLIC_ACTIONS`）；其余都需要 `Authorization: Bearer <BEARER_TOKEN>`。

---

## ⏰ 定时任务

```toml
# wrangler.toml
[triggers]
# 4/5 cron 槽位（CF Free Plan 上限 5，剩余 1 槽位供 fission worker）
# 0 * * * *          → scheduledProcess: ZAKER + Tavily + knowledge（每小时整点 UTC）
# 0 3,15 * * *      → scheduledEntity: entity selflearn + event clustering（每日 03:00 & 15:00 UTC）
# 0 4 * * *         → scheduledFeedback: feedback loop（每日 04:00 UTC）
# 0 0 * * *         → scheduledReset: AI_USAGE_KV 日计数器清零（每日 00:00 UTC）
crons = [
  "0 * * * *",      # 每小时整点 UTC
  "0 3,15 * * *",   # 每日 03:00 & 15:00 UTC
  "0 4 * * *",      # 每日 04:00 UTC
  "0 0 * * *"       # 每日 00:00 UTC
]
```

- **Handler**：`src/index.ts` 的 `async scheduled()`
- **Free tier 限制**：每账号 5 个 cron，CPU 10ms/次（主 Worker 占 4 个，Fission Worker 占 1 个）
- ⚠️ **不要新增第 5 条主 Worker cron** —— CF Free tier 账户上限 5，本 Worker 已占 4 个、Fission 占 1 个，加任何新 cron 部署必失败

### 本地测试 cron

```bash
wrangler dev --test-scheduled
# 另起 terminal 模拟 cron (按 wrangler dev 暴露的 scheduled 路由访问)
curl "<wrangler-dev-url>/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
```

---

## 🛠️ Viewer 工具

仓库 `tools/pull-viewer.html`（已入库，浏览器本地工具）：

```bash
# 路径相对于仓库根
open tools/pull-viewer.html
```

**特性**：
- 1487 行单文件，零外部依赖
- Schema-driven 渲染
- 7 个快捷场景 + 收藏 + 历史
- cURL 复制（Token 脱敏）/ JSON 下载
- 深色 / 浅色主题切换
- Worker URL + Bearer Token 存浏览器 `localStorage`，不发送到任何地方

---

## 🚀 部署

### 方式 1：GitHub Auto-Deploy（推荐）

`git push origin main` → CF 自动 build + deploy。

**一次性配置**（5 分钟）：

1. CF 后台 → Workers & Pages → Create → Import from Git
2. 选你的 fork → Build command 留空 → Deploy command: `cd csnews-agent && npx wrangler deploy`
3. 设置 Secrets（Workers → Settings → Variables and Secrets）
4. 创建 R2 bucket `csnews-raw`
5. 跑 Supabase migrations
6. Push 任意 commit → 部署完成

### Secrets 设置

```bash
wrangler secret put BEARER_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
```

或 CF 后台 → Workers → Settings → Variables and Secrets

### R2 Bucket

```bash
wrangler r2 bucket create csnews-raw
```

### KV Namespace（AI Budget Tracking）

```bash
wrangler kv namespace create AI_USAGE_KV
# 输出: { id: "xxxxxxxx" }
```

`wrangler.toml` 里的 `id = "YOUR_NAMESPACE_ID"` 需要替换成真实 ID。

---

## 📁 目录结构

```
csnews-agent/
├── src/
│   ├── index.ts              # Worker 入口 + dispatch
│   ├── dispatch.ts          # action 分发
│   ├── shared.ts             # Supabase / R2 / 通用工具
│   ├── cf-types.d.ts         # CF Workers 类型声明
│   ├── types.ts              # 共享类型
│   ├── types-supabase.ts     # DB 类型
│   ├── endpoints.ts          # action handler 路由
│   ├── endpoints-core.ts     # 12 个 action handler（core）
│   ├── endpoints-process.ts  # process/health/ai-usage/logs
│   ├── endpoints-trend.ts    # trend/knowledge/content
│   ├── endpoints-entity.ts  # entity/event
│   ├── score.ts              # 评分规则
│   ├── classify.ts           # 分类规则
│   ├── news-process.ts       # News Self Growth 核心
│   ├── scheduled.ts          # 4 个 cron handler
│   ├── feedback.ts           # Feedback Loop
│   ├── entity-selflearn.ts   # Entity selflearn
│   ├── entity-process.ts     # Entity process
│   ├── event-process.ts     # Event clustering
│   ├── log.ts                # structured logging
│   ├── pull.ts               # 通用 pull 端点
│   └── [health-*, ai-*, process-*, etc.]  # 细分模块
├── tools/
│   └── pull-viewer.html      # 浏览器本地 Viewer (HTML, 零依赖)
├── wrangler.toml              # CF 配置
├── package.json
└── README.md
```

---

## 🛠️ 开发

```bash
npx tsc --noEmit                 # 类型检查
wrangler dev                     # 本地 dev
wrangler dev --test-scheduled    # 含 cron 模拟
wrangler deploy --dry-run        # dry-run 部署
```

---

## 📚 相关链接

- [📖 仓库根 README](../README.md)
- [🤖 AGENTS.md](./AGENTS.md) — AI Agent 接项目标准 context 文档
- [☁️ Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [🗄️ Supabase 文档](https://supabase.com/docs)

---

## 📜 License

MIT

---

<sub>Last updated 2026-10-07</sub>
</div>
