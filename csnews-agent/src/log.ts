/**
 * CSNEWS Agent · log helper
 * 写入 R2 `logs/YYYY-MM-DD/HH.log` (一行 JSON 格式)
 * 失败降级: console.error + 不抛
 * fire-and-forget: 调用方不 await, 失败不影响主流程
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

/**
 * 算 cutoff date (UTC): today - retentionDays
 * 返回 `YYYY-MM-DD` 格式
 */
export function getPruneCutoffDate(now: Date, retentionDays: number): string {
  const cutoff = new Date(now.getTime() - retentionDays * 86400_000);
  const yyyy = cutoff.getUTCFullYear();
  const mm = String(cutoff.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(cutoff.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 删 R2 `logs/<cutoff-date>/` 之前的所有日期目录
 * 失败降级: console.error + 不抛
 * 推荐 retentionDays = 30
 */
export async function pruneOldLogs(env: Env, retentionDays: number = 30): Promise<{ deleted: number; errors: number }> {
  if (!env.csnews_raw) {
    console.error("[log] csnews_raw binding missing");
    return { deleted: 0, errors: 1 };
  }
  const now = new Date();
  const cutoffDate = getPruneCutoffDate(now, retentionDays);
  const cutoffMs = Date.parse(cutoffDate + "T00:00:00Z");

  let deleted = 0;
  let errors = 0;

  try {
    // 列 R2 `logs/` 下所有对象
    const list = await env.csnews_raw.list({ prefix: "logs/" });
    const toDelete: string[] = [];
    for (const obj of list.objects) {
      // obj.key 格式: logs/YYYY-MM-DD/HH.log
      const match = obj.key.match(/^logs\/(\d{4}-\d{2}-\d{2})\//);
      if (!match) continue;
      const objDate = match[1];
      const objMs = Date.parse(objDate + "T00:00:00Z");
      if (Number.isFinite(objMs) && objMs < cutoffMs) {
        toDelete.push(obj.key);
      }
    }
    for (const key of toDelete) {
      try {
        await env.csnews_raw.delete(key);
        deleted++;
      } catch (e: any) {
        console.error("[log] delete failed", key, e?.message || e);
        errors++;
      }
    }
    if (deleted > 0 || errors > 0) {
      console.log(`[log] prune: deleted ${deleted}, errors ${errors}, cutoff=${cutoffDate}`);
    }
  } catch (e: any) {
    console.error("[log] prune list failed", e?.message || e);
    errors++;
  }
  return { deleted, errors };
}
