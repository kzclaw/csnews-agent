/**
 * CSNEWS Agent · score 业务红线契约（v0.33+sweep·FT-KR0 · Phase0 · T000）
 *
 * 唯一目标：守住"业务规则就是这样"（当前实现的 snapshot）
 *
 * 业务红线：
 *   - hashStr:确定性 hash，int32 范围
 *   - scoreRule:超热词 +2 / 普通热词 +1.2 / 数字 +0.5 / 长度 20-35 +0.3 / !? +0.3 / 多热词累加
 *
 * 加新业务规则时（_placeholders.contract.ts "scoreRule 加新权重"），
 * 此文件补 it 块。不影响 _structure.contract.ts（shape 不变）。
 *
 * 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0
 */
import { describe, it, expect } from 'vitest';
import { hashStr, scoreRule } from '../src/score';

// ============================================================
// hashStr 业务红线
// ============================================================
describe('hashStr · 业务红线', () => {
  it('同输入必须返回同结果（确定性）', () => {
    const samples = ['CSNEWS-AGENT-v0.33+sweep', 'topic-key-12345', '今日 OpenAI 发布 GPT-5'];
    for (const s of samples) {
      expect(hashStr(s)).toBe(hashStr(s));
    }
  });

  it('空字符串必须返回 0', () => {
    // 业务契约：imul(31, 0) + 0 | 0 = 0
    expect(hashStr('')).toBe(0);
  });

  it('中文标题不能 throw（中文 2 字节/字符不影响 imul）', () => {
    const samples = ['今日头条', '突发：OpenAI 发布 GPT-5', '联合国大会讨论气候变化'];
    for (const s of samples) {
      expect(() => hashStr(s)).not.toThrow();
      expect(typeof hashStr(s)).toBe('number');
    }
  });

  it('emoji / Unicode 不能 throw', () => {
    const samples = [
      '😀 emoji 测试',
      '🚀 breaking news',
      'café résumé', // 重音字符
    ];
    for (const s of samples) {
      expect(() => hashStr(s)).not.toThrow();
    }
  });

  it('特殊字符不能 throw（\\n \\t \\ " 都不影响）', () => {
    const samples = ['line1\nline2', 'tab\there', 'quote"inside', 'backslash\\path'];
    for (const s of samples) {
      expect(() => hashStr(s)).not.toThrow();
    }
  });

  it('超长字符串（>10k 字符）不能 throw 或卡死', () => {
    const long = 'x'.repeat(20000);
    const start = Date.now();
    const result = hashStr(long);
    const elapsed = Date.now() - start;
    expect(typeof result).toBe('number');
    expect(elapsed).toBeLessThan(1000); // 1s 内必须返回
  });

  it('不同输入大概率返回不同 hash（避免高频碰撞）', () => {
    // 业务契约：topic_key 生成必须分散
    const samples = ['a', 'b', 'c', 'd', 'e', 'topic-1', 'topic-2', 'topic-3'];
    const hashes = new Set(samples.map((s) => hashStr(s)));
    expect(hashes.size).toBe(samples.length); // 8 个不同输入 → 8 个不同 hash
  });
});

// ============================================================
// scoreRule 业务红线
// ============================================================
describe('scoreRule · 业务红线（权重）', () => {
  it('超热词（紧急）必须 +2 分', () => {
    // 5.0 base + 2.0 (超热) = 7.0
    const { score } = scoreRule('紧急通知');
    expect(score).toBe(7.0);
  });

  it('超热词（突发）必须 +2 分', () => {
    const { score } = scoreRule('突发新闻');
    expect(score).toBe(7.0);
  });

  it('超热词（重磅）必须 +2 分', () => {
    const { score } = scoreRule('重磅发布');
    expect(score).toBe(7.0);
  });

  it('超热词互斥（同时命中多个超热词只 +2 一次）', () => {
    // 业务契约：superHot.some + else if(hasHot) — 互斥
    // 注意：hotWords 含 superHot，所以"紧急突发重磅"hotCount=3 → +0.5
    // 5.0 (base) + 2.0 (superHot) + 0.5 (hotCount≥3) = 7.5
    const { score } = scoreRule('紧急突发重磅');
    expect(score).toBe(7.5);
  });

  it('普通热词（不含超热但含其他热词）必须 +1.2 分', () => {
    // 命中"震惊"（hotWords 但不在 superHot）→ 5.0 + 1.2 = 6.2
    const { score } = scoreRule('震惊！某事件');
    expect(score).toBe(6.2);
  });

  it('含数字必须 +0.5 分', () => {
    // 5.0 base + 0.5 (数字) = 5.5
    const { score } = scoreRule('OpenAI 发布 GPT5');
    expect(score).toBe(5.5);
  });

  it('长度 21-34 必须 +0.3 分（边界 21，开区间）', () => {
    // 业务契约：len > 20 && len < 35（开区间，21-34 加分）
    const title = 'a'.repeat(21);
    const { score } = scoreRule(title);
    expect(score).toBe(5.3);
  });

  it('长度 21-34 必须 +0.3 分（边界 34，开区间）', () => {
    const title = 'a'.repeat(34);
    const { score } = scoreRule(title);
    expect(score).toBe(5.3);
  });

  it('长度 20 不加 0.3（边界外，开区间）', () => {
    // len > 20 才加分，20 不大于 20
    const title = 'a'.repeat(20);
    const { score } = scoreRule(title);
    expect(score).toBe(5.0);
  });

  it('长度 35 不加 0.3（边界外，开区间）', () => {
    // len < 35 才加分，35 不小于 35
    const title = 'a'.repeat(35);
    const { score } = scoreRule(title);
    expect(score).toBe(5.0);
  });

  it('含 ! 必须 +0.3 分', () => {
    const { score } = scoreRule('普通标题!');
    expect(score).toBe(5.3);
  });

  it('含 ? 必须 +0.3 分', () => {
    const { score } = scoreRule('普通标题?');
    expect(score).toBe(5.3);
  });

  it('同时含 ! 和 ? 只 +0.3 一次（互斥）', () => {
    const { score } = scoreRule('普通标题!?');
    expect(score).toBe(5.3);
  });

  it('多热词 ≥3 必须额外 +0.5', () => {
    // 命中 3 个 hotWords（震惊/重磅/突破）→ hotCount=3
    // 5.0 + 2.0 (重磅算超热，但 hotWords.includes 也算上) + 0.5 = 7.5
    // 注意：重磅在 hotWords 也计入 hotCount
    const { score } = scoreRule('震惊重磅突破');
    expect(score).toBe(7.5);
  });

  it('多热词 =2 必须额外 +0.3', () => {
    // 命中 2 个 hotWords（震惊/突破，不含超热）→ hotCount=2
    // 5.0 + 1.2 (震惊 普通热词) + 0.3 (多热词) = 6.5
    const { score } = scoreRule('震惊突破');
    expect(score).toBe(6.5);
  });

  it('无任何命中必须 score=5.0 base', () => {
    const { score } = scoreRule('普通新闻');
    expect(score).toBe(5.0);
  });

  it('最大值 ≤8.6（基线5+超热2+数字0.5+长度0.3+!?0.3+多热词≥3 加 0.5）', () => {
    // 全命中：5.0 + 2.0 (superHot) + 0.5 (数字) + 0.3 (长度) + 0.3 (!) + 0.5 (hotCount≥3)
    // = 8.6，Math.min(10, ...) 兜底
    const { score } = scoreRule('紧急突发重磅123!震惊突破');
    expect(score).toBeLessThanOrEqual(8.6);
  });
});

describe('scoreRule · 业务红线（输出格式）', () => {
  it('score 必须保留 1 位小数（round）', () => {
    // 5.0 + 1.2 = 6.2（已是 1 位）
    const { score } = scoreRule('震惊事件');
    expect(score).toBe(6.2);
    // 验证不是 6.200000000001 之类的浮点误差
    expect(score.toFixed(1)).toBe(score.toString());
  });

  it('score 必须落在 [0, 10] 范围（Math.min 兜底）', () => {
    const { score } = scoreRule('紧急!123!');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('isHigh 必须等于 score ≥ AI_ROUTE_R_THRESHOLD', () => {
    // 超热词触发 → score=7.0 → isHigh = (7.0 >= 7.0) = true
    const a = scoreRule('紧急事件');
    expect(a.isHigh).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(7.0);

    // 无命中 → score=5.0 → isHigh = false
    const b = scoreRule('普通新闻');
    expect(b.isHigh).toBe(false);
  });
});
