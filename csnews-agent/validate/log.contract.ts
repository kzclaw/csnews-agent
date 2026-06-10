/**
 * CSNEWS Agent · log helper 契约验证
 * 15 场景覆盖 formatLogLine / getLogKey / logEvent
 */
import { describe, it, expect, vi } from "vitest";
import { formatLogLine, getLogKey, logEvent, LogEntry } from "../src/log";

describe("formatLogLine", () => {
  it("输出是单行 JSON + 末尾 \\n", () => {
    const e: LogEntry = { ts: "2026-06-10T11:00:00.000Z", level: "info", msg: "test", source: "worker" };
    const out = formatLogLine(e);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").length).toBe(2);
    expect(out.split("\n")[0]).not.toContain("\n");
  });

  it("JSON 字段顺序: ts / level / msg / ctx / source", () => {
    const e: LogEntry = { ts: "2026-06-10T11:00:00.000Z", level: "info", msg: "test", source: "worker" };
    const parsed = JSON.parse(formatLogLine(e).trim());
    expect(Object.keys(parsed)).toEqual(["ts", "level", "msg", "source"]);
  });

  it("ctx 字段可选, 不传 = 不出现", () => {
    const e1: LogEntry = { ts: "2026-06-10T11:00:00.000Z", level: "info", msg: "test", source: "worker" };
    const parsed1 = JSON.parse(formatLogLine(e1).trim());
    expect(parsed1.ctx).toBeUndefined();

    const e2: LogEntry = { ts: "2026-06-10T11:00:00.000Z", level: "info", msg: "test", source: "worker", ctx: { a: 1 } };
    const parsed2 = JSON.parse(formatLogLine(e2).trim());
    expect(parsed2.ctx).toEqual({ a: 1 });
  });
});

describe("getLogKey", () => {
  it("返回 `logs/YYYY-MM-DD/HH.log` 格式", () => {
    const d = new Date(Date.UTC(2026, 5, 10, 19, 0, 0));  // 2026-06-10 19:00 UTC
    expect(getLogKey(d, 19)).toBe("logs/2026-06-10/19.log");
  });

  it("hour 0 边界", () => {
    const d = new Date(Date.UTC(2026, 5, 10, 0, 0, 0));
    expect(getLogKey(d, 0)).toBe("logs/2026-06-10/00.log");
  });

  it("hour 23 边界", () => {
    const d = new Date(Date.UTC(2026, 5, 10, 23, 0, 0));
    expect(getLogKey(d, 23)).toBe("logs/2026-06-10/23.log");
  });

  it("date 跨月", () => {
    const d = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));  // 2026-07-01
    expect(getLogKey(d, 0)).toBe("logs/2026-07-01/00.log");
  });

  it("date 跨年", () => {
    const d = new Date(Date.UTC(2027, 0, 1, 0, 0, 0));  // 2027-01-01
    expect(getLogKey(d, 0)).toBe("logs/2027-01-01/00.log");
  });
});

describe("logEvent", () => {
  it("level=debug 跳过写 R2", async () => {
    const put = vi.fn();
    const env = { csnews_raw: { put } } as any;
    await logEvent(env, "debug", "test debug", { a: 1 });
    expect(put).not.toHaveBeenCalled();
  });

  it("level=info 写 R2", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { csnews_raw: { put } } as any;
    await logEvent(env, "info", "test info", { a: 1 });
    expect(put).toHaveBeenCalledOnce();
    const [key, body] = put.mock.calls[0];
    expect(key).toMatch(/^logs\/\d{4}-\d{2}-\d{2}\/\d{2}\.log$/);
    const entry = JSON.parse(body.trim());
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("test info");
    expect(entry.ctx).toEqual({ a: 1 });
  });

  it("R2 写失败降级 (不抛)", async () => {
    const put = vi.fn().mockRejectedValue(new Error("R2 quota exceeded"));
    const env = { csnews_raw: { put } } as any;
    // 期望: 不抛
    await expect(logEvent(env, "info", "test fail")).resolves.toBeUndefined();
  });

  it("csnews_raw binding 缺失降级", async () => {
    const env = {} as any;
    // 期望: 不抛
    await expect(logEvent(env, "info", "test no binding")).resolves.toBeUndefined();
  });

  it("ts 是 ISO 8601 字符串", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { csnews_raw: { put } } as any;
    await logEvent(env, "info", "ts check");
    const body = put.mock.calls[0][1];
    const entry = JSON.parse(body.trim());
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(() => new Date(entry.ts)).not.toThrow();
  });

  it("source 默认 = 'worker'", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { csnews_raw: { put } } as any;
    await logEvent(env, "info", "default source");
    const entry = JSON.parse(put.mock.calls[0][1].trim());
    expect(entry.source).toBe("worker");
  });

  it("source 可自定义", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { csnews_raw: { put } } as any;
    await logEvent(env, "info", "custom source", {}, "scheduler");
    const entry = JSON.parse(put.mock.calls[0][1].trim());
    expect(entry.source).toBe("scheduler");
  });
});
