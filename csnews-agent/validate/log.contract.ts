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
  // kzclaw 2026-06-12 确定: 把颗粒度做细 (v0.36)
  // 旧签名 getLogKey(date, hour) → 新签名 getLogKey(date, source)
  //   - key = logs/YYYY-MM-DD/HH/MM-SS-fff-source.log
  //   - 每条 log 独立 R2 object, 不再被覆盖
  it("返回 `logs/YYYY-MM-DD/HH/MM-SS-fff-source.log` 格式 (带 source)", () => {
    const d = new Date(Date.UTC(2026, 5, 10, 19, 30, 45, 123));
    expect(getLogKey(d, "worker")).toMatch(/^logs\/2026-06-10\/19\/30-45-123-worker\.log$/);
  });

  it("source 多种值 (dispatcher / scheduler)", () => {
    const d = new Date(Date.UTC(2026, 5, 10, 19, 0, 0));
    expect(getLogKey(d, "dispatcher")).toMatch(/dispatcher\.log$/);
    expect(getLogKey(d, "scheduler")).toMatch(/scheduler\.log$/);
  });

  it("minute 边界 0-59", () => {
    const d = new Date(Date.UTC(2026, 5, 10, 19, 0, 0));
    expect(getLogKey(d, "w")).toMatch(/\/00-00-000-w\.log$/);
  });

  it("minute 边界 59", () => {
    const d = new Date(Date.UTC(2026, 5, 10, 19, 59, 59, 999));
    expect(getLogKey(d, "w")).toMatch(/\/59-59-999-w\.log$/);
  });

  it("date 跨月", () => {
    const d = new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0));  // 2026-07-01
    expect(getLogKey(d, "w")).toMatch(/^logs\/2026-07-01\//);
  });

  it("date 跨年", () => {
    const d = new Date(Date.UTC(2027, 0, 1, 0, 0, 0, 0));  // 2027-01-01
    expect(getLogKey(d, "w")).toMatch(/^logs\/2027-01-01\//);
  });
});

describe("logEvent", () => {
  it("level=debug 跳过写 R2", async () => {
    const put = vi.fn();
    const env = { csnews_raw: { put } } as any;
    await logEvent(env, "debug", "test debug", { a: 1 });
    expect(put).not.toHaveBeenCalled();
  });

  it("level=info 写 R2 (每条 log 独立 key)", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { csnews_raw: { put } } as any;
    await logEvent(env, "info", "test info", { a: 1 });
    expect(put).toHaveBeenCalledOnce();
    const [key, body] = put.mock.calls[0];
    // kzclaw 2026-06-12 确定: 颗粒度做细 → key=logs/YYYY-MM-DD/HH/MM-SS-fff-source.log
    expect(key).toMatch(/^logs\/\d{4}-\d{2}-\d{2}\/\d{2}\/\d{2}-\d{2}-\d{3}-[a-z]+\.log$/);
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
