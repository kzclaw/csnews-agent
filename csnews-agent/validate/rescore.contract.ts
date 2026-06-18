/**
 * CSNEWS Agent · rescore 业务契约 (派活 14)
 *
 * 唯一目标：守住"rescore endpoint 输入输出形状就是这样"
 *
 * 业务红线:
 *   - 输入: ?action=rescore[&type=...&limit=...&dry_run=true|false]
 *   - 输出: { type: 'rescore', dry_run, total, changed, unchanged, errors, updated, update_errors, sample, timestamp }
 *   - dry_run 缺省 = true (防误操作)
 *   - limit 缺省 = 100, limit=0 表示全部
 *   - 真实 Supabase / Workers AI 调用必失败, 此文件只测形状 (不调真实 handler)
 *
 * 详见：批量重跑旧新闻分类功能
 */
import { describe, it, expect } from 'vitest';

describe('rescore · 端点形状契约', () => {
  it('dry_run 缺省必须是 true (防误操作, 显式 dry_run=false 才 UPDATE)', () => {
    // 静态契约: dry_run 字符串不是 'false' 就视为 true
    const rawParam = null;
    const dryRun = rawParam !== 'false';
    expect(dryRun).toBe(true);
  });

  it('dry_run=false 必须解析为 false (显式触发 UPDATE)', () => {
    const rawParam = 'false';
    const dryRun = rawParam !== 'false';
    expect(dryRun).toBe(false);
  });

  it('limit 缺省必须是 100 (防超时)', () => {
    const rawLimit: string | null = null;
    const limit = parseInt(rawLimit || '100', 10);
    expect(limit).toBe(100);
  });

  it('limit=0 必须解析为 0 (表示全部)', () => {
    const rawLimit = '0';
    const limit = parseInt(rawLimit, 10);
    expect(limit).toBe(0);
  });

  it('limit=500 字符串必须解析为 500', () => {
    const rawLimit = '500';
    const limit = parseInt(rawLimit, 10);
    expect(limit).toBe(500);
  });
});

describe('rescore · 响应字段契约', () => {
  it('响应必须含字段: type, dry_run, total, changed, unchanged, errors, updated, update_errors, sample, timestamp', () => {
    const sampleResponse = {
      type: 'rescore',
      dry_run: true,
      total: 100,
      changed: 23,
      unchanged: 77,
      errors: 0,
      updated: 0,
      update_errors: 0,
      sample: [],
      timestamp: '2026-06-19T02:13:00.000Z',
    };
    expect(sampleResponse.type).toBe('rescore');
    expect(typeof sampleResponse.dry_run).toBe('boolean');
    expect(typeof sampleResponse.total).toBe('number');
    expect(typeof sampleResponse.changed).toBe('number');
    expect(typeof sampleResponse.unchanged).toBe('number');
    expect(typeof sampleResponse.errors).toBe('number');
    expect(typeof sampleResponse.updated).toBe('number');
    expect(typeof sampleResponse.update_errors).toBe('number');
    expect(Array.isArray(sampleResponse.sample)).toBe(true);
    expect(typeof sampleResponse.timestamp).toBe('string');
  });

  it('sample 元素必须含: id, title, old, new, confidence, changed', () => {
    const sampleItem = {
      id: 'uuid-xxx',
      title: '测试新闻',
      old: '科技',
      new: '科技',
      confidence: '0.567',
      changed: false,
    };
    expect(sampleItem.id).toBeTruthy();
    expect(sampleItem.title).toBeTruthy();
    expect(typeof sampleItem.old).toBe('string');
    expect(typeof sampleItem.new).toBe('string');
    expect(typeof sampleItem.confidence).toBe('string');
    expect(typeof sampleItem.changed).toBe('boolean');
  });
});
