# AGENTS.md · CSNEWS Agent

> **面向**: AI Agent 接 csnews-agent 项目时的标准 context 文档
> **状态**: Spec Kit 6 章节标准 (Spec Kit 6 章节标准 · v0.36.9 实施)
> **维护**: agent 接项目时第一份必读文档

---

## 1. Project Purpose (项目目的)

**CSNEWS Agent** 是一个 **TIE-Lite (Trend Insight Engine Lite)** 平台的主 Worker,把社会热点新闻(原始事实)自动累积成"洞察"(趋势 / 模式 / 异常信号)。

**解决什么问题**:
- 传统新闻 App 只给单条新闻,不给"社会结构正在发生什么变化"的高层洞察
- 早晨日报金句场景: 起床 1 个 GET 拿"今天应该关注什么"
- 替代手工刷新闻 + 手工整理,实现自动化知识累积

**核心价值**:
- **打分层** (Supabase): 每条新闻打分 → 话题簇积分 → 升级 (follow / important / explosive)
- **去重存储层** (R2): 仅"足够不同"才存 → 持久化 + 按相似度过滤
- **趋势累积** (v0.30.1+): 每小时快照 → 算 velocity + acceleration + z-score 异常
- **知识引擎** (v0.36.7+): 跨日累积 → 早晨日报金句入口

---

## 2. Tech Stack (技术栈)

### 主技术
- **Cloudflare Workers** (`csnews-agent`): 主 Worker + scheduled handler (每整点 UTC 跑 process)
- **Supabase** (PostgREST): 8 张表 (news_hotspots / topics / news_topic_members / trend_snapshots / warnings / fission_searches + 2 张 R2 元数据)
- **R2 Bucket** (`csnews_raw`): 新闻全文 / fission 报告 / trend snapshots / warnings / logs / embeddings / knowledge (v0.36.7+)
- **Workers AI**:
  - `bge-m3` 1024 维向量 (中文新闻查重)
  - `llama-3-8b-instruct` (KR0b 裂变报告生成)
- **TypeScript 5.3** + **Vitest 4.1.8** (业务契约验证)

### KV
- `PROCESS_STATE`: rate limit + daily hits counter + last_process_at 持久化

### 部署
- **GitHub Auto-Deploy**: `git push origin main` → CF 自动 build + deploy (无需手动 wrangler deploy)
- **Cron Trigger**: `[triggers] crons = [ "0 * * * *" ]` 每小时整点 (UTC) 跑 process
- **本地测试**: `wrangler dev --test-scheduled` (含 cron 模拟)

### 第三方 API
- **ZAKER**: `https://skills.myzaker.com/api/v1/article/hot` (新闻原始数据)

---

## 3. Project Structure (项目结构)

```
csnews-agent/
├── src/
│   ├── index.ts             # 主 Worker (default export fetch + scheduled handler)
│   ├── endpoints.ts         # 16 个 action=xxx handler (pull / trend / knowledge / content / health / ...)
│   ├── auth.ts              # 鉴权 + CORS 中间件
│   ├── shared.ts            # Env 接口 + supabaseFetch wrapper + getSupabaseHost + safeJson
│   ├── pull.ts              # 通用 pull 端点 (4 个 type: news/topics/warnings/fission-pending)
│   ├── news-process.ts      # News Self Growth 8 个核心函数 (T000 抽出来)
│   ├── score.ts             # 评分规则 (hashStr + 3 路由常量 + scoreRule)
│   ├── classify.ts          # 分类规则 (classify / classifyByAI / classifyRule)
│   ├── content-validation.ts  # content 端点校验 (KR0 v0.36.6)
│   ├── trend-validation.ts   # trend 端点校验 (KR0 v0.36.7)
│   ├── knowledge-validation.ts  # knowledge 端点校验 (KR0 v0.36.7)
│   ├── zscore.ts            # z-score 异常检测 utility (KR0+1 v0.36.8)
│   ├── log.ts               # R2 log 写入 (ctx.waitUntil 异步持久化)
│   ├── utils.ts             # extractText + maybeFissionReport helper (T000)
│   ├── types.ts             # NewsItem 等共享类型
│   └── cf-types.d.ts        # CF Workers 类型声明
├── validate/                 # 业务契约验证 (vitest, 9 个 contract 文件)
│   ├── _placeholders.contract.ts
│   ├── _structure.contract.ts
│   ├── classify.contract.ts
│   ├── content.contract.ts
│   ├── knowledge.contract.ts
│   ├── log.contract.ts
│   ├── pull.contract.ts
│   ├── score.contract.ts
│   ├── trend.contract.ts
│   └── zscore.contract.ts
├── tools/
│   └── pull-viewer.html     # 本地 Viewer (gitignored)
├── wrangler.toml             # CF 配置 (cron + bindings + secrets)
├── vitest.config.ts          # 业务契约验证配置 (validate/**/*.contract.ts)
├── tsconfig.json
├── package.json
├── AGENTS.md                 # ← 本文件 (Spec Kit 标准)
└── README.md                 # 公开文档
```

**模块化原则** (v0.33+sweep 原则 #2):
- 16 个 handler 全部在 `endpoints.ts`
- 校验逻辑独立抽到 `*-validation.ts` (可独立测)
- 核心业务函数独立抽到 `news-process.ts` / `score.ts` / `classify.ts`
- utility 独立抽到 `utils.ts` / `zscore.ts`

---

## 4. Development Workflow (开发流程)

### 4 步铁律 (v0.33 确定)
**每一次修改必须走 4 步,缺一不可**:

1. **OKR 规划段** (csnews-agent-okr.md changelog 表): 写"规划中 v0.36.X" + 触发 / 范围 / 确定依据 / 预估 commit 数
2. **改 + 编译 + 5 重安全网**:
   - tsc 0 error (`npx tsc --noEmit`)
   - vitest 全绿 (`npx vitest run`)
   - dry-run 包大小 (`npx wrangler deploy --dry-run --outdir=dist`)
   - privacy 0 命中 (grep 真名 / 花名 / OKR 编号 / 内部代号)
   - 6 场景端到端实测 (push 后 curl 实测)
3. **commit + push** (`git push origin main`): CF auto-deploy 自动触发
4. **OKR 完成段同步**: changelog 改"完成" + 体系总览表对应 O/KR row 更新

### Spec Kit L1 4 步 (5 条跨项目约定 #2)
- **L1 SPEC 文档**: 任何新 KR 启动时写 spec.md
- **L1 PLAN 文档**: 写 plan.md (技术路线 / 风险 / 备选)
- **L1 TASKS 文档**: 写 tasks.md (具体任务列表)
- **L1 IMPLEMENT**: 实施 + 5 重安全网

### 7 层信息模型 (KR0 v0.36.7)
- News → Signal → Entity → Event → Topic → Trend → Macro Shift
- 当前实施: News / Topic / Trend (✅), Signal / Event (⏳ 规划), Entity / Event Graph (❌ 未开始), Macro Shift (⏸️ 远期)

### 命令速查
```bash
# 类型检查
npx tsc --noEmit

# 业务契约验证
npx vitest run                       # 全跑
npx vitest run validate/score.contract.ts  # 单文件
npx vitest run --coverage            # 覆盖率

# 部署
npx wrangler deploy --dry-run        # dry-run
npx wrangler dev                     # 本地 dev
npx wrangler dev --test-scheduled    # 含 cron 模拟

# Git 部署
git push origin main                 # CF auto-deploy
```

---

## 5. Conventions (开发约定)

### 5.1 OKR 编号驱动 (跨项目约定 #1)
- 所有 KR 编号 (KR0 / KR0 / ... / KR0) 必须在 OKR 文档登记
- 体系总览表 12 O 表是项目状态快照
- changelog 表是历史记录

### 5.2 Spec Kit 工作流 (跨项目约定 #2)
- 任何新 KR 启动前先 L1 SPEC 4 步
- 详见5 条跨项目约定 (跨 session 适用)

### 5.3 三层思考 (跨项目约定 #3)
- L1 SPEC (外层框架)
- L2 GROW (Goal / Reality / Options / Will)
- L3 PDCA (Define / Verify / Redefine)

### 5.4 接口统一 (跨项目约定 #4)
- 所有 endpoint 通用模式: `?action=xxx&type=yyy&since=...&limit=...`
- type 白名单 + 独立 validation 文件
- 反爬限流 KV 独立 prefix (60 req/min)
- 大小限制 1MB
- CORS + Bearer Token 鉴权

### 5.5 隐私红线 (跨项目约定 #5)
- **公开仓库 (kzclaw/csnews-agent)**: 0 真名 / 0 OKR 编号 / 0 内部代号
- **commit message**: 通用"做了什么"描述,不写"在 KR0 Phase0 T000 里做"
- **文件注释**: 写"功能描述 + 日期",不写"v0.XX+sweep·FT-KR\d+ · Phase\d · T\d\d\d"
- **隐私文档** (OKR / 7 层信息模型): 不入 git,只更新 OKR 引用

### 5.6 语言选型 (跨项目约定 #6)
- TypeScript 严格模式
- 中文变量名 / 注释 OK (项目习惯)
- 公开文档中文化 (README.md / AGENTS.md)

### 5.7 test vs validate (跨项目约定 #7)
- **test 派**: 测"代码这样写对不对" (依赖 mock,重构就挂)
- **validate 派**: 测"业务规则就是这样" (不依赖外部环境,契约稳定)
- csnews-agent 用 vitest + `validate/*.contract.ts` 模式

### 5.8 5 重安全网 (v0.36.5+ 确定)
**每一次修改必须过 5 重安全网**:
1. tsc 0 error (`npx tsc --noEmit`)
2. vitest 全绿 (`npx vitest run`)
3. dry-run 包大小 (`npx wrangler deploy --dry-run --outdir=dist`)
4. privacy 0 命中 (grep 真名 / 花名 / OKR 编号)
5. **6 场景端到端实测** (push 后 curl 实测) ← v0.36.5+ 确定必做

---

## 6. Appendix (附录)

### 6.1 项目代号备忘 (v0.33 确定)
- TIE-Lite = Trend Insight Engine Lite (TIE 简化版,12 O 母版蓝图)
- TIE V3 = 完整 TIE 蓝图 (csnews-agent 是 Lite 实施)
- News Self Growth = 打分 + 升级 + 裂变机制
- 7 层信息模型 = News / Signal / Entity / Event / Topic / Trend / Macro Shift

### 6.2 关键时间线
- v0.29: News Self Growth 基础机制
- v0.30.1: Trend snapshot 机制就位
- v0.33: OKR 重构 · TIE-Lite 视角 · 12 O 母版蓝图
- v0.33+sweep: 扫雷 4 KR (KR0 / KR0 / KR0 / KR0)
- v0.34 - v0.36.4: Bot Fight Mode + scheduled handler 修复链
- v0.36.5 mini: scheduled handler inline process (KR0)
- v0.36.6: R2 全文内容读取端点 (KR0)
- v0.36.7: Trend topic velocity (KR0) + Knowledge Engine (KR0)
- v0.36.8: z-score 异常检测 (KR0+1)
- v0.36.9: AGENTS.md 改造 (KR0)

### 6.3 端点清单 (16 个 action=xxx)
| Action | 端点 | KR |
|---|---|---|
| `pull` | `?action=pull&type=news\|topics\|warnings\|fission-pending` | KR0 |
| `diag` | `?action=diag` | 基础 |
| `ping` | `?action=ping` | 基础 |
| `model-test` | `?action=model-test` | 基础 |
| `ai-test` | `?action=ai-test&title=...` | 基础 |
| `score` | `?action=score&title=...` | KR0 |
| `classify` | `?action=classify&title=...` | KR0 |
| `batch-score` | `?action=batch-score` (POST) | KR0 |
| `fission` | `?action=fission` | KR0b |
| `save` | `?action=save` (POST) | 基础 |
| `list` | `?action=list` | 基础 |
| `embed` | `?action=embed&text=...` | 基础 |
| `zaker-hot` | `?action=zaker-hot` | 基础 |
| `process` | `?action=process` (cron 自动跑) | KR0/KR0 |
| `health` | `?action=health` (9+1 维度检查) | KR0 |
| `logs` | `?action=logs&date=...&hour=...` | KR0 |
| `content` | `?action=content&id=<uuid>&format=text\|html\|json` | KR0 |
| `trend` | `?action=trend&type=topics\|velocity\|acceleration` | KR0 |
| `knowledge` | `?action=knowledge&type=daily\|topic` | KR0 |

### 6.4 关键文件速查
- **新加 endpoint**: 写 `src/{name}-validation.ts` (校验) + 在 `src/endpoints.ts` 加 handler + 在 `src/index.ts` dispatch + `validate/{name}.contract.ts` (契约)
- **新加 utility**: 写 `src/{name}.ts` + `validate/{name}.contract.ts`
- **改 schema**: 需用户拍 + 跑 Supabase SQL Editor (避免 5h 配额期打扰)
- **部署**: `git push origin main` (CF auto-deploy 1-2 min)

---

**AGENTS.md · Spec Kit 6 章节标准 · v0.33 确定 Foundation 0 第 4 步 · v0.36.9 实施**
