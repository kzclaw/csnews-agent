/**
 * CSNEWS Agent · 占位契约（v0.33+sweep·FT-KR0 · Phase0 · T000）
 *
 * 唯一目标：给"未来要补的契约"留入口（提示 agent 自动补）
 *
 * 工作流（业务方说"加 type=trends"时）：
 *   1. agent 改 src/pull.ts 的 TYPE_CONFIG['trends'] = {...} + 加白名单
 *   2. agent 把对应 it.skip 改成 it（去掉 .skip）
 *   3. agent 在断言行补具体业务红线（从占位的 { ... } 改成真断言）
 *   4. agent 在 pull.contract.ts 复制 parseFilters 模板，补新 type 的边界场景
 *   5. 跑 npm validate 全绿
 *
 * kzclaw只审结果（commit + 测试通过），不审过程。
 *
 * 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0
 */
import { describe, it } from 'vitest';

// ============================================================
// 未来 type 占位（v0.32 阶段）
// ============================================================
describe('_placeholders · 未来 type', () => {
  it.skip('type=trends (TODO: v0.32 trends 类型接入后补)', () => {
    // 占位：等业务方提需求后，agent 改成 it，补以下断言：
    //   - TYPE_CONFIG['trends'] 必须存在
    //   - parseFilters(type=trends) 必须 ok
    //   - parseFilters 跨 trends 的边界（limit/order/order_by）
  });

  it.skip('type=stats (TODO: v0.32 stats 类型接入后补)', () => {
    // 占位：同 trends
  });
});

// ============================================================
// 未来 classify 占位（第 11 大类）
// ============================================================
describe('_placeholders · 未来分类', () => {
  it.skip('classify 第 11 大类 (TODO: 业务方提需求后补)', () => {
    // 占位：加新分类时，agent 改成 it，补以下断言：
    //   - CATEGORY_KW['新类'] 必须存在
    //   - classifyRule(命中新类关键词) === '新类'
    //   - _structure.contract.ts 的"每个 type 必须含 6 个核心字段"自动覆盖
  });

  it.skip('classify 加新分类后兜底仍生效 (TODO: 业务方提需求后补)', () => {
    // 占位：加新分类后，"综合" 兜底不能挂
  });
});

// ============================================================
// 未来 score 占位（新权重 / 新规则）
// ============================================================
describe('_placeholders · 未来评分', () => {
  it.skip('scoreRule 加新权重 (TODO: 业务方提需求后补)', () => {
    // 占位：加新权重时，agent 改成 it，补以下断言：
    //   - 新权重加多少分
    //   - scoreRule 命中新规则时 score 必须增加相应分
    //   - scoreRule max 仍然 ≤ 7.6 或更新 AI_ROUTE_R_THRESHOLD
  });

  it.skip('hashStr 换实现（如 SHA-256）后契约不挂 (TODO: 重构时验证)', () => {
    // 占位：现在 hashStr 用 imul | 0 实现，将来换 SHA-256 也不影响业务契约
    //   - _structure.contract.ts 已守住 int32 范围 / 确定性
    //   - 这里加一个具体业务语义的契约：相同 title 生成相同 topic_key
  });
});
