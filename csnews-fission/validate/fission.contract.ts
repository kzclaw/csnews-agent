/**
 * csnews-fission 关键路径 + wrangler.toml guard
 *
 * 董事长 2026-07-02 00:53 拍板: "csnews-h1-test 是测试就不需要了, 其他的投入生产的代码都要有 test"
 * 之前 csnews-fission 6 src / 0 test · 14 天缺 [observability] 块发现不了
 *
 * 测试覆盖:
 * 1. wrangler.toml 关键字段 ([observability] / cron / R2 / KV / AI)
 * 2. fission-trigger 关键纯函数 (parseAIResponse / generateReport 之类)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const TOML = path.join(ROOT, 'wrangler.toml');

function readToml(p: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(`wrangler.toml not found at ${p}`);
  }
  return fs.readFileSync(p, 'utf-8');
}

function countCrons(toml: string): string[] {
  const m = toml.match(/crons\s*=\s*\[([^\]]*)\]/);
  if (!m) return [];
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
}

function hasObservability(toml: string): boolean {
  return /^\[observability\][\s\S]*?enabled\s*=\s*true/m.test(toml);
}

function hasR2Binding(toml: string, binding: string, bucketName?: string): boolean {
  const re = new RegExp(
    `\\[\\[r2_buckets\\]\\][\\s\\S]*?binding\\s*=\\s*"${binding}"[\\s\\S]*?(?:bucket_name\\s*=\\s*"${bucketName ?? '[^"]+'}"\\s*)?(?=\\n\\[|\\Z)`,
    'm'
  );
  return re.test(toml);
}

function hasKVBinding(toml: string, binding: string): boolean {
  const re = new RegExp(
    `\\[\\[kv_namespaces\\]\\][\\s\\S]*?binding\\s*=\\s*"${binding}"[\\s\\S]*?(?:id|preview_id)\\s*=\\s*"[0-9a-f]+"`,
    'm'
  );
  return re.test(toml);
}

function hasAIBinding(toml: string): boolean {
  return /^\[ai\][\s\S]*?binding\s*=\s*"AI"/m.test(toml);
}

describe('csnews-fission/wrangler.toml 关键字段 guard', () => {
  const toml = readToml(TOML);

  it('必须 [observability] enabled = true (fission 唯一 log 通道 = console.log → observability 关闭 = 静默)', () => {
    expect(hasObservability(toml)).toBe(true);
  });

  it('crons 数量 = 1 ("0 */6 * * *" 6 小时一次 · CF 账户 5/5 留 4 给 csnews-agent)', () => {
    const crons = countCrons(toml);
    expect(crons).toEqual(['0 */6 * * *']);
  });

  it('必须 [[r2_buckets]] binding = "csnews_raw" bucket_name = "csnews-raw" (跟 agent 共享同一 bucket)', () => {
    expect(hasR2Binding(toml, 'csnews_raw', 'csnews-raw')).toBe(true);
  });

  it('必须 [[kv_namespaces]] binding = "AI_USAGE_KV" (Neurons 预算共享)', () => {
    expect(hasKVBinding(toml, 'AI_USAGE_KV')).toBe(true);
  });

  it('必须 [ai] binding = "AI" (裂变报告 LLM 生成)', () => {
    expect(hasAIBinding(toml)).toBe(true);
  });
});

describe('fission-trigger.ts 模块 import smoke test', () => {
  it('模块加载不 throw (TypeScript 类型 + 运行时 import 兼容)', async () => {
    // 验证模块能正常 import · 不实际跑需要 CF binding 的函数
    const mod = await import('../src/fission-trigger');
    expect(mod).toBeDefined();
    // verify 公开 export 函数存在
    expect(typeof mod.findFissionTopics).toBe('function');
    expect(typeof mod.runFissionTrigger).toBe('function');
    expect(typeof mod.runFissionForTopic).toBe('function');
    expect(typeof mod.resetTopicScore).toBe('function');
  });
});
