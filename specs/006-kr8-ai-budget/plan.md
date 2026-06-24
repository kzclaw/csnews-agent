# O12KR1 AI 预算控制 · PLAN

> Technical Architecture & Implementation Blueprint

---

## 1. Summary

实现 CSNEWS Agent 的 AI 预算控制层，保护 MiniMax Neurons 免费配额。系统通过 KV 追踪日消耗、4 档预算状态判断、自动降级路由、R2 占位文档和 Supabase 标记，实现优雅降级。

**核心文件**：
- `src/ai-budget.ts`（304 行）— Phase 1-2，追踪 + 状态 + hook
- `src/ai-degradation.ts`（174 行）— Phase 3，降级策略
- `src/endpoints.ts` — Phase 4，health + ai-usage 端点扩展

---

## 2. Technical Context

### 2.1 资源层
| 资源 | 用途 | 规格 |
|------|------|------|
| KV `AI_USAGE_KV` | Neurons 日消耗追踪 | Free 100K writes/day，TTL 7d |
| R2 `csnews_raw` | 降级占位文档存储 | 复用现有 bucket |
| Supabase `warnings/fission_searches/knowledge` | degraded 标记 | 3 表各加 `degraded bool default false` |

### 2.2 阈值体系（env vars 控制）
```
AI_BUDGET_DAILY_LIMIT        = 10,000   # 日配额上限
AI_BUDGET_WARNING_THRESHOLD   = 5,000    # warning 触发
AI_BUDGET_CRITICAL_THRESHOLD = 7,000    # critical 触发
AI_BUDGET_SHUTDOWN_THRESHOLD  = 8,000    # shutdown 触发
```

### 2.3 6 层 AI 路由矩阵
```
L1 规则分类  → 始终允许（0 Neurons）
L2 AI 评分  → 始终允许（免费路由）
L3 同步分类  → normal/warning 允许；critical/shutdown 跳过
L4 异步分析  → normal/warning/critical 允许；shutdown 跳过
L5 裂变搜索  → normal/warning/critical 允许；shutdown 跳过
L6 Knowledge → 仅 normal 允许；其余跳过
```

### 2.4 R2 占位文档路径
```
ai-degraded/{YYYY-MM-DD}/{record_id}.md
```

---

## 3. Constitution Check

| 原则 | 状态 | 说明 |
|------|------|------|
| 以瞎猜接口为耻 | ✅ | 接口参数查 wrangler.toml schema，字段名 100% 匹配 |
| 以模糊执行为耻 | ✅ | 4 档阈值，蓝图 2.9 公式，0 模糊 |
| 以臆想业务为耻 | ✅ | 6 层路由矩阵，LLM 调用点逐一确认 |
| 以创造接口为耻 | ✅ | 复用现有 KV/R2/Supabase，不造新基础设施 |
| 以跳过验证为耻 | ✅ | vitest 648 passed，wrangler dry-run，tsc 0 error |
| 以破坏架构为耻 | ✅ | dispatcher 集成点清晰，hook 模式非侵入 |
| 以假装理解为耻 | ✅ | 降级逻辑失败静默，不吞主流程异常 |
| 以盲目修改为耻 | ✅ | Phase 1-5 小步推进，每步验证通过再继续 |

---

## 4. Project Structure

```
csnews-agent/
├── src/
│   ├── ai-budget.ts        # Phase 1-2: 追踪 + 状态 + hook
│   ├── ai-degradation.ts  # Phase 3: 降级策略
│   ├── dispatch.ts         # Phase 2: hook 集成点
│   ├── endpoints.ts        # Phase 4: health + ai-usage 端点
│   └── shared.ts           # Env interface 扩展
├── validate/
│   ├── ai-budget.contract.ts   # Phase 5: 单元测试
│   └── ai-degradation.contract.ts # Phase 5: 集成测试
└── supabase/migrations/
    └── add_degraded_field.sql  # Phase 3: 3 表 DDL
```

---

## 5. Key Decisions

### KD1: KV vs R2 追踪
选择 KV 存结构化数据（`{total, calls[]}`），R2 只存降级占位文档。
理由：KV 原子读写适合计数器，R2 适合文件类占位内容。

### KD2: 降级时双写（KV 已追踪 + R2 占位 + Supabase 标记）
三写均失败静默，不阻断主流程。
理由：降级时 AI 功能已不可用，主数据写入仍应正常进行。

### KD3: 阈值用 env vars 而非 hardcode
`AI_BUDGET_WARNING_THRESHOLD` 等四个阈值全部从 env 读取，默认值兜底。
理由：运营数据积累后需要调参，无需改代码。

### KD4: 降级文案硬编码而非 API
`getDegradationMessage(level)` 返回固定文案，不调用 LLM。
理由：降级时 Neurons 已接近耗尽，调用 LLM 生成文案自相矛盾。

### KD5: L6 Knowledge 最严格
L6 仅 normal 时可用（L5 可到 critical）。
理由：Knowledge Engine 消耗最大，留给最关键场景。

---

## 6. Verification Strategy

| 阶段 | 检查项 | 工具 |
|------|--------|------|
| 单元 | 4 函数契约测试 | vitest |
| 集成 | 三档降级场景模拟 | vitest |
| 类型 | TypeScript 编译 | tsc --noEmit |
| 部署 | dry-run binding 验证 | wrangler deploy --dry-run |
| 隐私 | commit message + 代码扫描 | grep + code-privacy-audit |
| 端到端 | health 端点 ai_budget 字段 | curl |

---

## 7. Risk Assessment

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| KV 写入 QPS 超限 | 低 | 中 | 阈值 100K/day，实际日消耗 < 7K |
| R2 降级写失败 | 低 | 低 | 失败静默，Supabase 标记仍生效 |
| 阈值误配（env 设为 0） | 低 | 高 | 代码层 default 兜底（5K/7K/8K）|
| L6 最严格导致 Knowledge 长期不可用 | 中 | 低 | Phase 1-5 实测数据积累后调参 |
