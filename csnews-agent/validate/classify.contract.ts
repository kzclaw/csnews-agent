/**
 * CSNEWS Agent · classify 业务红线契约（v0.33+sweep·FT-KR0 · Phase0 · T000）
 *
 * 唯一目标：守住"分类业务规则就是这样"（当前实现的 snapshot）
 *
 * 业务红线：
 *   - classifyRule: 10 大类（科技/财经/国际/社会/娱乐/体育/房产/汽车/消费/法律）+ "综合" 兜底
 *   - 命中顺序按 CATEGORY_KW 字典顺序（Object.entries 遍历）
 *
 * 加新分类时（_placeholders.contract.ts "第 11 大类"），此文件补 it 块。
 *
 * 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0
 */
import { describe, it, expect } from 'vitest';
import { classifyRule } from '../src/classify';

// ============================================================
// 10 大类业务红线（每类 1 个代表性关键词）
// ============================================================
describe('classifyRule · 10 大类', () => {
  it('命中 OpenAI 必须分类为 "科技"', () => {
    expect(classifyRule('OpenAI 发布 GPT-5')).toBe('科技');
  });

  it('命中 ChatGPT 必须分类为 "科技"', () => {
    expect(classifyRule('ChatGPT 新功能')).toBe('科技');
  });

  it('命中 芯片 必须分类为 "科技"', () => {
    expect(classifyRule('国产芯片突破')).toBe('科技');
  });

  it('命中 股市 必须分类为 "财经"', () => {
    expect(classifyRule('今日股市行情')).toBe('财经');
  });

  it('命中 涨停 必须分类为 "财经"', () => {
    expect(classifyRule('某股票涨停')).toBe('财经');
  });

  it('命中 联合国 必须分类为 "国际"', () => {
    expect(classifyRule('联合国大会召开')).toBe('国际');
  });

  it('命中 欧盟 必须分类为 "国际"', () => {
    expect(classifyRule('欧盟新政策')).toBe('国际');
  });

  it('命中 事故 必须分类为 "社会"', () => {
    expect(classifyRule('某地事故')).toBe('社会');
  });

  it('命中 票房 必须分类为 "娱乐"', () => {
    expect(classifyRule('春节票房创新高')).toBe('娱乐');
  });

  it('命中 NBA 必须分类为 "体育"', () => {
    expect(classifyRule('NBA 总决赛')).toBe('体育');
  });

  it('命中 房价 必须分类为 "房产"', () => {
    expect(classifyRule('一线城市房价')).toBe('房产');
  });

  it('命中 新能源 必须分类为 "汽车"', () => {
    expect(classifyRule('新能源车上市')).toBe('汽车');
  });

  it('命中 茅台 必须分类为 "消费"', () => {
    expect(classifyRule('茅台涨价')).toBe('消费');
  });

  it('命中 判刑 必须分类为 "法律"', () => {
    expect(classifyRule('某人被判刑')).toBe('法律');
  });
});

// ============================================================
// "综合" 兜底业务红线
// ============================================================
describe('classifyRule · "综合" 兜底', () => {
  it('无任何关键词命中必须返回 "综合"', () => {
    expect(classifyRule('xxx-no-keyword-xxx')).toBe('综合');
  });

  it('空字符串必须返回 "综合"', () => {
    expect(classifyRule('')).toBe('综合');
  });

  it('纯标点符号必须返回 "综合"', () => {
    expect(classifyRule('!!!')).toBe('综合');
  });

  it('完全不相关词必须返回 "综合"', () => {
    expect(classifyRule('今天天气不错')).toBe('综合');
  });
});

// ============================================================
// 边界条件
// ============================================================
describe('classifyRule · 边界', () => {
  it('中英混合标题不能 throw', () => {
    expect(() => classifyRule('OpenAI 发布 GPT-5 引发讨论')).not.toThrow();
    expect(classifyRule('OpenAI 发布 GPT-5 引发讨论')).toBe('科技');
  });

  it('含 ! ? , . 的标题不影响分类', () => {
    expect(classifyRule('股市!!!')).toBe('财经');
    expect(classifyRule('票房?')).toBe('娱乐');
    expect(classifyRule('房价,涨了')).toBe('房产');
  });

  it('大小写敏感（关键词原样匹配）', () => {
    // OpenAI 在 CATEGORY_KW 里是 "OpenAI"（首字母大写）
    expect(classifyRule('openai 发布')).toBe('综合'); // 小写不命中
    expect(classifyRule('OpenAI 发布')).toBe('科技'); // 大写命中
  });

  it('跨分类多关键词 → 按字典顺序第一个命中类', () => {
    // CATEGORY_KW 顺序：科技 → 财经 → 国际 → 社会 → 娱乐 → 体育 → 房产 → 汽车 → 消费 → 法律
    // OpenAI（科技） + 票房（娱乐）→ 第一个是"科技"
    expect(classifyRule('OpenAI 与票房')).toBe('科技');
    // 票房（娱乐） + 判刑（法律）→ "娱乐"先于"法律"
    expect(classifyRule('票房与判刑')).toBe('娱乐');
  });

  it('关键词作为子串也命中（includes 匹配）', () => {
    // "联合国" 在 "联合国大会" 里命中
    expect(classifyRule('联合国大会')).toBe('国际');
    // "NBA" 在 "NBA 总决赛" 里命中
    expect(classifyRule('NBA 总决赛')).toBe('体育');
  });
});

// ============================================================
// classifyRule 稳定性契约
// ============================================================
describe('classifyRule · 稳定性', () => {
  it('同输入必须返回同结果（确定性）', () => {
    const samples = [
      'OpenAI 发布 GPT-5',
      '联合国大会',
      '股市行情',
      'xxx',
    ];
    for (const s of samples) {
      expect(classifyRule(s)).toBe(classifyRule(s));
    }
  });

  it('返回值必须是 string 长度 ≥2（中文类别 2 字符）', () => {
    const samples = ['OpenAI', '票房', 'xxx', '', '!!!'];
    for (const s of samples) {
      const result = classifyRule(s);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThanOrEqual(2);
    }
  });
});