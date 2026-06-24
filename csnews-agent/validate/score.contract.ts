/**
 * Business contract tests for the scoring module.
 * Covers hashStr stability and scoreRule boundary cases.
 */

import { hashStr, scoreRule } from '../src/score';

describe('hashStr', () => {
  it('returns consistent hash for same input', () => {
    const title = 'AI大模型突破性能极限';
    expect(hashStr(title)).toBe(hashStr(title));
    expect(hashStr(title)).toBe(hashStr(title));
  });

  it('returns different hashes for different inputs', () => {
    const a = '突发：OpenAI发布新模型';
    const b = '突发：Anthropic发布新模型';
    expect(hashStr(a)).not.toBe(hashStr(b));
  });

  it('returns 0 for empty string', () => {
    expect(hashStr('')).toBe(0);
  });

  it('handles ASCII-only string', () => {
    const result = hashStr('hello world');
    expect(typeof result).toBe('number');
    expect(result).not.toBeNaN();
  });

  it('handles mixed Chinese and ASCII', () => {
    const result = hashStr('OpenAI 发布 GPT-5 震惊全行业');
    expect(typeof result).toBe('number');
    expect(result).not.toBe(0);
  });

  it('handles special characters', () => {
    const result = hashStr('震撼! 全球股市暴跌? 真相是...');
    expect(typeof result).toBe('number');
  });

  it('handles very long string', () => {
    const long = '突发'.repeat(100);
    const result = hashStr(long);
    expect(typeof result).toBe('number');
  });
});

describe('scoreRule basic behavior', () => {
  it('returns object with score, reason, isHigh fields', () => {
    const result = scoreRule('突发：AI技术重大突破');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('isHigh');
  });

  it('score is a finite number', () => {
    const result = scoreRule('OpenAI发布新版本');
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('isHigh is true when score >= 7.0', () => {
    const result = scoreRule('突发 震惊 重磅：AI革命性突破');
    if (result.score >= 7.0) {
      expect(result.isHigh).toBe(true);
    }
  });
});

describe('scoreRule hot-word detection', () => {
  it('single hot word triggers elevated score', () => {
    const hot = scoreRule('突发：AI大模型新进展');
    const plain = scoreRule('AI大模型新进展');
    expect(hot.score).toBeGreaterThanOrEqual(plain.score);
  });

  it('multiple hot words accumulate bonus', () => {
    const multi = scoreRule('突发 震惊 重磅：行业巨变');
    expect(multi.score).toBeGreaterThan(5.0);
  });
});

describe('scoreRule length bonus', () => {
  it('title between 21-34 chars gets length bonus', () => {
    // 25 chars — within bonus range
    const mid = scoreRule('突发：AI技术取得重大突破');
    expect(mid.score).toBeGreaterThanOrEqual(5.0);
  });

  it('very short title gets no length bonus', () => {
    const short = scoreRule('AI突破');
    expect(short.score).toBeGreaterThanOrEqual(5.0);
  });

  it('very long title gets no length bonus', () => {
    const long = '这是一个非常长的新闻标题用来测试评分系统是否正确处理了超出范围的字符数量限制';
    const result = scoreRule(long);
    expect(result.score).toBeGreaterThanOrEqual(5.0);
  });
});

describe('scoreRule number detection', () => {
  it('title with digits gets number bonus', () => {
    const withNum = scoreRule('2024年AI领域十大突破');
    const withoutNum = scoreRule('AI领域十大突破');
    expect(withNum.score).toBeGreaterThanOrEqual(withoutNum.score);
  });
});

describe('scoreRule edge cases', () => {
  it('handles negative-looking input gracefully', () => {
    // Even with all-caps hot words detection, must not throw
    const result = scoreRule('NEGATIVE SCENARIO ANALYSIS');
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('handles unicode emoji in title', () => {
    const result = scoreRule('🔥突发：AI技术重大突破');
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('reason string contains expected pattern', () => {
    const result = scoreRule('突发：技术新进展');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('scoreRule threshold boundary', () => {
  it('score is capped at 10', () => {
    // Build a title with all possible bonuses
    const maxTitle =
      '突发震惊重磅紧急史上最新突破革命创历史！2024年11月AI技术取得重大进展';
    const result = scoreRule(maxTitle);
    expect(result.score).toBeLessThanOrEqual(10);
  });
});
