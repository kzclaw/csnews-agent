<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

## CSNEWS Agent · Project facts (2026-06-08)

### GitHub Auto-Deploy 已配（commit `52043de`）
- 仓库 `kzclaw/csnews-agent` 已配 **CF Workers GitHub auto-deploy**
- **`git push origin main` → CF 自动 build + deploy Worker**，无需手动 `wrangler deploy`
- 不要建议用户"本地 wrangler deploy" — 那是过去式，现在 push 就是 deploy
- 看部署结果：CF 后台 → Workers & Pages → csnews-agent → **Deployments** tab

### 仓库结构（monorepo）
- 仓库根是 `GitHub/`（在 iCloud Drive 第二大脑路径下）
- 真正的 Worker 代码在子目录 `csnews-agent/` 里
- 顶层文件：`.gitignore`, `README.md`, `csnews-agent/`, `supabase/`, `AGENTS.md`
- **不要把 `.github/workflows/` 放在 `csnews-agent/.github/`** — 仓库根的 `.github/workflows/` 才被识别（2026-06-08 踩过坑）

### 域名安全
- 内部域名（**不写入 README / 不写入 commit message / 不写入 OKR 文档**）
- 域名开 **Cloudflare Bot Fight Mode**
- 拦截 Azure / AWS / GCP 数据中心 IP（包括 GitHub Actions runner）
- **Worker → 自家域名走 CF 内部 routing，不被 Bot Fight Mode 拦**
- 外部服务（GitHub Actions、curl from datacenter）会被拦
- 之前误用 GH Actions 调 `?action=process` 失败 = Bot Fight Mode 拦截

### 定时任务
- ~~Mac cron~~ (`~/.kzopenclaw/.../run-csnews.sh`, 2h) — 待清理
- ~~GitHub Actions workflow~~ — 已删（commit `6fb9a47`）
- **CF Workers Cron Trigger** (commit `6fb9a47`, 频率 `0 * * * *` UTC 每小时整点)
  - 配置文件：`csnews-agent/wrangler.toml` 的 `[triggers]` 块
  - Handler：`csnews-agent/src/index.ts` 的 `async scheduled()`
  - Free tier 限制：每账号 5 个，CPU 10ms/次（process 主要是 fetch 等待，不超）

### Worker 端点
- `?action=pull&type=news|topics|warnings|fission-pending` — 读端点（KR0 v0.31，commit `bd19627`）
- `?action=process` — 拉 ZAKER + 评分 + 入库（KR0c/KR0d）

### 项目代号（不写进任何公开文档）
- 仓库：kzclaw/csnews-agent
- Worker：csnews-agent
- 内部域名：**不在公开文档出现**（之前 OKR 文档已记过，不重复）
- kzclaw本机 Mac，kzclaw 团队是独立项目（不归 mavis 管辖）
