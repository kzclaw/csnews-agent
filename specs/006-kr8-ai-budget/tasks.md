# O12KR1 AI 预算控制 · TASKS

> Phase 1-6 实施清单（Phase 1-5 已完成，Phase 6 归档本文档）

---

## Phase 1: Neurons 用量追踪 ✅

**目标**：KV 记录每日 Neurons 消耗，零侵入主流程

| # | Task | 状态 | 文件 |
|---|------|------|------|
| 1.1 | 新建 KV namespace `AI_USAGE_KV`（CF Dashboard） | ✅ | — |
| 1.2 | `src/ai-budget.ts` 核心函数 | ✅ | `ai-budget.ts:78-304` |
| 1.3 | Env interface 扩展（`AI_USAGE_KV` binding） | ✅ | `shared.ts` |
| 1.4 | `recordAiCall` 集成到 dispatcher LLM 调用点 | ✅ | `dispatch.ts` |
| 1.5 | 5 重安全网 | ✅ | tsc + vitest + dry-run + privacy + push |

**产出**：`src/ai-budget.ts`（304 行），commit `564ea46`

---

## Phase 2: 预算检查 hook ✅

**目标**：AI 调用前判断是否允许，保护免费配额

| # | Task | 状态 | 文件 |
|---|------|------|------|
| 2.1 | `getBudgetStatus` 4 档状态判断 | ✅ | `ai-budget.ts:177-214` |
| 2.2 | `canUseTier` 6 层路由矩阵 | ✅ | `ai-budget.ts:248-259` |
| 2.3 | `shouldTriggerAiCall` hook 函数 | ✅ | `ai-budget.ts:285-304` |
| 2.4 | hook 集成到 dispatcher（`ALLOWED_ACTIONS` + 路由） | ✅ | `dispatch.ts` |
| 2.5 | L2/L5/L6 各调用点接入 `shouldTriggerAiCall` | ✅ | `dispatch.ts` |
| 2.6 | 5 重安全网 | ✅ | tsc + vitest + dry-run + privacy + push |

**产出**：4 commits（`d140fc6` / `f6044ce` / `81f6004` / `b581a9e`）

---

## Phase 3: 降级策略 ✅

**目标**：超量时写 R2 占位 + 标记 Supabase degraded，零数据丢失

| # | Task | 状态 | 文件 |
|---|------|------|------|
| 3.1 | `src/ai-degradation.ts` 核心函数 | ✅ | `ai-degradation.ts:46-174` |
| 3.2 | Supabase DDL：3 表加 `degraded bool default false` | ✅ | migrations |
| 3.3 | DDL apply（Management API） | ✅ | CEO 手动 apply |
| 3.4 | 降级触发点集成（`dispatch.ts` + `handleFission`） | ✅ | `dispatch.ts` |
| 3.5 | 5 重安全网 | ✅ | tsc + vitest + dry-run + privacy + push |

**产出**：3 commits（`b4f6558` / `4b68f52` / `877de95`）

---

## Phase 4: 可观测性 ✅

**目标**：运维能实时看到 AI 预算状态

| # | Task | 状态 | 文件 |
|---|------|------|------|
| 4.1 | health 端点加 `ai_budget_today` 字段 | ✅ | `endpoints.ts` |
| 4.2 | `?action=ai-usage` 端点（model/day/category 聚合） | ✅ | `endpoints.ts` |
| 4.3 | 5 重安全网 | ✅ | tsc + vitest + dry-run + privacy + push |

**产出**：commit `e693671`

---

## Phase 5: 验证 ✅

**目标**：Phase 1-4 实现完整可测，648+ 测试覆盖

| # | Task | 状态 | 文件 |
|---|------|------|------|
| 5.1 | `validate/ai-budget.contract.ts` 单元测试（32 it） | ✅ | 352 行 |
| 5.2 | `validate/ai-degradation.contract.ts` 集成测试（44 it） | ✅ | 303 行 |
| 5.3 | vitest >= 580 passed | ✅ | 648 passed |
| 5.4 | tsc --noEmit 0 error | ✅ | — |
| 5.5 | wrangler deploy --dry-run 通过 | ✅ | AI_BUDGET_* binding 完整 |
| 5.6 | git diff --check 干净 | ✅ | — |
| 5.7 | privacy scan 干净 | ✅ | commit msg 无个人引用 |

**产出**：commit `f519791`（pending push）

---

## Phase 6: Spec Kit 归档 ✅

**目标**：O12KR1 实施文档化，纳入 Spec Kit 体系

| # | Task | 状态 | 文件 |
|---|------|------|------|
| 6.1 | `specs/006-kr8-ai-budget/spec.md` | ✅ | 本文件 |
| 6.2 | `specs/006-kr8-ai-budget/plan.md` | ✅ | 本文件 |
| 6.3 | `specs/006-kr8-ai-budget/tasks.md` | ✅ | 本文件 |

---

## 总览

| Phase | 任务数 | 完成 | 产出 |
|-------|--------|------|------|
| Phase 1 | 5 | ✅ | 1 commit |
| Phase 2 | 6 | ✅ | 4 commits |
| Phase 3 | 5 | ✅ | 3 commits |
| Phase 4 | 3 | ✅ | 1 commit |
| Phase 5 | 7 | ✅ | 1 commit |
| Phase 6 | 3 | ✅ | 3 文档 |
| **合计** | **29** | **✅** | **10 commits + 3 docs** |

---

## 遗留观察

1. 测试文件顶部注释含本地路径（`~/Library/...`），不影响 GitHub 隐私合规（commit message 干净），建议后续改为通用描述。
2. 阈值调优待 O12KR1+1 启动（需 1 个月实测数据）。
3. L6 Knowledge 最严格，可能需根据实际使用频率调整阈值。
