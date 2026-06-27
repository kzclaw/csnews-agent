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

单端点 + 13 个参数任意组合：

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

**13 个支持参数**：

| 参数 | 说明 |
|------|------|
| `type` | `news` / `topics` / `warnings` / `fission-pending` |
| `format` | `summary` (默认) / `full` / `ids` |
| `limit` | 1-100 |
| `order` | `asc` / `desc` (默认 desc) |
| `order_by` | `created_at` / `score` / `severity` / `hot_score` / `last_active_at` |
| `level` | `follow` / `important` / `explosive` |
| `category` | 分类字符串 |
| `since` | ISO 8601 或相对时间 (`24h` / `7d` / `30m`) |
| `until` | 同 since |
| `topic_id` | 按话题过滤 |
| `status` | warnings 用 |
| `title_like` | 模糊匹配 |
| `select` | 自定义返回字段 |

### 其他端点

| Endpoint | Method | 说明 |
|----------|--------|------|
| `?action=process` | GET | 完整流程：评分→嵌入→查重→入库（cron 自动跑）|
| `?action=ping` | GET | 健康检查 |
| `?action=zaker-hot` | GET | 拉外部热榜原始数据 |
| `?action=score&title=...` | GET | 规则引擎单条评分 |
| `?action=batch-score` | POST | 批量评分（JSON body）|
| `?action=embed&text=...` | GET | bge-m3 1024 维向量输出 |
| `?action=list` | GET | 列出 R2 中的新闻（`?order=desc&limit=50`）|
| `?action=save` | POST | 手动存新闻到 R2 |
| `?action=content&id=xxx&format=json` | GET | 读取 R2 中新闻全文（?action=knowledge 索引读取也走此端点）|
| `?action=trend&type=topics\|velocity\|acceleration&since=24h` | GET | Trend Engine 话题趋势分析 |
| `?action=knowledge` | GET | Knowledge Engine（R2 knowledge/ 索引读取）|
| `?action=entity&type=selflearn\|process\|noise-filter` | GET | Entity Engine 实体管理 |
| `?action=event&type=clusters\|cluster\|process\|review\|threshold` | GET | Event Graph 事件图谱 |
| `?action=logs&date=YYYY-MM-DD&hour=HH&limit=N` | GET | 可观测性日志查询 |
| `?action=classify&title=...&category=...` | GET | 分类规则单独调用 |
| `?action=diag` | GET | 诊断端点（Supabase 读写测试）|

---

## ⏰ 定时任务

```toml
# wrangler.toml
[triggers]
# 4/5 cron 槽位（CF Free Plan 上限 5，剩余 1 槽位供 fission worker）
# 0 0 * * *         → scheduledProcess: ZAKER + Tavily + knowledge（每日 00:00 UTC）
# 0 3,15 * * *      → scheduledEntity: entity selflearn + event clustering（每日 03:00 & 15:00 UTC）
# 0 4 * * *         → scheduledFeedback: feedback loop（每日 04:00 UTC）
# 0 1 1 * *         → scheduledArchiveOldEntities: 30d+ 归档（每月 1 号 01:00 UTC）
crons = [
  "0 0 * * *",      # 每日 00:00 UTC
  "0 3,15 * * *",   # 每日 03:00 & 15:00 UTC
  "0 4 * * *",      # 每日 04:00 UTC
  "0 1 1 * *"       # 每月 1 号 01:00 UTC
]
```

- **Handler**：`src/index.ts` 的 `async scheduled()`
- **Free tier 限制**：每账号 5 个 cron，CPU 10ms/次（主 Worker 占 4 个，Fission Worker 占 1 个）

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

<sub>Last updated 2026-06-28</sub>
</div>
