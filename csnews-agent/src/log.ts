/**
 * CSNEWS Agent · log helper
 * 写入 R2 `logs/YYYY-MM-DD/HH/MM-SS-fff-{source}.log` (每条 log 一个独立 R2 object)
 * 失败降级: console.error + 不抛
 * fire-and-forget: 调用方不 await, 失败不影响主流程
 *
 * 30 天 TTL 由 R2 lifecycle rule 兜底 (CF Dashboard 配 prefix=logs/, MaxAge=30d)
 * 本文件不写 prune 代码
 *
 * 2026-06-12 确定: 把颗粒度做细（之前按小时聚合 → put 覆盖导致 log 丢失）
 *  旧设计: key=logs/YYYY-MM-DD/HH.log → 同小时多次 logEvent = 后者覆盖前者
 *  新设计: key=logs/YYYY-MM-DD/HH/MM-SS-fff-{source}.log → 每条 log 独立 object
 *   - R2 list prefix=logs/ 仍能按时间筛选（dash.cloudflare 兼容）
 *   - 单个 R2 object 写失败不影响其他 log
 *   - 不用担心 race condition / 覆盖
 *   - R2 free 1000万 objects 配额（每小时 ~10 log × 24h = 240/天 → 7200/月 远低于配额）
 */
import { Env } from './shared';

// v0.37.60: in-memory ring buffer (最 近 100 条 log) · diagnostic fallback
// 不 替 代 R2 · R2 写 成 功 / 失 败 都 push 到 ring buffer (alway-on)
// 让 ?action=logs-diag 端 点 能 返 回 真 实 log (即 使 R2 写 失 败)
const DIAG_BUFFER_MAX = 100;
const diagBuffer: LogEntry[] = [];
function pushToDiagBuffer(entry: LogEntry) {
  diagBuffer.push(entry);
  if (diagBuffer.length > DIAG_BUFFER_MAX) {
    diagBuffer.shift(); // FIFO, 保 持 最 新 100 条
  }
}
/**
 * 读 ring buffer (diagnostic endpoint 用)
 * 返 回 新 -> 旧 排 序 拷 贝, 不 暴 露 内 部 引 用
 */
export function getDiagBuffer(): LogEntry[] {
  return [...diagBuffer].reverse();
}
/**
 * 清 ring buffer (admin 用, 不 暴 露 给 dashboard)
 */
export function clearDiagBuffer() {
  diagBuffer.length = 0;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  ctx?: Record<string, any>;
  source: string;
}

const DEBUG_SKIP = true; // level=debug 跳过写 R2, 避免配额爆

/**
 * 格式化单行 JSON log (末尾带 \n)
 */
export function formatLogLine(entry: LogEntry): string {
  return JSON.stringify(entry) + '\n';
}

/**
 * 计算 log key: `logs/YYYY-MM-DD/HH/MM-SS-fff-{source}.log`
 * - 按 UTC 年/月/日/小时分目录（保持 dashboard 兼容）
 * - 毫秒级时间戳 + 随机数保证每条 log 独立 key（防覆盖）
 * - 末尾 source 标签方便过滤
 */
export function getLogKey(date: Date, source: string = 'worker'): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const fff = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `logs/${yyyy}-${mm}-${dd}/${hh}/${min}-${ss}-${fff}-${source}.log`;
}

/**
 * 写一条 log 到 R2 (fire-and-forget)
 * - level=debug 跳过 (D2)
 * - R2 写失败降级 (FR-012)
 * - 包含的 ctx 必须不含 sensitive (FR-036/037)
 */
export async function logEvent(
  env: Env,
  level: LogLevel,
  msg: string,
  ctx?: Record<string, any>,
  source: string = 'worker'
): Promise<void> {
  if (DEBUG_SKIP && level === 'debug') return;
  if (!env.csnews_raw) {
    console.error('[log] csnews_raw binding missing');
    return;
  }
  // log retry helper: 单 R2 put 失 败 后 1-2 retry, 200ms / 500ms backoff
  // 原 因: R2 偶 发 限 流 / 网 络 闪 断 / CF internal 抖 动 → 单 次 失 败 不 必 立 刻 放 弃
  // 失 败 后 3 次 仍 抛 出 (让 调 用 方 catch 显 错 误, 不 静 默 吞)
  const putWithRetry = async (key: string, value: string, retries = 2): Promise<void> => {
    const delays = [0, 200, 500];
    let lastErr: unknown;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
      try {
        // v0.37.61: ctx.waitUntil 终 止 抢 在 R2 put 返 回 之 前 的 真 因: CF worker 返 应 客 户 端 时,
        // 还 没 完 成 的 ctx.waitUntil task (含 R2 put) 拿 不 到 await, 会 被 CF 自 动 cancel 整 个 调 用.
        // "A stalled HTTP response was canceled to prevent deadlock" warning
        // 修 法: 不 用 ctx.waitUntil, 直 接 await logEvent, 让 R2 put 真 正 完 成 之 后 才 返 应 客 户 端.
        // 不 影 响 主 调 用 性 能 (R2 put 1-10ms, 不 是 sync 阻 塞).
        // 之 前 ctx.waitUntil 假 装 fire-and-forget 走 的 端 点 都 改 sync await (例 dispatch.ts)
        // v0.37.63: 加 httpMetadata: { contentType: 'application/json' } 跟 saveToR2 同 步,
        // 捕 捉 result (含 etag / version) 并 console.log on success 兜 底 验 证 (因 为 R2 静 默 失 败 难 调 查).
        const result = await env.csnews_raw.put(key, value, {
          httpMetadata: { contentType: 'application/json' },
        });
        // 成 功 路 径 也 log 一 句, 跟 [saveToR2] put ok 同 风 格, 让 R2 真 落 盘 有 痕 迹
        console.error(
          `[log] put ok key=${key} etag=${result?.etag || 'n/a'} version=${result?.version || 'n/a'}`
        );
        return;
      } catch (e: unknown) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[log] put attempt ${i+1} failed: ${msg}`);
      }
    }
    throw lastErr;
  };
  try {
    const now = new Date();
    const entry: LogEntry = {
      ts: now.toISOString(),
      level,
      msg,
      ctx: ctx || undefined,
      source,
    };
    // v0.37.60: alway-on push to ring buffer (R2 写 成 功 / 失 败 都 push), diagnostic fallback
    pushToDiagBuffer(entry);
    const key = getLogKey(now, source);
    await putWithRetry(key, formatLogLine(entry));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // 不 静 默 吞, 抛 给 调 用 方 (dispatch.ts catch 显 console.error)
    console.error('[log] logEvent failed after retries', msg);
    throw e;
  }
}


/**
 * v0.37.60: ?action=logs-diag endpoint handler
 * 返 回 in-memory ring buffer (最 近 100 条 log) · diagnostic 用
 * 不 走 R2, 不 鉴 权 (跟 1H cron 一 致 — internal tool)
 * 用 头 表 头 X-Buffer-Size / X-Buffer-Enabled 告 知 caller ring buffer 是 否 启 用
 */
export function handleLogsDiagAction(
  _request: Request,
  env: Env,
  _url: URL,
  cors: Record<string, string>
): Response {
  const enabled = env.DEBUG_LOG_BUFFER === '1';
  const buf = enabled ? getDiagBuffer() : [];
  const body = JSON.stringify({
    diag: true,
    enabled,
    buffer_size: buf.length,
    max: DIAG_BUFFER_MAX,
    items: buf,
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'X-Buffer-Size': String(buf.length),
      'X-Buffer-Enabled': enabled ? '1' : '0',
    },
  });
}
