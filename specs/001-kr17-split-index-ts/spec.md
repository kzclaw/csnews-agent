# Feature Specification: KR0 · Split index.ts

**Feature Branch**: `001-kr17-split-index-ts`
**Created**: 2026-06-09
**Status**: Draft · 待用户 review
**Source OKR**: `tasks/csnews-agent-okr.md` v0.33+sweep · KR0 · Foundation 0 第 1 步

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 拆分 index.ts 到 6 个职责文件 (Priority: P1) 🎯 MVP

作为 **CSNEWS Agent 开发者**，我需要把当前 `csnews-agent/src/index.ts`（909 行 / 9 个 SECTION）拆成 6 个职责清晰的文件，使 **O4/O6/O10 加新 type 端点时有家可归**，避免未来 index.ts 爆 1500+ 行被迫推翻 KR0 白名单。

**Why this priority**: **最高杠杆** — 拆完 index.ts 才有干净的 type 边界，所有后续 KR（KR0 测试 / KR0 可观测性 / KR0 O1 / KR0 O4 / KR0 O6 / KR0 O10）都受益。**不拆 → O4 必爆雷**。

**Independent Test**:
- 拆分后 `csnews-agent/src/index.ts` < 100 行
- 6 个新文件（auth / classify / score / news-process / endpoints / types）各 < 250 行
- `tsc --noEmit --strict` 通过
- `wrangler deploy --dry-run` 通过

**Acceptance Scenarios**:

1. **Given** 当前 index.ts 909 行，**When** 完成拆分，**Then** index.ts 只剩 default export 入口 + 必要的 import / re-export（< 100 行）
2. **Given** index.ts 有 9 个 SECTION（auth / classify / score / news-process / endpoints 等），**When** 拆分完成，**Then** 每个 SECTION 独立到对应文件，SECTION 边界 0 模糊
3. **Given** index.ts 有 14 个 action 端点（pull / diag / ping / model-test / ai-test / score / classify / batch-score / fission / save / list / embed / zaker-hot / process），**When** 拆分完成，**Then** 14 个端点全部迁到 `endpoints.ts`，index.ts 不再有 `if (action === 'X')` 链
4. **Given** KR0 目标 0 行为变化，**When** 拆分完成，**Then** 所有端点的响应 / 状态码 / 错误码 / 格式 **0 变化**（每端点 curl 行为对比 baseline）

---

### User Story 2 - GitHub auto-deploy 拆分后正常工作 (Priority: P1)

作为 **CSNEWS Agent 维护者**，我需要确认拆分后 `git push origin main` → CF auto-deploy 仍然正常工作，**不会因为文件结构变化导致部署失败或 Worker 启动失败**。

**Why this priority**: 部署链断了 = 所有改动上线失败 = KR0 做了等于没做。

**Independent Test**:
- `git push origin main` → CF 后台 → Deployments tab 显示 build 成功
- 部署后 1 分钟内 Worker URL 可访问
- 14 个端点实访全部正常（pull / ping / process 等）

**Acceptance Scenarios**:

1. **Given** 拆分完成 + 5 步本地验证通过，**When** `git push origin main`，**Then** CF 后台 Deployments tab 显示新 build 成功
2. **Given** Worker 部署成功，**When** 实访主 Worker URL + `?action=ping`，**Then** 返回 200 + `{ok: true, ts: ...}`
3. **Given** Worker 部署成功，**When** 实访 `?action=pull&type=news&limit=1`，**Then** 返回 1 条新闻（与拆分前 baseline 一致）

---

### User Story 3 - KR0 完成后为 KR0 测试基础设施铺路 (Priority: P2)

作为 **CSNEWS Agent 开发者**，拆分后 pure functions（`hashStr` / `scoreRule` / `classifyRule`）已经是 importable 模块，**KR0 可以直接单测它们**（不用再 stub 整个 Worker 上下文）。

**Why this priority**: KR0 是 Foundation 0 第 2 步，依赖 KR0 的 type 稳定。

**Independent Test**:
- 拆分后能用 `import { hashStr } from '../csnews-agent/src/score'` 形式 import（不依赖 Worker 上下文）
- pure functions 签名 0 变化（type 兼容）

**Acceptance Scenarios**:

1. **Given** KR0 拆分完成，**When** KR0 启动，**Then** `hashStr` / `scoreRule` / `classifyRule` 可在 vitest 里直接 import
2. **Given** KR0 拆分时 type 稳定，**When** KR0 写测试，**Then** 不需要 mock Worker 上下文 / env / fetch

---

## Edge Cases

- **拆分时遇到循环 import**（A 引用 B 引用 A）→ 提类型到 `types.ts` 解决（最扰动最小方案）
- **某个 SECTION 拆出去后超过 250 行**（如 news-process.ts 接近 250）→ 内部再拆 sub-文件（`news-process/{find-similar.ts, update-score.ts, ...}`）— OKR 明确允许
- **CF auto-deploy bundle 大小限制**（Free 1MB）→ 拆分后应该更小（因为分文件 + tree-shaking），但要验证
- **KV / R2 / Workers AI binding 引用**（在 fetch handler 内通过 env 传入）→ 拆分时确保 env 传递链路不破（建议用 `getSupabaseHost(env)` 这种 helper 集中）

## Requirements *(mandatory)*

### Functional Requirements

#### 文件结构

- **FR-001**: 系统 MUST 创建 `csnews-agent/src/auth.ts` — 导出 `authRequest()` 和 `corsHeaders()`
- **FR-002**: 系统 MUST 创建 `csnews-agent/src/classify.ts` — 导出 `CATEGORY_KW`（Record）/ `classifyRule()` / `classifyByAI()` / `classify()`
- **FR-003**: 系统 MUST 创建 `csnews-agent/src/score.ts` — 导出 `scoreRule()` + 路由常量（`AI_ROUTE_R_THRESHOLD` / `TOPIC_MATCH_THRESHOLD` / `R2_DUP_THRESHOLD`）
- **FR-004**: 系统 MUST 创建 `csnews-agent/src/news-process.ts` — 导出 News Self Growth 核心：`findSimilarNews()` / `updateTopicScore()` / `recordTrendSnapshot()` / `createTopic()` / `insertNewsHotspot()` / `joinTopicMember()` / `saveToR2()` / `hashStr()` / `cleanupStaleTopics()`
- **FR-005**: 系统 MUST 创建 `csnews-agent/src/endpoints.ts` — 导出 14 个 action handler（pull / diag / ping / model-test / ai-test / score / classify / batch-score / fission / save / list / embed / zaker-hot / process），每个 handler 是独立的 `async function handleX(request, env, url): Response`
- **FR-006**: 系统 MUST 创建 `csnews-agent/src/types.ts` — 导出共享类型（`NewsItem` 等）+ re-export `Env` from `cf-types.d.ts`
- **FR-007**: 系统 MUST 保留 `csnews-agent/src/index.ts` 作 default export 入口，**行数 < 100**
- **FR-008**: 系统 MUST 保持所有端点行为 **0 变化**（响应 / 状态码 / 错误码 / 格式 / timing / Workers AI 调用次数）

#### 验证

- **FR-009**: 拆分完成后 MUST `tsc --noEmit --strict` 通过（0 error）
- **FR-010**: 拆分完成后 MUST `wrangler deploy --dry-run` 通过
- **FR-011**: 拆分完成后 MUST 验证 7 个核心端点行为不变（pull / ping / diag / process / score / model-test / list）
- **FR-012**: 拆分完成后 MUST `git push origin main` 触发 CF auto-deploy，部署后 14 个端点实访全通

#### 约束

- **FR-013**: 拆分 MUST 套用 6 条核心原则（接口统一 / 通用性 / 最少扰动 / 不增熵 / 隐私红线 / Free Tier 硬约束）
- **FR-014**: 拆分 MUST 套用语言选型原则（**TypeScript** 跑在 Cloudflare Workers 是平台原生，不引入其他语言）
- **FR-015**: 拆分 MUST 走 Spec Kit L1 → L2 → L3 嵌套（spec.md → plan.md → tasks.md → implement）
- **FR-016**: 拆分 MUST 不修改任何逻辑（pure refactor，不修 bug 不优化）
- **FR-017**: 拆分 MUST 保持 CF Free Plan（10ms CPU / 100K req/day / 5 cron triggers）约束不破
- **FR-018**: 拆分 MUST 不泄漏任何敏感信息到公开仓库（隐私红线 — token / URL / 内部域名 / 本地路径）

### Key Entities *(include if feature involves data)*

- **`csnews-agent/src/*.ts`**（6 个新文件 + 1 个瘦身后的 index.ts）— TypeScript 源码文件
- **`csnews-agent/wrangler.toml`** — CF Worker 配置（**不修改**，拆分不影响配置）
- **`csnews-agent/package.json`** — 依赖配置（**不修改**，tsc 5.3.3 已够）
- **`tsconfig.json`** — TS 编译配置（**不修改**，strict 模式已开）

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `csnews-agent/src/index.ts` < 100 行（**当前 909 行**）
- **SC-002**: 6 个新文件各 < 250 行（auth / classify / score / news-process / endpoints / types）
- **SC-003**: `tsc --noEmit --strict` 通过（0 error）
- **SC-004**: `wrangler deploy --dry-run` 通过（CF 编译 OK / bundle 大小合理）
- **SC-005**: 7 个核心端点 curl 行为与拆分前 baseline 一致（响应 / 状态码 / 格式）
- **SC-006**: `git push origin main` → CF auto-deploy 成功（CF 后台 Deployments tab 显示 build OK）
- **SC-007**: 部署后 14 个端点实访全通（pull / diag / ping / model-test / ai-test / score / classify / batch-score / fission / save / list / embed / zaker-hot / process）
- **SC-008**: CF Free Plan 配额不破（Workers AI 10K Neurons/天 / R2 10GB / 5 cron triggers）
- **SC-009**: 公开仓库无任何敏感信息泄漏（commit message / diff / 新文件全部干净）

## Assumptions

- **A-001**: 拆分只动文件结构，**不改任何逻辑**（pure refactor）
- **A-002**: 14 个 action 端点不增不减（端点清单 = 拆分前）
- **A-003**: `csnews-agent/wrangler.toml` 不修改（CF 配置已配好 GitHub auto-deploy）
- **A-004**: `csnews-agent/package.json` 不修改（tsc 5.3.3 + esbuild 够用，不引入新依赖）
- **A-005**: 5/6/7/8 条核心原则 + 隐私红线 + Free Tier 硬约束全程套用
- **A-006**: 拆分后 pure functions（`hashStr` / `scoreRule` / `classifyRule`）签名 0 变化（KR0 可直接 import 测试）
- **A-007**: GitHub auto-deploy 链路在拆分后仍然正常（CF 后台已配）
- **A-008**: 拆分不引入新的 npm 依赖（保持包大小稳定）
- **A-009**: 用户 review spec.md 后，**才**进入 L1 第 2 步（plan.md）

## Out of Scope

- ❌ KR0 测试基础设施（**下个 KR**）
- ❌ KR0 可观测性（**下个 KR**）
- ❌ KR0 AGENTS.md 改造（**下个 KR**）
- ❌ 任何 bug 修复（拆分时遇到 bug 先记，不顺手改）
- ❌ 任何性能优化（拆分时遇到瓶颈先记，不顺手优化）
- ❌ 新增端点（拆分不增端点，14 → 14）
- ❌ 改任何响应 / 状态码 / 错误码（拆分 0 行为变化）
- ❌ 写新测试（KR0 负责）
- ❌ 改 `wrangler.toml` / `package.json` / `tsconfig.json`（无必要）

## Review Checklist (给用户 review 时用)

- [ ] 6 个文件拆法（auth / classify / score / news-process / endpoints / types）OK 吗？
- [ ] 行数预算（index.ts < 100 / 其他各 < 250）合理吗？
- [ ] 7 个核心端点清单（pull / ping / diag / process / score / model-test / list）覆盖足够吗？
- [ ] 14 个端点都迁到 endpoints.ts，行为 0 变化 — 这个承诺能接受吗？
- [ ] 5 重安全网（tsc / wrangler dry-run / curl / git push / 实访）够稳吗？
- [ ] Out of Scope 清单有需要加的吗？
- [ ] 准备进 L1 第 2 步（plan.md）吗？

---

*Spec 由 Mavis 按 Spec Kit v0.8.17 spec-template.md 填充 · 2026-06-09 02:53 · 待 review*
