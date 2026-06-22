/**
 * CSNEWS Agent · 结构契约（v0.33+sweep·FT-KR0 · Phase0 · T000）
 *
 * 唯一目标：守住"未来重构不破坏接口"
 *
 * 业务红线在 score/contract.ts · classify/contract.ts · pull/contract.ts
 * 占位契约在 _placeholders.contract.ts
 *
 * 此文件测的不是业务值，是形状（shape）：
 * - 函数签名（输入参数类型 + 返回类型）
 * - 返回对象字段完整性
 * - 常量数组元素类型
 * - 字典 key 集合稳定性
 *
 * 加新业务规则（type=trends / 第 11 大类 / 新阈值）时，此文件不动。
 *
 * 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0
 */
import { describe, it, expect } from 'vitest';
import {
  hashStr,
  scoreRule,
  AI_ROUTE_R_THRESHOLD,
  TOPIC_MATCH_THRESHOLD,
  R2_DUP_THRESHOLD,
} from '../src/score';
import { classifyRule } from '../src/classify';
import {
  TYPE_CONFIG,
  VALID_LEVELS,
  VALID_STATUS,
  VALID_STAGES,
  VALID_FORMATS,
  parseFilters,
  type TypeConfig,
} from '../src/pull';

// ============================================================
// hashStr 结构契约
// ============================================================
describe('_structure · hashStr', () => {
  it('必须接受 string 参数（不接受 number / null / undefined）', () => {
    // 编译时类型检查：传入非 string TS 会报错
    // 运行时验证：返回类型必须是 number
    const result = hashStr('test');
    expect(typeof result).toBe('number');
  });

  it('返回值必须是 number（不是 string / bigint / null）', () => {
    const result = hashStr('hello');
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
  });

  it('返回值必须是 int32 范围（-2^31 ~ 2^31-1）', () => {
    // 业务契约：hashStr 用于 topic_key 生成，必须落在 int32 范围
    // （imul | 0 保证落在 [-2147483648, 2147483647]）
    const samples = ['', 'a', '中文', 'emoji 😀', 'x'.repeat(10000)];
    for (const s of samples) {
      const h = hashStr(s);
      expect(h).toBeGreaterThanOrEqual(-2147483648);
      expect(h).toBeLessThanOrEqual(2147483647);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('同输入必须返回同结果（确定性）', () => {
    const a = hashStr('CSNEWS-AGENT-v0.33+sweep');
    const b = hashStr('CSNEWS-AGENT-v0.33+sweep');
    expect(a).toBe(b);
  });
});

// ============================================================
// scoreRule 结构契约
// ============================================================
describe('_structure · scoreRule', () => {
  it('必须接受 string 参数', () => {
    const result = scoreRule('test title');
    expect(result).toBeTruthy();
  });

  it('返回 shape 必须是 { score: number, reason: string, isHigh: boolean }', () => {
    const result = scoreRule('OpenAI 发布 GPT-5');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('isHigh');
    expect(typeof result.score).toBe('number');
    expect(typeof result.reason).toBe('string');
    expect(typeof result.isHigh).toBe('boolean');
  });

  it('isHigh 必须等于 score >= AI_ROUTE_R_THRESHOLD', () => {
    // 业务契约：AI routing 路由决策完全基于 score vs 阈值
    const samples = [
      '普通新闻', // 无热词 → score < 7.0
      'OpenAI 发布 GPT-5', // 命中 OpenAI + AI → 普通热词
      '突发：OpenAI 紧急发布 GPT-5', // 命中 OpenAI + 突发/紧急（超热）
    ];
    for (const s of samples) {
      const { score, isHigh } = scoreRule(s);
      expect(isHigh).toBe(score >= AI_ROUTE_R_THRESHOLD);
    }
  });

  it('score 必须落在 [0, 10] 范围', () => {
    // 业务契约：Math.min(10, ...) 兜底
    const samples = [
      '突发！重磅！紧急！OpenAI 1.0.0 测试 12345!', // 全命中
      '',
      'a',
      'x'.repeat(1000),
    ];
    for (const s of samples) {
      const { score } = scoreRule(s);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(10);
    }
  });

  it('reason 字段必须包含 5 个业务标记（热词/超热/数字/长/多热）', () => {
    const { reason } = scoreRule('OpenAI 紧急发布 GPT-5');
    // 业务契约：reason 是调试信息，必须可追溯
    expect(reason).toContain('热词');
    expect(reason).toContain('超热');
    expect(reason).toContain('数字');
    expect(reason).toContain('长');
    expect(reason).toContain('多热');
  });
});

// ============================================================
// 阈值常量结构契约
// ============================================================
describe('_structure · 阈值常量', () => {
  it('AI_ROUTE_R_THRESHOLD 必须是 number 且 ≤ 7.6', () => {
    // 业务契约：scoreRule max=7.6，阈值必须 ≤7.6 否则 unreachable
    expect(typeof AI_ROUTE_R_THRESHOLD).toBe('number');
    expect(AI_ROUTE_R_THRESHOLD).toBeGreaterThan(0);
    expect(AI_ROUTE_R_THRESHOLD).toBeLessThanOrEqual(7.6);
  });

  it('TOPIC_MATCH_THRESHOLD 必须在 [0, 1]', () => {
    // 业务契约：相似度阈值
    expect(typeof TOPIC_MATCH_THRESHOLD).toBe('number');
    expect(TOPIC_MATCH_THRESHOLD).toBeGreaterThanOrEqual(0);
    expect(TOPIC_MATCH_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('R2_DUP_THRESHOLD 必须在 [0, 1]', () => {
    // 业务契约：去重阈值
    expect(typeof R2_DUP_THRESHOLD).toBe('number');
    expect(R2_DUP_THRESHOLD).toBeGreaterThanOrEqual(0);
    expect(R2_DUP_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// classifyRule 结构契约
// ============================================================
describe('_structure · classifyRule', () => {
  it('必须接受 string 参数并返回 string', () => {
    const result = classifyRule('OpenAI 发布 GPT-5');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('返回值不能是空字符串', () => {
    // 业务契约：分类必须兜底到 "综合" 或具体类别
    const result = classifyRule('xxx-no-keyword-xxx');
    expect(result).not.toBe('');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ============================================================
// TYPE_CONFIG 结构契约
// ============================================================
describe('_structure · TYPE_CONFIG', () => {
  it('必须是 Record<string, TypeConfig>（字典类型）', () => {
    expect(typeof TYPE_CONFIG).toBe('object');
    expect(TYPE_CONFIG).not.toBeNull();
    expect(Array.isArray(TYPE_CONFIG)).toBe(false);
  });

  it('每个 type 的 TypeConfig 必须含 6 个核心字段', () => {
    // 业务契约：TypeConfig 接口稳定（防漏字段）
    const requiredFields: (keyof TypeConfig)[] = [
      'table',
      'defaultOrderBy',
      'allowedOrderBy',
      'defaultSelect',
      'allowedFilters',
      'timeField',
    ];
    for (const [type, config] of Object.entries(TYPE_CONFIG)) {
      for (const field of requiredFields) {
        expect(config, `TYPE_CONFIG[${type}] 缺少字段 ${field}`).toHaveProperty(field);
        expect(config[field], `TYPE_CONFIG[${type}].${field} 不能为空`).toBeTruthy();
      }
    }
  });

  it('每个 type 的 allowedOrderBy 必须是 string[]', () => {
    for (const [type, config] of Object.entries(TYPE_CONFIG)) {
      expect(
        Array.isArray(config.allowedOrderBy),
        `TYPE_CONFIG[${type}].allowedOrderBy 不是数组`
      ).toBe(true);
      expect(
        config.allowedOrderBy.length,
        `TYPE_CONFIG[${type}].allowedOrderBy 不能为空`
      ).toBeGreaterThan(0);
    }
  });

  it('每个 type 的 allowedFilters 必须是 string[]', () => {
    for (const [type, config] of Object.entries(TYPE_CONFIG)) {
      expect(
        Array.isArray(config.allowedFilters),
        `TYPE_CONFIG[${type}].allowedFilters 不是数组`
      ).toBe(true);
    }
  });

  it('至少包含 4 个 type（news/topics/warnings/fission-pending）', () => {
    // 业务契约：v0.31 阶段 4 个 type 是底线，加新 type 不影响
    const types = Object.keys(TYPE_CONFIG);
    expect(types.length).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// parseFilters 结构契约
// ============================================================
describe('_structure · parseFilters', () => {
  it('必须接受 URL 参数', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    expect(result).toBeTruthy();
  });

  it('返回 shape 必须是 discriminated union（{ok:true,filters} | {ok:false,error}）', () => {
    // 业务契约：handlePull 用 !parsed.ok 判断走 error 分支
    const urlOk = new URL('https://example.com/?type=news');
    const resultOk = parseFilters(urlOk);
    if (resultOk.ok) {
      expect(resultOk).toHaveProperty('filters');
    } else {
      expect(resultOk).toHaveProperty('error');
      expect(typeof resultOk.error).toBe('string');
    }
  });

  it('成功时 filters 必须含 type / limit / order / orderBy / format', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    if (result.ok) {
      expect(result.filters).toHaveProperty('type');
      expect(result.filters).toHaveProperty('limit');
      expect(result.filters).toHaveProperty('order');
      expect(result.filters).toHaveProperty('orderBy');
      expect(result.filters).toHaveProperty('format');
    }
  });

  it('失败时 error 必须是 string', () => {
    const url = new URL('https://example.com/');
    const result = parseFilters(url);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// VALID_* 常量结构契约
// ============================================================
describe('_structure · VALID_* 白名单常量', () => {
  it('VALID_LEVELS 必须是 string[] 且至少含 3 个核心等级', () => {
    // 业务契约：follow/important/explosive 是 3 个核心等级
    expect(Array.isArray(VALID_LEVELS)).toBe(true);
    expect(VALID_LEVELS.length).toBeGreaterThanOrEqual(3);
    for (const level of VALID_LEVELS) {
      expect(typeof level).toBe('string');
    }
  });

  it('VALID_STATUS 必须是 string[] 且至少含 5 个核心状态', () => {
    // 业务契约：open/acknowledged/validated/dismissed/closed 是 5 个核心状态
    expect(Array.isArray(VALID_STATUS)).toBe(true);
    expect(VALID_STATUS.length).toBeGreaterThanOrEqual(5);
    for (const status of VALID_STATUS) {
      expect(typeof status).toBe('string');
    }
  });

  it('VALID_STAGES 必须是 string[] 且至少含 5 个阶段', () => {
    // 业务契约：emerging/growing/hot/mature/declining
    expect(Array.isArray(VALID_STAGES)).toBe(true);
    expect(VALID_STAGES.length).toBeGreaterThanOrEqual(5);
    for (const stage of VALID_STAGES) {
      expect(typeof stage).toBe('string');
    }
  });

  it('VALID_FORMATS 必须是 string[] 且恰好含 3 个格式（ids/summary/full）', () => {
    // 业务契约：format 固定 3 档
    expect(Array.isArray(VALID_FORMATS)).toBe(true);
    expect(VALID_FORMATS).toEqual(['ids', 'summary', 'full']);
  });
});
