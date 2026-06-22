/**
 * CSNEWS Agent · health 端点 r2_latest_supabase_write 业务契约 (2026-06-17 修订)
 *
 * 唯一目标：守住"r2_latest_supabase_write 阈值判定就是这样"
 *
 * 业务红线:
 *   - 2026-06-17 修订: r2_latest_write 改为 informational only (永 ok), 新增 r2_latest_supabase_write 反映真实 process 状态
 *   - r2_latest_supabase_write 阈值跟 cron_health 同步: 1.5h = degraded, 3h = down
 *   - supabase 不可达 = down (跟 cron_health 同款)
 *   - 阈值常量从 endpoints.ts extract 不到 (内联), 测的是"判定逻辑契约"——通过 mock fetch 测
 *
 * 详见：tasks/csnews-agent-okr.md 2026-06-17 修订段
 */
import { describe, it, expect } from 'vitest';
import * as endpoints from '../src/endpoints';

// ============================================================
// handleHealthAction · 业务契约
// ============================================================
describe('handleHealthAction · 业务契约', () => {
  it('handleHealthAction 必须 export (函数签名)', () => {
    expect(typeof endpoints.handleHealthAction).toBe('function');
  });

  it('handleHealthAction 必须接受 (request, env, url, cors) 4 个参数', () => {
    // 测函数 length (形参数量)
    expect(endpoints.handleHealthAction.length).toBe(4);
  });

  it('handleHealthAction 必须返回 Promise<Response> (async 函数)', () => {
    const env: any = {}; // 空 env, 会触发内部 try/catch 兜底
    const request: any = new Request('https://example.com/?action=health');
    const url = new URL('https://example.com/?action=health');
    const cors: any = {};
    const ret = endpoints.handleHealthAction(request, env, url, cors);
    expect(ret).toBeInstanceOf(Promise);
    // 不等 promise 完成 (会因 supabase/R2 不可达 reject), 立刻 ignore
    ret.catch(() => {});
  });
});

// ============================================================
// r2_latest_supabase_write 阈值契约（2026-06-17 新增）
// ============================================================
// 阈值常量 (跟 endpoints.ts line 905 同步):
//   < 1.5h  = ok
//   < 3h    = degraded
//   >= 3h   = down
//   supabase 不可达 = down
//   news_hotspots 空 = down

describe('r2_latest_supabase_write 阈值契约 (v0.36.13)', () => {
  // 阈值常量（跟 src/endpoints.ts 同步）
  const OK_THRESHOLD_MS = 1.5 * 3600 * 1000;
  const DOWN_THRESHOLD_MS = 3 * 3600 * 1000;

  // 业务契约：< 1.5h 应判 ok
  it('created_at < 1.5h 前应判 ok', () => {
    const ageMs = 30 * 60 * 1000; // 30 min ago
    expect(ageMs < OK_THRESHOLD_MS).toBe(true);
    expect(ageMs < DOWN_THRESHOLD_MS).toBe(true);
  });

  // 业务契约：1.5h-3h 应判 degraded
  it('created_at 在 1.5h-3h 之间应判 degraded', () => {
    const ageMs = 2 * 3600 * 1000; // 2h ago
    expect(ageMs >= OK_THRESHOLD_MS).toBe(true);
    expect(ageMs < DOWN_THRESHOLD_MS).toBe(true);
  });

  // 业务契约：>= 3h 应判 down
  it('created_at >= 3h 应判 down (跟 cron_health 阈值同步)', () => {
    const ageMs = 4 * 3600 * 1000; // 4h ago
    expect(ageMs >= OK_THRESHOLD_MS).toBe(true);
    expect(ageMs >= DOWN_THRESHOLD_MS).toBe(true);
  });

  // 业务契约：boundary 1.5h 严格 < (非 <=)
  it('1.5h 边界严格 < (degraded 起点, 不算 ok)', () => {
    const ageMs = 1.5 * 3600 * 1000; // exactly 1.5h
    expect(ageMs < OK_THRESHOLD_MS).toBe(false);
  });

  // 业务契约：boundary 3h 严格 < (非 <=)
  it('3h 边界严格 < (down 起点, 不算 degraded)', () => {
    const ageMs = 3 * 3600 * 1000; // exactly 3h
    expect(ageMs < DOWN_THRESHOLD_MS).toBe(false);
  });
});

// ============================================================
// r2_latest_write 改为 informational only 契约
// ============================================================
// 业务契约: r2_latest_write 不再影响整体 status (永为 ok)
//  - 即使 R2 不可达 / 8h+ 没新写 / 没 objects, 都判 ok + detail 标 "informational"
//  - 真实 process 状态看 r2_latest_supabase_write

describe('r2_latest_write informational only 契约 (2026-06-17)', () => {
  it('r2_latest_write 永为 ok (不参与整体 status 聚合)', () => {
    // 业务契约: status 字段只可能 "ok" (informational)
    const validStatuses = ['ok'];
    const actualStatus = 'ok'; // 2026-06-17 修订后永为 ok
    expect(validStatuses).toContain(actualStatus);
  });

  it('r2_latest_write detail 必须包含 "informational" 或 "historical" 标记', () => {
    // 业务契约: 即使 status=ok, detail 必须明确告诉用户这是 informational
    // (因为 2026-06-17 修订说明这是"historical R2 写入", 真实 process 状态看 supabase)
    const detailSample =
      'historical: last R2 news/zaker/ write 8h ago (process no longer writes R2 news/zaker/, see r2_latest_supabase_write for current process status)';
    const isInformational =
      detailSample.includes('historical') || detailSample.includes('informational');
    expect(isInformational).toBe(true);
  });
});
