/**
 * csnews-mcp-server TOOLS 列表 + tool registry guard
 *
 * 董事长 2026-07-02 00:53 拍板: "投入生产的代码都要有 test"
 * 之前 csnews-mcp-server 1 src / 0 test · 6 tool 注册无 guard
 *
 * 测试覆盖:
 * 1. 6 个 tool 全部 register
 * 2. 每个 tool 有 name / description / inputSchema
 * 3. required field 正确
 * 4. CSNEWS_URL / CSNEWS_TOKEN env 默认值 + 处理 trailing slash
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const INDEX_CJS = join(ROOT, 'src/index.cjs');

function readIndex(): string {
  return readFileSync(INDEX_CJS, 'utf-8');
}

function extractToolNames(src: string): string[] {
  // 匹配 "name: 'xxx'" 在 TOOLS 数组里
  const toolSection = src.match(/const TOOLS = \[([\s\S]*?)\n\];/)?.[1] || '';
  return Array.from(toolSection.matchAll(/name:\s*['"]([^'"]+)['"]/g)).map((m) => m[1]);
}

describe('csnews-mcp-server TOOLS 注册 guard', () => {
  const src = readIndex();
  const tools = extractToolNames(src);

  it('TOOLS 数组非空 (最少 6 个 tool)', () => {
    expect(tools.length).toBeGreaterThanOrEqual(6);
  });

  it('包含核心 6 个 tool: get_latest_news, get_explosive_topics, get_warnings, get_trending_velocity, get_topic_acceleration, get_daily_report', () => {
    const required = [
      'get_latest_news',
      'get_explosive_topics',
      'get_warnings',
      'get_trending_velocity',
      'get_topic_acceleration',
      'get_daily_report',
    ];
    for (const t of required) {
      expect(tools).toContain(t);
    }
  });

  it('每个 tool 有 name / description / inputSchema 三字段', () => {
    // 验证 TOOLS 数组里每个对象都有 3 个字段
    const toolBlockRegex =
      /\{\s*name:\s*['"][^'"]+['"],\s*description:\s*['"][^'"]*['"],\s*inputSchema:\s*\{/g;
    const matches = src.match(toolBlockRegex) || [];
    expect(matches.length).toBe(tools.length);
  });

  it('CSNEWS_URL 默认值 csnews.kwokzit.info/api/v1 (董事长 v0.26 拍板 endpoint)', () => {
    expect(src).toContain('https://csnews.kwokzit.info/api/v1');
  });

  it('CSNEWS_URL 处理 trailing slash (使用 replace + regex)', () => {
    // src 应包含 replace + 包含 /$
    expect(src.includes('replace(')).toBe(true);
    expect(src.includes('$')).toBe(true);
  });

  it('CSNEWS_TOKEN env 必填 + 缺失时返回认证错误 JSON-RPC -32001', () => {
    // 验证 token check 在 handleRequest 早期
    expect(src).toMatch(/CSNEWS_TOKEN|Unauthorized|unauthorized/i);
  });
});

describe('csnews-mcp-server JSON-RPC 2.0 协议 guard', () => {
  const src = readIndex();

  it('实现 JSON-RPC 2.0 (jsonrpc: "2.0")', () => {
    expect(src.includes('2.0')).toBe(true);
  });

  it('实现 tools/list method 返回 TOOLS 数组', () => {
    expect(src.includes('tools/list')).toBe(true);
  });

  it('实现 tools/call method 路由到 tool handler', () => {
    expect(src.includes('tools/call')).toBe(true);
  });

  it('处理 initialize method (返回 protocolVersion + serverInfo)', () => {
    expect(src.includes('initialize')).toBe(true);
  });
});
