// ============================================================
// health-cold-archive.contract.ts
// Board decision v0.37.16: R2 is a cold archive, not the primary store.
// This contract test guards the new health response shape so the
// "R2 broken" false-alarm can't regress.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../src');

function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(SRC, ...parts), 'utf8');
}

describe('health-cold-archive contract (v0.37.16)', () => {
  it('health-r2.ts must mark R2 as cold archive (r2_role field)', () => {
    const src = readSrc('health-r2.ts');
    expect(src.includes("r2_role: 'cold_archive'") || src.includes('r2_role: "cold_archive"')).toBe(true);
    expect(src.includes("primary_store_field: 'supabase_latest_write'") || src.includes('primary_store_field: "supabase_latest_write"')).toBe(true);
  });

  it('health-r2.ts must expose R2 status "info" for cold-archive (never "down")', () => {
    const src = readSrc('health-r2.ts');
    // statusFor maps to 'ok' or 'info' only; never 'down'
    expect(/statusFor[\s\S]{0,200}'ok'[\s\S]{0,200}'info'/.test(src)).toBe(true);
    // statusFor body must not have a `return 'down'` statement
    expect(/statusFor[\s\S]{0,400}return\s+'down'/.test(src)).toBe(false);
  });

  it('health-r2.ts must include cold_archive_status_explanation human-readable string', () => {
    const src = readSrc('health-r2.ts');
    expect(src.includes('cold_archive_status_explanation')).toBe(true);
    // Must point consumers to supabase_latest_write
    expect(src.includes('supabase_latest_write')).toBe(true);
  });

  it('health-db.ts must define DATA_STORE_ARCHITECTURE with primary=cold_archive roles', () => {
    const src = readSrc('health-db.ts');
    expect(src.includes('DATA_STORE_ARCHITECTURE')).toBe(true);
    expect(src.includes("primary_store: 'supabase'")).toBe(true);
    expect(src.includes("cold_archive: 'r2'")).toBe(true);
    expect(src.includes("primary_store_health_field: 'supabase_latest_write'")).toBe(true);
    expect(src.includes("cold_archive_health_field: 'r2_latest_write'")).toBe(true);
  });

  it('health-db.ts must rename r2_latest_supabase_write → supabase_latest_write (with alias)', () => {
    const src = readSrc('health-db.ts');
    // Canonical new field
    expect(src.includes('supabase_latest_write')).toBe(true);
    // Backward-compat alias kept
    expect(src.includes('r2_latest_supabase_write')).toBe(true);
  });

  it('health-kv.ts must expose checkLastProcessStoredReason for cold-archive explanation', () => {
    const src = readSrc('health-kv.ts');
    expect(src.includes('checkLastProcessStoredReason')).toBe(true);
    expect(src.includes('LastProcessStoredReason')).toBe(true);
    // Reads from PROCESS_STATE KV
    expect(src.includes("PROCESS_STATE.get('last_process_stored_reason')")).toBe(true);
  });

  it('health-main.ts must include "info" status in the type union (not just ok/degraded/down/unknown)', () => {
    const src = readSrc('health-main.ts');
    // Status union includes 'info'
    expect(/status:\s*'ok'\s*\|\s*'info'/.test(src)).toBe(true);
    // statusFor only escalates to 'down' for down, not 'info' status
    expect(/if \(statuses\.includes\('down'\)\) result\.status = 'down'/.test(src)).toBe(true);
  });

  it('health-main.ts must surface data_store_architecture as top-level field', () => {
    const src = readSrc('health-main.ts');
    expect(src.includes('result.data_store_architecture = DATA_STORE_ARCHITECTURE')).toBe(true);
  });

  it('health-main.ts must expose supabase_latest_write alias on top-level result', () => {
    const src = readSrc('health-main.ts');
    expect(src.includes('result.supabase_latest_write =')).toBe(true);
    expect(src.includes('result.r2_cold_archive_latest_write =')).toBe(true);
  });

  it('health-main.ts must call checkLastProcessStoredReason and include last_process_stored_reason', () => {
    const src = readSrc('health-main.ts');
    expect(src.includes('checkLastProcessStoredReason(env)')).toBe(true);
    expect(src.includes('result.last_process_stored_reason =')).toBe(true);
    expect(src.includes('checks.last_process_stored_reason =')).toBe(true);
  });

  it('endpoints-process.ts must aggregate last_process_stored_reason and persist to KV', () => {
    const src = readSrc('endpoints-process.ts');
    expect(src.includes('last_process_stored_reason')).toBe(true);
    expect(src.includes('r2_writes')).toBe(true);
    expect(src.includes('r2_skipped')).toBe(true);
    expect(src.includes("PROCESS_STATE.put(\n        'last_process_stored_reason'")).toBe(true);
  });

  it('pull-viewer.html must render R2 panel with cold archive badge + Supabase primary badge', () => {
    const html = readSrc('../../tools/pull-viewer.html');
    expect(html.includes('badge-cold')).toBe(true);
    expect(html.includes('badge-primary')).toBe(true);
    expect(html.includes('R2 Cold Archive')).toBe(true);
    expect(html.includes('badge-info')).toBe(true);
  });

  it('pull-viewer.html must render "info" status check-card and activity-dot (blue, not down)', () => {
    const html = readSrc('../../tools/pull-viewer.html');
    expect(html.includes('.check-card.info')).toBe(true);
    expect(html.includes('.activity-dot.info')).toBe(true);
    // The string "cold_archive" must appear in the dashboard activity text
    expect(html.includes('cold_archive')).toBe(true);
  });
});
