# Implementation Plan: KR0 · Split index.ts

**Branch**: `001-kr17-split-index-ts` | **Date**: 2026-06-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-kr17-split-index-ts/spec.md`

**Note**: This plan is filled in by Mavis per Spec Kit v0.8.17 plan-template.md. It details the technical approach for splitting `csnews-agent/src/index.ts` (909 lines) into 6 responsibility files.

---

## Summary

**Primary requirement**: Split `csnews-agent/src/index.ts` (909 lines, 9 SECTIONs, 14 action endpoints) into 6 responsibility-based files (`auth.ts` / `classify.ts` / `score.ts` / `news-process.ts` / `endpoints.ts` / `types.ts`), keep `index.ts` as a thin default export entry point (< 100 lines). **Zero behavior change** across all 14 endpoints.

**Technical approach**: **Pure refactor** (no logic changes). TypeScript 5.3.3 strict mode will catch any import/type errors. Each new file becomes importable by `index.ts` and other modules. Shared contracts (`Env` / `NewsItem` / helpers) live in `shared.ts` (existing) and `types.ts` (new) — **no parallel helper definitions**.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: **TypeScript 5.3.3**（Cloudflare Workers 原生 / V8 isolate / tsc strict）

**Primary Dependencies**: 
- `typescript@5.3.3`（dev）
- `esbuild`（dev / 由 wrangler 内部调用）
- **无新增依赖**（保持包大小稳定）

**Storage**: N/A（这次不改 storage / DB / R2 / KV）

**Testing**: 
- 本地：`tsc --noEmit --strict` + `wrangler deploy --dry-run`
- 本地：7 核心端点 curl 行为对比 baseline
- 部署后：14 端点实访全通
- **KR0** 启动后会引入 vitest（但不在本次 scope）

**Target Platform**: 
- **Cloudflare Workers Free Plan**（10ms CPU / 100K req/day / 5 cron triggers）
- **CF Workers AI Free**（10K Neurons/天）
- **CF R2 Free**（10GB 存储 / 1000万读 / 1000万写 / 月）
- **GitHub auto-deploy**（push → CF 自动 build + deploy）

**Project Type**: 
- `web-service`（单 Worker，但有 14 个 action 端点）
- `monorepo`（仓库根有 `csnews-agent/` + `supabase/` + `tools/` + `tasks/` + `specs/`）

**Performance Goals**: 
- **不退步**：拆分后 6 个文件 import 比 909 行单文件 **更快**（V8 isolate 启动 + tree-shaking 友好）
- Workers AI Neurons 消耗不变（不调新 LLM）
- CF CPU 10ms 内不超时（不引入新 LLM 调用）

**Constraints**: 
- **GitHub auto-deploy 链路 0 破坏**（push → build → deploy 不破）
- **Free Plan 配额 0 突破**（CPU / req / cron / Neurons / R2 全部不破）
- **0 行为变化**（14 端点响应 / 状态码 / 错误码 / 格式 100% 不变）
- **0 隐私泄漏**（commit message / diff / 新文件全部干净）

**Scale/Scope**: 
- 14 个 action 端点（不增不减）
- 6 个新文件（auth / classify / score / news-process / endpoints / types）
- `index.ts` < 100 行（当前 909 行）
- 各新文件 < 250 行

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

按 OKR 核心原则 6 条铁律 + 隐私红线 + Free Tier 硬约束 + 语言选型原则 全面 check：

| # | 原则 | check | 说明 |
|---|------|-------|------|
| 1 | **架构接口统一** | ✅ PASS | 跨模块接口走 `shared.ts`（已有 Env / getSupabaseHost / supabaseFetch / safeJson）+ `types.ts`（新 / 共享类型）。**不发明新范式**。 |
| 2 | **模块化可复用可扩展通用性** | ✅ PASS | 6 文件 = 6 职责 = 6 抽屉。每个文件做一件事。**未来 O4/O6/O10 新功能归对应模块**（不堆回 index.ts）。 |
| 3 | **最少扰动（无破坏）** | ✅ PASS | Pure refactor，**0 行为变化**。14 端点 / 共享类型 / 路由常量 / 部署链路全部保留。 |
| 4 | **不增熵** | ✅ PASS | 不发明新端点 / 新字段 / 新命名。**不引入新 npm 依赖**（保持包大小稳定）。 |
| 5 | **隐私红线** | ✅ PASS | commit 前 grep 自检（csnews.kwokzit / irkydyw / /Users/zitkwok / KR 编号 / H 编号 / token）。**新文件 0 敏感信息**。 |
| 6 | **Free Tier 硬约束** | ✅ PASS | 不升级 Paid 版 / 不引入付费 API / Free Plan 配额不破。**不修改 wrangler.toml**（CF 配置已含 cron triggers + R2 binding + Workers AI binding）。 |
| 7 | **语言选型** | ✅ PASS | TypeScript = CF Workers 原生（V8 isolate / 平台 SDK / tsc strict / esbuild）。**不引入其他语言**（用户语言选型原则第 6 条约定）。 |
| 8 | **Spec Kit 工作流** | ✅ PASS | 走完整 L1 → L2 → L3 嵌套（spec.md → plan.md → tasks.md → implement）。**禁止 ad-hoc 修 bug**。 |

**Constitution Check 结论：全部 8 项 PASS，无 violation，无 complexity tracking 需要填**。

## Project Structure

### Documentation (this feature)

```text
specs/001-kr17-split-index-ts/
├── plan.md              # This file
├── spec.md              # spec.md (already created, user reviewed)
├── research.md          # N/A (pure refactor, no research needed)
├── data-model.md        # N/A (no data model change)
├── quickstart.md        # N/A (no new functionality)
├── contracts/           # N/A (no new API contracts)
└── tasks.md             # To be created in next step
```

### Source Code (after refactor)

```text
csnews-agent/src/
├── index.ts            < 100 行   (default export entry point + minimal re-exports)
├── auth.ts             ~20 行    (authRequest + corsHeaders)
├── classify.ts         ~90 行    (CATEGORY_KW + classifyRule + classifyByAI + classify)
├── score.ts            ~30 行    (scoreRule + AI_ROUTE_R_THRESHOLD + TOPIC_MATCH_THRESHOLD + R2_DUP_THRESHOLD)
├── news-process.ts     ~100 行   (9 News Self Growth core functions)
├── endpoints.ts        ~600 行   (14 action handlers: pull / diag / ping / model-test / ai-test / score / classify / batch-score / fission / save / list / embed / zaker-hot / process)
├── types.ts            ~20 行    (NewsItem + shared types + re-export Env from cf-types.d.ts)
├── pull.ts             456 行    (UNCHANGED · KR0 已有)
├── shared.ts           52 行     (UNCHANGED · KR0 已有 · 跨模块接口契约)
└── cf-types.d.ts       33 行     (UNCHANGED · KR0 已有)
```

### Total

- **Before**: index.ts (909 行) + pull.ts (456) + shared.ts (52) + cf-types.d.ts (33) = **1450 行**
- **After**: index.ts (< 100) + 6 新文件 (~860) + pull.ts (456) + shared.ts (52) + cf-types.d.ts (33) = **~1501 行**
- **增加**: ~50 行（import / re-export / 类型声明的少量冗余，**可以接受**）

## Implementation Order

按依赖关系（低层 → 高层）：

1. **`types.ts`** 先建（其他文件都依赖共享类型）
2. **`auth.ts`** / **`classify.ts`** / **`score.ts`** 3 个文件可并行（无相互依赖）
3. **`news-process.ts`** 依赖 `types.ts`
4. **`endpoints.ts`** 依赖前面所有（auth / classify / score / news-process + types + shared）
5. **`index.ts`** 最后瘦身（只留 default export + import 14 个 handler + dispatch）

## Key Decisions

### 决定 1：每个 handler 形态 = `async function handleX(request: Request, env: Env, url: URL): Promise<Response>`

**理由**：统一形态（核心原则 #1 接口统一）。每个 handler 是纯函数，**不依赖 fetch handler 上下文**，方便未来单独 unit test（KR0）。

### 决定 2：`endpoints.ts` 内部组织 = 按 action 名字导出 14 个 handler

```typescript
// endpoints.ts 内部结构
export async function handlePing(request: Request, env: Env, url: URL): Promise<Response> { ... }
export async function handlePull(request: Request, env: Env, url: URL): Promise<Response> { ... }
export async function handleDiag(request: Request, env: Env, url: URL): Promise<Response> { ... }
// ... 14 个 handler
```

**理由**：
- 14 个 handler 都在一个文件（endpoints.ts 600 行）— 仍是单文件但**职责单一**
- index.ts 用 `import * as E from './endpoints'` 然后 dispatch：`if (action === 'pull') return E.handlePull(...)`
- **未来加端点**（O4/O6/O10）→ endpoints.ts 末尾加一个 handler + index.ts 加一个 if 分支

### 决定 3：`index.ts` dispatch 用 if-else 链（**不**用 map/对象查表）

**理由**：
- 当前 14 个端点用 if-else 链，**保持现状最少扰动**（核心原则 #3）
- if-else 链可读性高，每个分支 1-2 行
- **不**用 `const handlers = { pull: handlePull, ... }; handlers[action]?.(...)` —— 理由是 type narrowing 复杂 + 不必要的间接层

### 决定 4：不修改 `pull.ts` / `shared.ts` / `cf-types.d.ts`

**理由**：
- 这 3 个文件 KR0 拆得已经够好（核心原则 #3 最少扰动）
- `shared.ts` 已经是跨模块接口契约的事实标准，**不再拆**
- `cf-types.d.ts` 已经声明 Env 全局类型，**不再动**

## Migration Strategy（无破坏）

拆分是 pure refactor，**不涉及数据迁移**。但要确保：

1. **每个文件拆分后立即 tsc 检查**（不要等全部拆完才发现 import 漏）
2. **拆分顺序**：types → auth/classify/score → news-process → endpoints → index.ts
3. **每个文件拆完 commit 一次**（git 历史清晰，rollback 单文件粒度）

## Rollback Plan

任何拆分出问题：

```bash
# 单文件 rollback
git revert <commit-hash>

# 全部 rollback
git revert HEAD~N..HEAD
```

**前提**：每个文件单独 commit（不是最后一次性 commit），rollback 粒度可控。

## Verification Strategy

按 spec.md FR-009 ~ FR-012 + SC-001 ~ SC-009：

| 阶段 | 验证 | 工具 |
|------|------|------|
| **本地（拆分后）** | tsc 0 error | `npx tsc --noEmit --strict` |
| **本地（拆分后）** | wrangler 编译 OK | `npx wrangler deploy --dry-run` |
| **本地（拆分后）** | 7 核心端点行为对比 baseline | curl + jq |
| **部署** | git push → CF auto-deploy 成功 | git + CF 后台 Deployments tab |
| **部署后** | 14 端点实访全通 | curl 实访 Worker URL |

**7 核心端点 baseline**（拆分前先记录响应，拆分后对比）：
1. `?action=ping`
2. `?action=diag`
3. `?action=process`（需要 Bearer token）
4. `?action=pull&type=news&limit=3&format=summary`
5. `?action=pull&type=topics&limit=2`
6. `?action=score&title=测试`
7. `?action=list&prefix=news/zaker/&order=desc&limit=3`

## Risk Assessment

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 拆分时漏 import | 中 | 高（tsc 拦） | 每个文件拆完立即 tsc |
| 拆分时改逻辑（手痒优化） | 中 | 高 | review 时严格检查 diff — 应该 0 逻辑变化 |
| CF auto-deploy bundle 超 1MB | 低 | 中（Free Plan 限制） | 拆分后文件更小，**预计 50% 减小**；wrangler dry-run 验证 |
| 14 端点任一行为变化 | 中 | 高 | curl 行为对比 baseline；tsc + wrangler dry-run 提前拦 |
| `Env` 类型引用不一致 | 低 | 中 | `types.ts` re-export 统一入口，所有模块 import 自 `types.ts` |

## Dependencies

- **依赖**：index.ts（当前 909 行）/ 5/6/7/8 条铁律 + 隐私红线 + Free Tier / 现有 wrangler.toml / 现有 package.json
- **被依赖**：KR0（测试基础设施）/ KR0（可观测性）/ KR0/14/15/16（O 维度 4 KR）— 全部需要稳定的 type 边界

## Out of Scope (重申 spec.md)

- ❌ KR0 / KR0 / KR0（其他 Foundation 0 KR）
- ❌ KR0 / KR0 / KR0 / KR0（Foundation 0 O 维度 KR）
- ❌ 任何 bug 修复 / 性能优化
- ❌ 新增端点 / 改端点行为
- ❌ 改 wrangler.toml / package.json / tsconfig.json
- ❌ 写新测试（KR0 负责）

## Next Step

**L1 SPEC 第 3 步：tasks.md**（按 plan.md 生成 tasks，按 User Story 组织的 task 列表 + 依赖图 + 并行机会识别）

**Review checklist for plan.md**:

- [ ] 6 文件拆法（auth / classify / score / news-process / endpoints / types）OK 吗？
- [ ] 实现顺序（types → auth/classify/score → news-process → endpoints → index.ts）合理吗？
- [ ] 关键决定 4 个（handler 形态 / 14 handler 导出 / if-else dispatch / 不动 pull.ts+shared.ts+cf-types.d.ts）能接受吗？
- [ ] 7 核心端点 baseline 清单覆盖足够吗？
- [ ] 5 风险评估 + 缓解措施完备吗？
- [ ] 准备进 L1 第 3 步（tasks.md）吗？

---

*Plan by Mavis per Spec Kit v0.8.17 plan-template.md · 2026-06-09 03:09 · 待 review*
