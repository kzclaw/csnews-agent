/**
 * CSNEWS Agent · log helper
 * 写入 R2 `logs/YYYY-MM-DD/HH.log` (一行 JSON 格式)
 * 失败降级: console.error + 不抛
 * fire-and-forget: 调用方不 await, 失败不影响主流程
 *
 * 30 天 TTL 由 R2 lifecycle rule 兜底 (CF Dashboard 配 prefix=logs/, MaxAge=30d)
 * 本文件不写 prune 代码
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
 * 计算 log key: `logs/YYYY-MM-DD/HH.log` (按 UTC 小时)
 */
export function getLogKey(date: Date, hour: number): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  return `logs/${yyyy}-${mm}-${dd}/${hh}.log`;
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
    const key = getLogKey(now, now.getUTCHours());
    await env.csnews_raw.put(key, formatLogLine(entry));
  } catch (e: any) {
    console.error("[log] logEvent failed", e?.message || e);
    // 降级: 不抛
  }
}

