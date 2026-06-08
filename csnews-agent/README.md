<div align="center">

# 🔧 CSNEWS Agent · Worker

**主 Worker 部署文档 · Cloudflare Workers + Supabase + R2**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kzclaw/csnews-agent/tree/main/csnews-agent)

[![License](https://img.shields.io/github/license/kzclaw/csnews-agent?style=flat-square)](../../)
[![Code size](https://img.shields.io/github/languages/code-size/kzclaw/csnews-agent/csnews-agent/src?style=flat-square)](../../)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CF Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-v0.31-FF6B35?style=flat-square)](../../releases)
[![Cron](https://img.shields.io/badge/cron-hourly-2EA44F?style=flat-square&logo=clockify&logoColor=white)](#-定时任务)

</div>

---

## ✨ 核心机制

### 两层分离原则

| 层 | 存储位置 | 触发条件 | 用途 |
|---|---------|---------|------|
| **实时打分层** | Supabase | 每条新闻都要打分 | 话题簇积分 + 升级 / 裂变 |
| **去重存储层** | R2 | 仅「内容足够不同」才存 | 持久化存储，按相似度过滤 |

### 自生长三级制度

| 等级 | 触发条件 | 清理周期 |
|------|---------|---------|
| 🟢 **跟进** (follow) | 建簇即得 | 7 天无新相似新闻 |
| 🟡 **重要** (important) | 积分达到 3 / 6 / 9 | 14 天无新相似新闻 |
| 🔴 **爆炸** (explosive) | 积分达到 9 | 28 天无新相似新闻 |

> 数据库枚举：`['follow', 'important', 'explosive']`（与 `src/pull.ts` 的 `VALID_LEVELS` 同步）

---

## 🔌 API 接口

> 所有端点需 `Authorization: Bearer <BEARER_TOKEN>` 鉴权（除 CORS preflight）

### 通用 pull 端点（v0.31 KR0）

一个 `?action=pull` 端点覆盖所有读场景，**4 个 type × 13 个参数任意组合**：

```bash
# 最新 10 条新闻（summary 格式）
curl -H "Authorization: Bearer $TOKEN" \
  "https://REDACTED-INTERNAL-DOMAIN/?action=pull&type=news&limit=10&format=summary"

# 爆炸级话题（按 score 倒序）
curl -H "Authorization: Bearer $TOKEN" \
  "https://REDACTED-INTERNAL-DOMAIN/?action=pull&type=topics&level=explosive&order_by=score"

# 待裂变种子（KR0b 专用）
curl -H "Authorization: Bearer $TOKEN" \
  "https://REDACTED-INTERNAL-DOMAIN/?action=pull&type=fission-pending&limit=20"

# 仅 ID（最省流量）
curl -H "Authorization: Bearer $TOKEN" \
  "https://REDACTED-INTERNAL-DOMAIN/?action=pull&type=news&format=ids&limit=20"

# 最近 24h
curl -H "Authorization: Bearer $TOKEN" \
  "https://REDACTED-INTERNAL-DOMAIN/?action=pull&type=news&since=24h"
```

**13 个支持参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | enum | `news` / `topics` / `warnings` / `fission-pending` |
| `format` | enum | `summary` (默认) / `full` / `ids` |
| `limit` | int | 1-100 |
| `order` | enum | `asc` / `desc` (默认 desc) |
| `order_by` | enum | `created_at` / `score` / `severity` / `hot_score` / `last_active_at` |
| `level` | enum | `follow` / `important` / `explosive` |
| `category` | string | 分类（科技/财经/社会 等）|
| `since` | string | ISO 8601 或相对时间 (`24h` / `7d` / `30m`) |
| `until` | string | 同 since |
| `topic_id` | uuid | 按话题过滤 |
| `status` | enum | warnings 用 |
| `title_like` | string | 模糊匹配（v0.32 计划）|
| `select` | string | 自定义返回字段（v0.32 计划）|

### 其他端点

| Endpoint | Method | 说明 |
|----------|--------|------|
| `?action=process` | GET | 完整流程：评分→嵌入→查重→入库（cron 自动跑）|
| `?action=ping` | GET | 健康检查 |
| `?action=zaker-hot` | GET | 拉 ZAKER 热榜原始数据 |
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

- **频率**：每小时整点 UTC（北京时间 8:00, 9:00, 10:00, ...）
- **Handler**：`src/index.ts` 的 `async scheduled()`
- **替代历史**：
  - ~~macOS cron (2h, 2026-05 之前)~~
  - ~~GitHub Actions (失败：被 Cloudflare Bot Fight Mode 拦)~~
- **Free tier 限制**：每账号 5 个 cron，CPU 10ms/次（process 主要是 fetch 等待，不超）

### 本地测试 cron

```bash
# 启动 dev server（启用 scheduled handler）
wrangler dev --test-scheduled

# 另起 terminal 模拟 cron 触发
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"

# 返回结构化结果
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&format=json"
# { "outcome": "ok", "noRetry": false }
```

### CF 后台查看执行历史

Workers & Pages → csnews-agent → **Settings → Triggers → View events**
（保留最近 100 次调用）

---

## 🛠️ Viewer 工具

仓库 `tools/pull-viewer.html`（**gitignored**，本地用）：

```bash
open "/Users/.../csnews-agent/tools/pull-viewer.html"
```

**特性**：
- 1426 行单文件，零外部依赖
- Schema-driven 渲染：news / topics / warnings / fission-pending 各自专属 card
- 6 个快捷场景（最新 10 / 爆炸话题 / 警告 / 裂变待办 / ID 列表 / 24h）
- 收藏 + 历史（localStorage 持久化）
- cURL 复制（Token 脱敏）/ JSON 下载
- 深色 / 浅色主题切换
- URL + Token 首次填入后存 localStorage，永不外发

**为啥 gitignore**：
- HTML 默认值留空（不烤内部 API URL）
- 跨设备同步靠 iCloud，不靠 git
- 改 viewer 永远不触发 commit 噪音

---

## 🚀 部署

### 方式 1：GitHub Auto-Deploy（推荐）

`git push origin main` → CF 自动 build + deploy，无需手动操作。

**一次性配置**（5 分钟）：

1. **CF 后台** → Workers & Pages → Create → Import from Git
2. 选你的 fork → Build command 留空 → Deploy command: `cd csnews-agent && npx wrangler deploy`
3. **设置 Secrets**（Workers → Settings → Variables and Secrets）：
   ```
   BEARER_TOKEN          = 任意 64 字符 hex
   SUPABASE_URL          = 你的 Supabase project ID
   SUPABASE_SERVICE_KEY  = service_role key (能绕过 RLS, 慎存)
   ```
4. **创建 R2 bucket** `csnews-raw`
5. **跑 Supabase migrations**（`supabase/migrations/*.sql` 按文件时间戳顺序）
6. **Push 任意 commit** → CF 自动部署完成

### 方式 2：本地 wrangler

```bash
cd csnews-agent
npm install
wrangler login
wrangler deploy
```

### Secrets 设置（任选）

```bash
# 命令行
wrangler secret put BEARER_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY

# 或 CF 后台：Workers → Settings → Variables and Secrets
```

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
│   ├── pull.ts           # 通用 pull 端点 (v0.31)
│   ├── shared.ts         # Supabase / 通用工具
│   └── cf-types.d.ts     # Cloudflare Workers 类型声明
├── tools/
│   └── pull-viewer.html  # 本地 Viewer (gitignored)
├── wrangler.toml         # CF 配置 (含 cron triggers)
├── package.json          # typescript devDep
└── README.md             # 本文件
```

---

## 🛠️ 开发

### 类型检查

```bash
npx tsc --noEmit
```

### 本地 dev

```bash
wrangler dev                    # 普通 dev
wrangler dev --test-scheduled   # 含 cron 模拟
```

### Dry-run 部署

```bash
wrangler deploy --dry-run --outdir /tmp/bundle
```

---

## 📚 相关链接

- [📖 仓库根 README](../README.md)
- [📋 OKR 路线图](../tasks/csnews-agent-okr.md)
- [🔌 在线 Demo](https://REDACTED-INTERNAL-DOMAIN) （需要 Bearer Token）
- [☁️ Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [🗄️ Supabase 文档](https://supabase.com/docs)

---

## 📜 License

MIT © kzclaw🍤

---

<sub>kzclaw🍤 · Last updated 2026-06-08 · v0.31 + CF Cron Trigger</sub>
</div>
