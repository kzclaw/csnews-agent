<div align="center">

# 📰 CSNEWS Agent

**Cloudflare Workers + Supabase 上的中文新闻自生长系统**

Cloudflare Workers · Supabase · R2

[![License](https://img.shields.io/github/license/kzclaw/csnews-agent?style=flat-square)](./LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/kzclaw/csnews-agent?style=flat-square)](../../commits/main)
[![CF Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Auto Deploy](https://img.shields.io/badge/deploy-push%20to%20main-2EA44F?style=flat-square&logo=github-actions&logoColor=white)](#-快速部署)

**零 Token 成本 · CF 免费层 + Supabase 免费层 + R2 免费额度**

[🚀 快速部署](#-快速部署) · [📖 Worker 文档](./csnews-agent/README.md)

</div>

---

## ✨ 核心特性

- 🧠 **AI 驱动** — Workers AI `bge-m3` 1024 维向量嵌入 + 规则引擎评分
- 📊 **三级自生长** — 跟进 → 重要 → 爆炸，话题簇按热度自动升级
- 🔍 **向量查重** — 相似度阈值聚类，避免重复入库
- 💾 **零成本架构** — CF Workers / Supabase / R2 全免费层，月成本 **$0**
- ⏰ **自动运行** — GitHub push → CF 自动 deploy + 每小时 Cron Trigger
- 🔌 **通用读 API** — 单个端点 + 13 个参数任意组合
- 🖥️ **本地 Viewer** — 浏览器可视化拉数据，零部署、Token 存 localStorage

---

## 🏗️ 架构

```
                  ┌────────────────────────┐
                  │  Cloudflare Workers    │
                  │  ────────────────────  │
   外部新闻源 ───▶│  ?action=process      │──▶ Supabase (pgvector)
   (Cron 拉取)    │  评分→嵌入→查重→入库 │──▶ R2 (原始 JSON)
                  │  ?action=pull*        │──▶ 任何 HTTP 客户端
                  │  ⏰ Cron Trigger       │   (Viewer / 下游服务)
                  └────────────┬───────────┘
                               │ Webhook / Realtime
                               ▼
                       飞书 / 浏览器 / CLI
```

---

## 🚀 快速部署

### 方式 1：一键 fork → 自动 deploy

1. **Fork 仓库**到你自己的 GitHub
2. **CF Workers → Connect to Git**（一次性，5 分钟）：
   - Cloudflare Dashboard → Workers & Pages → Create → Import from Git
   - 选你的 fork → Build command 留空 → Deploy command: `cd csnews-agent && npx wrangler deploy`
3. **设置 Secrets**（CF 后台 → Workers → Settings → Variables and Secrets）：
   ```
   BEARER_TOKEN          = 任意 64 字符 hex (API 鉴权)
   SUPABASE_URL          = <your-supabase-project-id>
   SUPABASE_SERVICE_KEY  = <your-supabase-service-role-key>
   ```
4. **创建 R2 bucket** `csnews-raw`（CF 后台 → R2 → Create）
5. **执行 Supabase migrations**（`supabase/migrations/*.sql` 按时间戳顺序）
6. **Push 任意 commit** → CF 自动 build + deploy

> 后续所有 `git push origin main` 都会自动触发 deploy + cron 跑起来

### 方式 2：本地 wrangler

```bash
git clone https://github.com/kzclaw/csnews-agent.git
cd csnews-agent/csnews-agent
npm install
wrangler login
wrangler deploy
```

---

## 🛠️ Viewer（本地浏览器工具）

仓库 `csnews-agent/tools/pull-viewer.html`（**gitignored**，本地用）：

```bash
# 路径相对于仓库根
open csnews-agent/tools/pull-viewer.html
```

- 单文件 1426 行，零外部依赖
- Schema-driven 渲染（4 个数据源各自专属 card 样式）
- 快捷场景 + 收藏 + 历史
- cURL / JSON 复制下载
- 深色 / 浅色主题切换
- Token 存 localStorage，永不上传

---

## 🔌 API 接口

完整列表看 [csnews-agent/README.md](./csnews-agent/README.md)。**所有端点需 `Authorization: Bearer <BEARER_TOKEN>` 鉴权。**

| 端点 | 说明 |
|------|------|
| `?action=pull&type=news&limit=10` | 拉新闻（4 个 type × 13 个参数）|
| `?action=pull&type=topics&level=explosive` | 拉爆炸级话题 |
| `?action=pull&type=warnings` | 拉活跃警告 |
| `?action=pull&type=fission-pending` | 拉待处理种子 |
| `?action=process` | 完整流水线（评分→嵌入→查重→入库）|
| `?action=ping` | 健康检查 |
| `?action=diag` | Supabase 联调诊断 |

---

## 📁 仓库结构

```
.
├── README.md             # 本文件
├── csnews-agent/         # Worker 代码
│   ├── src/              # 主代码
│   ├── tools/            # 本地工具（gitignored）
│   ├── wrangler.toml     # CF 配置
│   └── README.md         # Worker 详细文档
└── supabase/             # 数据库迁移
    └── migrations/
```

---

## 📜 License

MIT

---

<sub>Last updated 2026-06-08 · Auto-deployed via Cloudflare Workers Builds</sub>
</div>
