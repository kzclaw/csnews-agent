<div align="center">

# 🔧 CSNEWS Agent · Worker

**主 Worker 部署文档 · Cloudflare Workers + Supabase + R2**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kzclaw/csnews-agent/tree/main/csnews-agent)

[![License](https://img.shields.io/github/license/kzclaw/csnews-agent?style=flat-square)](../../)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![vitest](https://img.shields.io/badge/vitest-313%20contracts-4DB899?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![CF Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cron](https://img.shields.io/badge/cron-hourly-2EA44F?style=flat-square&logo=clockify&logoColor=white)](#-定时任务)

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
| `?action=diag` | GET | Supabase 三表联调诊断 |
| `?action=list` | GET | 列出 R2 中的新闻（`?order=desc&limit=50`）|
| `?action=save` | POST | 手动存新闻到 R2 |

---

## ⏰ 定时任务

```toml
# wrangler.toml
[triggers]
crons = [ "0 * * * *" ]  # 每小时整点（UTC）跑 process
```

- **频率**：每小时整点 UTC
- **Handler**：`src/index.ts` 的 `async scheduled()`
- **Free tier 限制**：每账号 5 个 cron，CPU 10ms/次

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

### 方式 2：本地 wrangler

```bash
cd csnews-agent
npm install
wrangler login
wrangler deploy
```

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

---

## 📁 目录结构

```
csnews-agent/
├── src/
│   ├── index.ts          # 主 Worker + scheduled handler
│   ├── pull.ts           # 通用 pull 端点
│   ├── shared.ts         # Supabase / 通用工具
│   └── cf-types.d.ts     # CF Workers 类型声明
├── tools/
│   └── pull-viewer.html  # 浏览器本地 Viewer (HTML, 零依赖)
├── wrangler.toml         # CF 配置
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

<sub>Last updated 2026-06-08</sub>
</div>
