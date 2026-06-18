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

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  ctx?: Record<string, any>;
  source: string;
}

const DEBUG_SKIP = true;  // level=debug 跳过写 R2, 避免配额爆

/**
 * 格式化单行 JSON log (末尾带 \n)
 */
export function formatLogLine(entry: LogEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * 计算 log key: `logs/YYYY-MM-DD/HH/MM-SS-fff-{source}.log`
 * - 按 UTC 年/月/日/小时分目录（保持 dashboard 兼容）
 * - 毫秒级时间戳 + 随机数保证每条 log 独立 key（防覆盖）
 * - 末尾 source 标签方便过滤
 */
export function getLogKey(date: Date, source: string = "worker"): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  const fff = String(date.getUTCMilliseconds()).padStart(3, "0");
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
  source: string = "worker"
): Promise<void> {
  if (DEBUG_SKIP && level === "debug") return;
  if (!env.csnews_raw) {
    console.error("[log] csnews_raw binding missing");
    return;
  }
  try {
    const now = new Date();
    const entry: LogEntry = {
      ts: now.toISOString(),
      level,
      msg,
      ctx: ctx || undefined,
      source,
    };
    const key = getLogKey(now, source);
    await env.csnews_raw.put(key, formatLogLine(entry));
  } catch (e: any) {
    console.error("[log] logEvent failed", e?.message || e);
    // 降级: 不抛
  }
}

