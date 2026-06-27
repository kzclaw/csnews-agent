<div align="center">

# 💥 CSNEWS Fission Worker

**裂变搜索 Worker · Cloudflare Workers + Workers AI + R2**

CSNEWS 主 Worker 的子 Worker，职责：扫描爆炸级话题，执行裂变流程。

[![License](https://img.shields.io/github/license/kzclaw/csnews-agent?style=flat-square)](../../)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CF Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cron](https://img.shields.io/badge/cron-6h-2EA44F?style=flat-square&logo=clockify&logoColor=white)](#-定时任务)

</div>

---

## ✨ 核心职责

每 6 小时扫描 **explosive + score=9** 的话题，执行裂变流程：

1. 查询主 Worker Supabase，筛选爆炸级高积分话题
2. 调用 Workers AI（LLM）生成多组搜索词 + 裂变报告
3. 将裂变报告写入 R2 bucket `csnews-raw/fission/`

---

## 🔌 API 端点

> 所有端点需 `Authorization: Bearer <BEARER_TOKEN>` 鉴权（`ping` / `health` 除外）

| 端点 | Method | 说明 |
|------|--------|------|
| `?action=ping` | GET | 健康检查（无需鉴权）|
| `?action=health` | GET | 详细健康状态（无需鉴权）|
| `?action=fission-manual` | GET | 手动触发裂变（用于调试）|

```bash
# 健康检查（无需 token）
curl "https://YOUR-WORKER.workers.dev/?action=ping"

# 手动触发裂变
curl -H "Authorization: Bearer $TOKEN" \
  "https://YOUR-WORKER.workers.dev/?action=fission-manual"
```

---

## ⏰ 定时任务

```toml
# wrangler.toml
[triggers]
# 每 6 小时触发一次
crons = [ "0 */6 * * *" ]
```

- **频率**：每 6 小时（UTC）
- **Handler**：`src/index.ts` 的 `async scheduled()`
- **CF Free Plan 限制**：每账号 5 个 cron（主 Worker 占 4 个，Fission 占 1 个）

---

## 🚀 部署

### GitHub Auto-Deploy（推荐）

`git push origin main` → CF 自动 build + deploy。

**一次性配置**（5 分钟）：

1. CF 后台 → Workers & Pages → Create → Import from Git
2. 选你的 fork → Build command 留空 → Deploy command: `npx wrangler deploy`
3. 配置文件中填 `csnews-fission/wrangler.toml`
4. 设置 Secrets（Workers → Settings → Variables and Secrets）

### Secrets 设置

```bash
wrangler secret put BEARER_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
```

> R2 bucket `csnews-raw` 和 KV namespace `AI_USAGE_KV` 在 `wrangler.toml` 中通过 ID 引用，**无需重复创建**，与主 Worker 共用同一账户级别的资源。

---

## 📁 目录结构

```
csnews-fission/
├── src/
│   ├── index.ts           # Worker 入口（fetch + scheduled）
│   ├── fission-trigger.ts # 裂变核心逻辑
│   ├── shared.ts          # Env 类型 + 共享工具
│   ├── auth.ts            # 请求鉴权
│   ├── utils.ts           # 通用工具函数
│   └── ai-budget.ts       # AI Neurons 用量追踪
├── wrangler.toml          # CF 配置
├── package.json
└── README.md
```

---

## 🛠️ 开发

```bash
npx tsc --noEmit                 # 类型检查
wrangler dev                     # 本地 dev
wrangler deploy --dry-run        # dry-run 部署
```

---

## 📚 相关链接

- [📖 仓库根 README](../../README.md)
- [📖 CSNEWS Agent Worker 文档](../csnews-agent/README.md)
- [🤖 AGENTS.md](./AGENTS.md) — AI Agent 接项目标准 context 文档

---

## 📜 License

MIT

---

<sub>Last updated 2026-06-28</sub>
</div>
