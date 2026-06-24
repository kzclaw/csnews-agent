# O12KR1 AI 预算控制 · SPEC

> AI Budget Control System — TIE-Lite 资源管理层
> Phase 1-6 实施完成，文档归档 v1.0

---

## 1. User Stories

### US1: 开发者想知道当日 Neurons 消耗
**作为** CSNEWS Agent 的维护者，
**我希望** 随时查询当日已消耗的 Neurons 数量，
**以便** 判断是否接近免费配额上限，提前规划降级策略。

**验收条件**：
- API 返回当日总消耗数字（整数，单位 Neurons）
- 查询响应时间 < 50ms
- 日用量超出阈值时能拿到对应档位（normal/warning/critical/shutdown）

---

### US2: 系统在 Neurons 超量时自动降级
**作为** CSNEWS Agent 的调度层，
**我希望** 当日消耗达到阈值时，AI 调用自动降级或跳过，
**以便** 保护免费配额不被耗尽，同时尽量保留核心功能。

**验收条件**：
- L3 分类：used >= 5K 时降级，used >= 7K 时跳过
- L4 异步分析：used >= 7K 时降级，used >= 8K 时跳过
- L5 裂变搜索：used >= 7K 时降级，used >= 8K 时跳过
- L6 Knowledge：used >= 5K 时跳过，only normal 时可用
- L1/L2 始终允许（规则分类和 AI 评分不消耗 Neurons）

---

### US3: 降级时写占位文档，不丢数据
**作为** CSNEWS Agent 的消费者，
**我希望** 即使 AI 降级，事件链中仍有可读记录，
**以便** 知道哪些内容触发了降级，日后可补充。

**验收条件**：
- 降级时 R2 写入 `ai-degraded/{date}/{id}.md`（含触发时间和用量）
- Supabase warnings / fission_searches / knowledge 三表 degraded=true 标记
- 降级时返回用户可见的提示文案

---

### US4: 运维可观测降级状态
**作为** 系统运维，
**我希望** 通过 health 端点看到 AI 预算实时状态，
**以便** 监控告警和人工干预。

**验收条件**：
- `?action=health` 返回 `ai_budget_today` 字段（used + tier）
- `?action=ai-usage` 按 model / day / category 聚合 7 天历史

---

## 2. Functional Requirements

### FR1: Neurons 用量追踪（Phase 1）
- [x] KV namespace `AI_USAGE_KV` 记录每日 Neurons 消耗
- [x] Key format: `usage/{YYYY-MM-DD}`，TTL 7 天
- [x] 记录每次 AI 调用的 model + neurons + timestamp
- [x] `recordAiCall(env, model, neurons)` — 核心写入函数
- [x] `getDailyUsage(env, date?)` — 查询当日总消耗
- [x] `resetDailyCounter(env)` — UTC 0 点主动清理（TTL 自动兜底）

### FR2: 4 档预算状态（Phase 1-2）
- [x] 阈值可配置（env vars），默认值：
  - normal: used < 5,000
  - warning: 5,000 <= used < 7,000
  - critical: 7,000 <= used < 8,000
  - shutdown: used >= 8,000
- [x] `getBudgetStatus(env)` — 返回 used + tier + remaining + quota
- [x] `canUseTier(env, tier)` — 判断某层是否可用

### FR3: 预算检查 hook（Phase 2）
- [x] `shouldTriggerAiCall(env, level)` — 集成到 AI 调用前
- [x] L1 始终 true（规则分类 0 Neurons）
- [x] L2 始终 true（AI 评分免费路由）
- [x] L4/L5/L6 按阈值决定是否允许
- [x] 集成到 dispatcher 和各 LLM 调用点

### FR4: 降级策略（Phase 3）
- [x] `getDegradationMessage(level)` — 各档位提示文案
- [x] `writeDegradedInsight(env, id, level, title)` — R2 写占位文档
- [x] `markAsDegraded(env, id, table)` — Supabase 三表 degraded=true 标记
- [x] R2 路径: `ai-degraded/{date}/{id}.md`
- [x] 降级时写 R2 + 标记 Supabase 双写

### FR5: 可观测性（Phase 4）
- [x] health 端点加 `ai_budget_today` 字段
- [x] 新增 `?action=ai-usage` 端点（model/day/category 聚合）
- [x] 复用 `AI_USAGE_KV` 数据，零新增 KV

### FR6: 验证（Phase 5）
- [x] 单元测试 32 it（ai-budget.ts 核心函数）
- [x] 集成测试 44 it（三档降级场景）
- [x] vitest 648 passed / 654 total
- [x] tsc --noEmit 0 错误
- [x] wrangler deploy --dry-run 通过

---

## 3. Success Criteria

| 指标 | 目标 | 当前 |
|------|------|------|
| 日均 Neurons 消耗 | < 7K（70% 配额内）| ✅ 实际低于目标 |
| 降级时 R2 占位写入 | 100% | ✅ Phase 3 完成 |
| Supabase degraded 标记 | warnings/fission_searches/knowledge 三表 | ✅ Phase 3 完成 |
| health 端点 ai_budget 字段 | 实时准确 | ✅ Phase 4 完成 |
| vitest 覆盖率 | >= 580 passed | ✅ 648 passed |
| tsc 错误 | 0 | ✅ Phase 5 完成 |

---

## 4. Assumptions

- Neurons 免费配额基于 MiniMax 实际政策，实际阈值需运营数据校准
- KV TTL 7 天满足审计需求，更长保留期可调大 TTL
- CF Workers AI 调用路径相对稳定，model 参数不频繁变更
- R2 和 Supabase 在降级时可用（降级逻辑依赖这两个服务）

---

## 5. Out of Scope

- Neurons 消耗的精确计费（以 MiniMax 后台为准）
- 跨月配额累计
- 付费配额切换
- AI 调用重试和指数退避（由上游调用方负责）
- 降级阈值自适应调优（O12KR1+1 待启动）
