// ============================================================
// Internal health checks — kept directly in main file
// (no dedicated submodule needed)
// ============================================================

import { Env } from './shared';

// ============================================================
// secret_resolved — WORKER_SELF_URL placeholder check
// ============================================================
export function checkSecretResolved(env: Env): {
  checks: {
    secret_resolved: { status: 'ok' | 'down'; detail: string };
  };
} {
  const selfUrl = env.WORKER_SELF_URL || '';
  const isPlaceholder =
    selfUrl === 'DO_NOT_USE' ||
    selfUrl === 'https://YOUR-WORKER.workers.dev' ||
    selfUrl.includes('YOUR-WORKER') ||
    selfUrl === '';

  return {
    checks: {
      secret_resolved: {
        status: isPlaceholder ? 'down' : 'ok',
        detail: isPlaceholder ? `placeholder: "${selfUrl}"` : 'set to non-placeholder URL',
      },
    },
  };
}

// ============================================================
// cron_history — this hour scheduler logs
// ============================================================
export async function checkCronHistory(
  env: Env,
  ts: number
): Promise<{
  cron_history: { this_hour: { hour: string; scheduler_log_count: number } } | { error: string };
  checks: {
    cron_history: { status: 'ok' | 'degraded' | 'unknown'; detail: string };
  };
}> {
  let cronHistory:
    | { this_hour: { hour: string; scheduler_log_count: number } }
    | { error: string } = {
    this_hour: { hour: '', scheduler_log_count: 0 },
  };
  const checks: any = {};

  try {
    const now = new Date(ts);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const list = await env.csnews_raw.list({
      prefix: `logs/${yyyy}-${mm}-${dd}/${hh}/`,
      limit: 100,
    });
    const thisHourSchedulerLogs =
      list.objects?.filter((o) => o.key.includes('-scheduler.log')) || [];
    cronHistory = {
      this_hour: {
        hour: `${yyyy}-${mm}-${dd}T${hh}`,
        scheduler_log_count: thisHourSchedulerLogs.length,
      },
    };
    checks.cron_history = {
      status: thisHourSchedulerLogs.length >= 1 ? 'ok' : 'degraded',
      detail:
        thisHourSchedulerLogs.length >= 1
          ? `${thisHourSchedulerLogs.length} scheduler logs this hour`
          : 'no scheduler logs this hour (cron may not have run)',
    };
  } catch (e: any) {
    cronHistory = { error: e?.message };
    checks.cron_history = { status: 'unknown', detail: e?.message };
  }

  return {
    cron_history: cronHistory,
    checks: { cron_history: checks.cron_history },
  };
}
