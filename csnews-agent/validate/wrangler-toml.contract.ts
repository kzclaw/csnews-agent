/**
 * Wrangler.toml 关键字段 guard 测试
 *
 * 董事长 2026-07-02 00:40 push back 让我加 test · 防止 wrangler.toml 关键字段被静默删
 *
 * 背景: 6-26 commit 5507c84 删了 [observability] 块 + commit e863523 加了第 5 个 cron
 *       导致 14 天 R2 写入 broken 但 console.error 看不到 · CF 部署 schedules API 失败
 *       14 天来所有 commit 都没真部署
 *
 * 关键字段:
 * 1. [observability] enabled = true (两个 worker 都要)
 * 2. crons 总数 ≤ 5 (CF Free Plan 账户上限 5 · csnews-agent ≤ 4 · csnews-fission ≤ 1)
 * 3. [[r2_buckets]] binding = "csnews_raw" 配 bucket_name
 * 4. [[kv_namespaces]] binding = "AI_USAGE_KV" + PROCESS_STATE
 * 5. [ai] binding = "AI"
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const AGENT_TOML = path.join(ROOT, 'wrangler.toml');
const FISSION_TOML = path.join(ROOT, '../csnews-fission/wrangler.toml');

function readToml(p: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(`wrangler.toml not found at ${p}`);
  }
  return fs.readFileSync(p, 'utf-8');
}

function countCrons(toml: string): string[] {
  // 匹配 crons = [ "..." , "..." ] 数组内容
  const m = toml.match(/crons\s*=\s*\[([^\]]*)\]/);
  if (!m) return [];
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
}

function hasObservability(toml: string): boolean {
  // 必须 [observability] enabled = true 完整存在
  return /^\[observability\][\s\S]*?enabled\s*=\s*true/m.test(toml);
}

function hasR2Binding(toml: string, binding: string, bucketName?: string): boolean {
  const re = new RegExp(
    `\\[\\[r2_buckets\\]\\][\\s\\S]*?binding\\s*=\\s*"${binding}"[\\s\\S]*?(?:bucket_name\\s*=\\s*"${bucketName ?? '[^"]+'}"\\s*)?(?=\\n\\[|\\Z)`,
    'm',
  );
  return re.test(toml);
}

function hasKVBinding(toml: string, binding: string, hasId = true): boolean {
  const idPart = hasId ? '[\\s\\S]*?(?:id|preview_id)\\s*=\\s*"[0-9a-f]+"' : '';
  const re = new RegExp(
    `\\[\\[kv_namespaces\\]\\][\\s\\S]*?binding\\s*=\\s*"${binding}"${idPart}`,
    'm',
  );
  return re.test(toml);
}

function hasAIBinding(toml: string): boolean {
  return /^\[ai\][\s\S]*?binding\s*=\s*"AI"/m.test(toml);
}

describe('wrangler.toml · 两个 worker 关键字段 guard', () => {
  describe('csnews-agent/wrangler.toml', () => {
    const toml = readToml(AGENT_TOML);

    it('必须 [observability] enabled = true (否则 console.error 看不到 = 14 天 R2 broken 重演)', () => {
      expect(hasObservability(toml)).toBe(true);
    });

    it('crons 数量 ≤ 4 (CF 账户 5 · csnews-fission 用 1 · 留 1 空位给扩展)', () => {
      const crons = countCrons(toml);
      expect(crons.length).toBeLessThanOrEqual(4);
      expect(crons.length).toBeGreaterThan(0);
    });

    it('必须 [[r2_buckets]] binding = "csnews_raw" (跟 csnews-fission 共享同一 R2 bucket)', () => {
      expect(hasR2Binding(toml, 'csnews_raw')).toBe(true);
    });

    it('必须 [[kv_namespaces]] binding = "AI_USAGE_KV" (Neurons 预算追踪 KV)', () => {
      expect(hasKVBinding(toml, 'AI_USAGE_KV')).toBe(true);
    });

    it('必须 [[kv_namespaces]] binding = "PROCESS_STATE" (last_process_at 等)', () => {
      expect(hasKVBinding(toml, 'PROCESS_STATE')).toBe(true);
    });

    it('必须 [ai] binding = "AI" (Workers AI LLM 调用)', () => {
      expect(hasAIBinding(toml)).toBe(true);
    });

    it('必须 WORKER_VERSION 字段 (健康端点返回 worker_version 用)', () => {
      expect(/WORKER_VERSION\s*=\s*"[^"]+"/.test(toml)).toBe(true);
    });
  });

  describe('csnews-fission/wrangler.toml', () => {
    const toml = readToml(FISSION_TOML);

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

  describe('跨 worker 关键约束 (CF 账户级别)', () => {
    it('两个 worker crons 总数 ≤ 5 (CF Free Plan 账户上限 5 · 满了 deploy schedules API 失败 = 14 天 R2 broken 重演)', () => {
      const agentCrons = countCrons(readToml(AGENT_TOML));
      const fissionCrons = countCrons(readToml(FISSION_TOML));
      const total = agentCrons.length + fissionCrons.length;
      expect(total).toBeLessThanOrEqual(5);
    });

    it('两个 worker 都必须 R2 binding 共享同一 csnews-raw bucket (account_id 级别共享)', () => {
      const agentToml = readToml(AGENT_TOML);
      const fissionToml = readToml(FISSION_TOML);
      // 两个都引用 "csnews_raw" binding 即可 · CF 路由到同 bucket_name = "csnews-raw"
      expect(hasR2Binding(agentToml, 'csnews_raw')).toBe(true);
      expect(hasR2Binding(fissionToml, 'csnews_raw', 'csnews-raw')).toBe(true);
    });

    it('两个 worker 都必须 KV binding 共享同一 AI_USAGE_KV namespace (Neurons 预算 account 级共享)', () => {
      const agentToml = readToml(AGENT_TOML);
      const fissionToml = readToml(FISSION_TOML);
      // 提取 AI_USAGE_KV id 验证一致
      const agentId = agentToml.match(/binding\s*=\s*"AI_USAGE_KV"[\s\S]*?id\s*=\s*"([0-9a-f]+)"/)?.[1];
      const fissionId = fissionToml.match(/binding\s*=\s*"AI_USAGE_KV"[\s\S]*?id\s*=\s*"([0-9a-f]+)"/)?.[1];
      expect(agentId).toBeDefined();
      expect(fissionId).toBe(agentId);
    });
  });
});
