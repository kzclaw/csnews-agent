# Tasks: KR0 · Split index.ts

**Input**: Design documents from `/specs/001-kr17-split-index-ts/`
**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: KR0 **不写新测试**（KR0 负责）。验证方式：5 重安全网（tsc / wrangler dry-run / 7 端点 curl / git push / 14 端点实访）。

**Organization**: Tasks grouped by User Story（US1 拆 6 文件 / US2 部署验证 / US3 为 KR0 铺路）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel（不同文件，无依赖）
- **[Story]**: User Story 归属（US1 / US2 / US3）
- File paths 写完整（spec-kit 约定）

## Path Conventions

- Worker 源码：`csnews-agent/src/`
- 部署配置：`csnews-agent/wrangler.toml`（**不动**）
- 包配置：`csnews-agent/package.json`（**不动**）
- 文档：`tasks/csnews-agent-okr.md`（KR0 状态更新）

---

## Phase 1: Setup（拆分前准备）

**Purpose**: 拆分前 baseline 记录 + git 干净状态

- [x] T000 [US1] 记录 7 核心端点 baseline 响应 ✅（拆分前）— 手动 curl + 保存 JSON 快照
- [ ] T000 [US1] 确认 `git status` 干净，无未提交改动
- [ ] T000 [US1] 确认 `git checkout -b 001-kr17-split-index-ts`（feature branch 已建）

**Checkpoint**: Baseline 已记录 / git 干净 / feature branch 就位

---

## Phase 2: Foundational（types.ts 必须先建）

**Purpose**: 共享类型独立成抽屉（其他 5 个抽屉都引用）

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T000 [P] [US1] Create `csnews-agent/src/types.ts` — 导出 `NewsItem`（从 index.ts 行 118 抽出）+ 共享类型 + re-export `Env` from `cf-types.d.ts`（~20 行）

**Checkpoint**: types.ts 就位 → 其他抽屉可以开始 import

---

## Phase 3: User Story 1 — 拆分 index.ts 到 6 个职责文件 (Priority: P1) 🎯 MVP

**Goal**: `index.ts` 从 909 行降到 **< 100 行**，6 个新抽屉各 **< 250 行**

**Independent Test**:
- `tsc --noEmit --strict` 0 error
- 7 核心端点 curl 行为对比 baseline **100% 一致**
- `index.ts` 行数 < 100
- 6 个新文件各 < 250 行

### Implementation for US1

- [x] T000 ✅ commit e34454d [P] [US1] Create `csnews-agent/src/auth.ts` — `authRequest()` + `corsHeaders()`（~20 行）
- [x] T000 ✅ commit d6737f7 [P] [US1] Create `csnews-agent/src/classify.ts` — `CATEGORY_KW` + `classifyRule()` + `classifyByAI()` + `classify()`（~90 行）
- [x] T000 ✅ commit c8a4b59 [P] [US1] Create `csnews-agent/src/score.ts` — `scoreRule()` + 路由常量（`AI_ROUTE_R_THRESHOLD` / `TOPIC_MATCH_THRESHOLD` / `R2_DUP_THRESHOLD`）（~30 行）
- [ ] T000 [US1] Create `csnews-agent/src/news-process.ts` — 9 个 News Self Growth 核心函数（~100 行）[depends T000]
- [ ] T000 [US1] Create `csnews-agent/src/endpoints.ts` — 14 个 action handler（~600 行）[depends T000-T000]
- [ ] T000 [US1] Slim `csnews-agent/src/index.ts` to **< 100 行**（default export + 必要的 import + dispatch）[depends T000]

**Checkpoint**: 6 文件就位 / index.ts 瘦身 / tsc 0 error（US1 完成）

---

## Phase 4: User Story 2 — GitHub auto-deploy 拆分后正常工作 (Priority: P1)

**Goal**: `git push` → CF auto-deploy → 14 端点实访全通

**Independent Test**:
- `git push origin main` 成功
- CF 后台 Deployments tab 显示 build 成功
- **14 端点实访全部 200 / 行为正确**

### Implementation for US2

- [ ] T000 [US1] 运行 `tsc --noEmit --strict`（0 error）[depends T000]
- [ ] T000 [US1] 运行 `wrangler deploy --dry-run`（编译 OK）[depends T000]
- [ ] T000 [US1] 运行 **7 核心端点** curl 行为对比 baseline（ping / diag / pull / process / score / model-test / list）[depends T000]
- [ ] T000 [US1] `git add` + `git commit`（**每个 T000-T000 一个 commit**，共 6-7 个 commit）[depends T000]
- [ ] T000 [US1] `git push origin 001-kr17-split-index-ts` → 然后开 PR / 或直接 push main（按团队约定）[depends T000]
- [ ] T000 [US1] CF 后台查看 Deployments tab 验证 build 成功 [depends T000]
- [ ] T000 [US1] **14 端点实访**全通验证（pull / diag / ping / model-test / ai-test / score / classify / batch-score / fission / save / list / embed / zaker-hot / process）[depends T000]

**Checkpoint**: Worker 真实部署 + 14 端点全部正常（US2 完成）

---

## Phase 5: User Story 3 — KR0 铺路 (Priority: P2)

**Goal**: pure functions（`hashStr` / `scoreRule` / `classifyRule`）已 importable，type 稳定，**KR0 可直接写单测**

**Independent Test**:
- `import { hashStr } from '../csnews-agent/src/score'` 不报错
- 不需要 mock Worker 上下文
- KR0 启动时**零阻力**

### Implementation for US3

- [ ] T000 [US1] 验证 `hashStr` / `scoreRule` / `classifyRule` 签名 0 变化 [depends T000]
- [ ] T000 [US1] 验证 types 集中到 `types.ts`，所有 import 都走 `types.ts`（无 inline 类型）[depends T000]
- [ ] T000 [US1] 更新 OKR KR0 状态 → 全部 [x] 完成（[ ] → [x]） [depends T000]
- [ ] T000 [US1] 更新 Changelog → 加 v0.33+sweep·FT-KR0 完成条目 [depends T000]

**Checkpoint**: KR0 启动零阻力（US3 完成）

---

## Phase N: Polish & Cross-Cutting Concerns

- [ ] T000 [P] 验证 `index.ts` 行数确实 < 100
- [ ] T000 [P] 验证 6 个新文件各 < 250 行
- [ ] T000 [P] `git log` 检查 6-7 个 commit 按顺序（types → 3 并行 → news-process → endpoints → index.ts）
- [ ] T000 [P] OKR Changelog 加 v0.33+sweep·FT + KR0 完成条目
- [ ] T000 commit 前 grep 自检（`csnews\.kwokzit` / `irkydyw` / `/Users/zitkwok` / `KR\d+` / `H\d+` / token）— 隐私红线

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖 → 立即开始
- **Foundational (Phase 2)**: 依赖 Setup → **BLOCKS** US1
- **US1 (Phase 3)**: 依赖 Foundational → BLOCKS US2 / US3
- **US2 (Phase 4)**: 依赖 US1 → 部署验证
- **US3 (Phase 5)**: 依赖 US1 → KR0 铺路
- **Polish (Phase N)**: 依赖所有 US

### Within US1

```
T000 (types) [BLOCKS]
  ├─ T000 [P] (auth) ─┐
  ├─ T000 [P] (classify) ─┤
  ├─ T000 [P] (score) ─┤
  └─ T000 (news-process, depends T000) ─┤
                                      ↓
                              T000 (endpoints, depends T000-T000)
                                      ↓
                              T000 (index.ts 瘦身, depends T000)
```

### Parallel Opportunities

- **Phase 1**: T000/T000/T000 [P] 并行（不同关注点）
- **Phase 2**: T000 单独（无依赖）
- **US1 内部**: T000/T000/T000 [P] 并行（types 建完后立刻开 3 个工作区）
- **Phase N**: T000/T000/T000 [P] 并行（验证 + git log + Changelog）

---

## Implementation Strategy

### MVP First（US1 Only）

1. Phase 1: Setup（3 task 准备）
2. Phase 2: Foundational（T000 types）
3. Phase 3: US1 拆分（T000-T000，**T000/T000/T000 并行**）
4. **STOP and VALIDATE**: tsc + wrangler dry-run + 7 端点 curl 行为对比
5. **STOP and REVIEW**: 给用户看 diff + 文件结构

### Incremental Delivery

| 阶段 | task | commit |
|------|------|--------|
| 1 | T000-T000（Setup + Foundational）| 1 commit: `chore: setup + types.ts foundation` |
| 2 | T000（auth.ts）| 1 commit: `refactor: extract auth.ts` |
| 3 | T000（classify.ts）| 1 commit: `refactor: extract classify.ts` |
| 4 | T000（score.ts）| 1 commit: `refactor: extract score.ts` |
| 5 | T000（news-process.ts）| 1 commit: `refactor: extract news-process.ts` |
| 6 | T000（endpoints.ts）| 1 commit: `refactor: extract endpoints.ts (14 handlers)` |
| 7 | T000（index.ts 瘦身）| 1 commit: `refactor: slim index.ts to < 100 lines` |
| 8 | T000-T000（US2 部署验证）| 1 commit: `docs: KR0 changelog + OKR update` |

**共 8 个 commit**，每个独立 rollback 粒度。

### Parallel Team Strategy（如果需要）

3 个 worktree 并行 US1 内部：

```
Worktree A: T000 (auth) → commit
Worktree B: T000 (classify) → commit
Worktree C: T000 (score) → commit
           ↓
       merge 3 → 继续 T000 → T000 → T000
```

---

## Notes

- **[P] tasks** = 不同文件，无依赖
- **[Story] label** = US1 / US2 / US3（traceability）
- **每个 commit 单独 rollback** 粒度（git revert 单文件 commit）
- **commit 前 grep 自检**（隐私红线 + 第 5 条铁律）
- **26 个 task 总计**，预计 **2-3 天**完成
- **测试不在 scope**（KR0 负责，KR0 不写新测试）
- **行为不变**（FR-008，0 行为变化是承诺）
- **GitHub auto-deploy** 链路 0 破坏（push → CF 后台 Deployments tab 验证）

---

## Next Step

**L1 SPEC 第 4 步：implement**（按 tasks.md 实际改代码）

实施流程：
1. 执行 T000-T000（Setup）
2. T000（types.ts）
3. T000/T000/T000 并行（3 个 worktree / 3 个 commit）
4. T000 → T000 → T000 串行
5. T000-T000 部署验证
6. T000-T000 KR0 铺路
7. T000-T000 Polish

每个 commit 后立即 tsc 检查，**任何 tsc 失败立即停**。

## Review Checklist for tasks.md

- [ ] 26 个 task 覆盖 Phase 1-5 + Polish？
- [ ] US1 / US2 / US3 任务切分合理？
- [ ] 并行任务标 [P] 准确？
- [ ] 文件路径都写完整？
- [ ] 依赖关系 [depends] 标对？
- [ ] 8 个 commit 拆分合理（每个独立 rollback 粒度）？
- [ ] 准备进 L1 第 4 步（implement）吗？

---

*Tasks by Mavis per Spec Kit v0.8.17 tasks-template.md · 2026-06-09 03:22 · 待 review*
