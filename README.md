<div align="center">

# 📰 CSNEWS Agent

**中文热点智能自生长系统 · News Self-Growth on Edge**

Cloudflare Workers · Supabase · R2

[![License](https://img.shields.io/github/license/kzclaw/csnews-agent?style=flat-square)](./LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/kzclaw/csnews-agent?style=flat-square)](../../commits/main)
[![CF Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/version-v0.31-FF6B35?style=flat-square)](../../releases)
[![Auto Deploy](https://img.shields.io/badge/deploy-push%20to%20main-2EA44F?style=flat-square&logo=github-actions&logoColor=white)](#-快速部署)

**零 Token 成本 · CF 免费层 + Supabase 免费层 + R2 免费额度**

[🚀 快速部署](#-快速部署) · [📖 Worker 文档](./csnews-agent/README.md) · [📋 OKR 路线图](./tasks/csnews-agent-okr.md) · [🔌 在线 Demo](https://REDACTED-INTERNAL-DOMAIN)

</div>

---

## ✨ 核心特性

- 🧠 **AI 驱动** — Workers AI `bge-m3` 1024维向量嵌入 + 规则引擎评分
- 📊 **三级自生长** — 跟进 → 重要 → 爆炸，话题簇按热度自动升级
- 🔍 **向量查重** — 0.88 相似度阈值聚类，避免重复入库
- 💾 **零成本架构** — CF Workers / Supabase / R2 全免费层，月成本 **$0**
- ⏰ **自动运行** — GitHub push → CF 自动 deploy + 每小时 Cron Trigger
- 🔌 **通用 API** — 1 个 `?action=pull` 端点覆盖所有读场景（v0.31 KR0）
- 🖥️ **本地 Viewer** — 浏览器可视化拉数据，零部署、Token 存 localStorage

---

## 🏗️ 架构

```
                  ┌────────────────────────┐
                  │  Cloudflare Workers    │
                  │  ────────────────────  │
   ZAKER 热榜 ───▶│  ?action=process      │──▶ Supabase (pgvector)
   (每 1h cron)   │  评分→嵌入→查重→入库 │──▶ R2 (原始 JSON)
                  │  ?action=pull* (v0.31)│──▶ 任何 HTTP 客户端
                  │  ⏰ Cron Trigger       │   (Viewer / 下游服务)
                  └────────────┬───────────┘
                               │ Webhook / Realtime
                               ▼
                       飞书 / 浏览器 / CLI
```

**4 步流水线**：拉新闻 → 规则评分 → 向量聚类 → 入库（Supabase 主 + R2 去重）

---

## 📊 项目状态

| KR | 模块 | 状态 | 关键能力 |
|----|------|------|---------|
| **KR0** | 通用 pull 端点 (v0.31) | ✅ 完成 | 1 个 `?action=pull` 覆盖 news/topics/warnings/fission-pending |
| **KR0** | topic_key 中文兼容 | ✅ 完成 | hashStr 替代 slice，CR/SUP 共用 |
| **KR0** | list 排序修复 | ✅ 完成 | `?order=desc&limit=N` 修 R2 字典序坑 |
| **KR0** | trend snapshot 可观测 | ✅ 完成 | `record_trend_snapshot` 错误不再吞 |
| **KR0b** | Fission Worker | 🔜 待做 | 接 `?action=fission-pending` 端点 |
| **KR0** | AI 评分闭环 | 🔜 待做 | 50 条误差 < 15% 阈值验证 |
| **KR-Realtime** | Supabase Realtime | 📋 计划 | Viewer 自动刷新 + 爆炸级桌面通知 |

---

## 🚀 快速部署

### 一键 fork → push → 自动 deploy

1. **Fork 仓库**到你自己的 GitHub
2. **CF Workers → Connect to Git**（一次性，5 分钟）：
   - Cloudflare Dashboard → Workers & Pages → Create → Import from Git
   - 选你的 fork → Build command 留空 → Deploy command 填 `cd csnews-agent && npx wrangler deploy`
3. **设置 Secrets**（CF 后台 → Workers → Settings → Variables and Secrets）：
   ```
   BEARER_TOKEN          = 任意 64 字符 hex (API 鉴权)
   SUPABASE_URL          = REDACTED-SUPABASE-PROJECT-ID (你的 Supabase project ID)
   SUPABASE_SERVICE_KEY  = eyJhbGc... (service_role key)
   ```
4. **创建 R2 bucket** `csnews-raw`（CF 后台 → R2 → Create）
5. **执行 Supabase migrations**（`supabase/migrations/*.sql` 顺序跑）
6. **Push 任意 commit** → CF 自动 build + deploy

> **零手动运维**：cron trigger + 鉴权 + R2 binding + secrets 都在配置里搞定。

### 本地开发

```bash
git clone https://github.com/kzclaw/csnews-agent.git
cd csnews-agent/csnews-agent
npm install
wrangler dev --test-scheduled   # 含 cron 模拟
# 另起一个 terminal 测试 cron
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
```

---

## 🛠️ 工具

### Viewer（本地浏览器可视化）

仓库 `csnews-agent/tools/pull-viewer.html`（**gitignored**，本地用）：

```bash
open "/Users/.../csnews-agent/tools/pull-viewer.html"
```

- 1426 行单文件，零依赖
- Schema-driven 渲染（4 个 type 各自专属 card 样式）
- 6 个快捷场景 + 收藏 + 历史
- cURL / JSON 复制下载
- 深色 / 浅色主题切换
- Token 存 localStorage，不入 git

---

## 🔌 端点速查

> 完整列表看 [csnews-agent/README.md](./csnews-agent/README.md)

| Endpoint | 说明 |
|----------|------|
| `?action=pull&type=news&limit=10` | 最新 10 条新闻（v0.31）|
| `?action=pull&type=topics&level=explosive` | 爆炸级话题（v0.31）|
| `?action=pull&type=warnings` | 活跃警告（v0.31）|
| `?action=pull&type=fission-pending` | 待裂变种子（v0.31）|
| `?action=process` | 完整流水线（评分→嵌入→查重→入库）|
| `?action=ping` | 健康检查 |
| `?action=diag` | Supabase 三表联调诊断 |

支持 13 个参数任意组合：`type` / `format` / `limit` / `order` / `order_by` / `level` / `category` / `since` / `until` / `title_like` / ...

---

## 📁 仓库结构

```
.
├── AGENTS.md                  # 项目 facts (Mavis 维护)
├── README.md                  # 本文件
├── csnews-agent/              # Worker 代码
│   ├── src/                   # index.ts / pull.ts / shared.ts
│   ├── tools/pull-viewer.html # 本地 Viewer (gitignored)
│   ├── wrangler.toml          # CF 配置 (含 cron triggers)
│   └── README.md              # Worker 详细文档
├── supabase/
│   └── migrations/            # PostgreSQL schema 演进
└── tasks/
    └── csnews-agent-okr.md    # OKR 路线图
```

---

## 📚 文档

- [📖 Worker 详细 README](./csnews-agent/README.md) — 部署、API、cron、Viewer
- [📋 OKR 路线图](./tasks/csnews-agent-okr.md) — KR0-12 + Realtime 计划
- [🔌 在线 Demo](https://REDACTED-INTERNAL-DOMAIN) — 真实环境 (Bearer Token 必需)

---

## 🛣️ 路线图

| 阶段 | 目标 | 状态 |
|------|------|------|
| H1 | Workers AI 中文分类 70% | ✅ |
| M0 | embedding + 向量查重 | ✅ |
| M0 | 通用 pull API + Viewer | ✅ v0.31 |
| M0 | Fission Worker + AI 评分 | 🔜 进行中 |
| M0 | Supabase Realtime 实时推送 | 📋 计划 |

---

## 📜 License

MIT © kzclaw🍤

---

<sub>kzclaw🍤 · Last updated 2026-06-08 · Auto-deployed via Cloudflare Workers Builds</sub>
</div>
