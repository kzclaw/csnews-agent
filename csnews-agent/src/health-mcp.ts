// ============================================================
// MCP tools health checks
// ============================================================

import { Env } from './shared';

type CheckEntry = { status: 'ok' | 'unknown'; detail: string };

/**
 * CheckResult — uniform shape for individual health checks.
 * Used by health-checks.ts to aggregate sub-module results.
 */
export interface CheckResult {
  ok: boolean;
  value?: number;
  unit?: string;
  label: string;
}

// ============================================================
// 1. mcp_tools_count — count registered MCP tool handlers
// Reads AI_USAGE_KV to tally tool invocations by tool name.
// ============================================================
export async function checkMcpToolsCount(env: Env): Promise<{
  mcp_tools_count: number;
  mcp_tools_breakdown: Record<string, number>;
  checks: {
    mcp_tools: CheckEntry;
  };
}> {
  const checks: Record<string, CheckEntry> = {};
  const breakdown: Record<string, number> = {};

  try {
    if (!env.AI_USAGE_KV) {
      checks.mcp_tools = { status: 'unknown', detail: 'AI_USAGE_KV binding missing' };
      return {
        mcp_tools_count: 0,
        mcp_tools_breakdown: {},
        checks: { mcp_tools: checks.mcp_tools },
      };
    }

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const todayKey = `usage/${y}-${m}-${d}`;

    const raw = await env.AI_USAGE_KV.get(todayKey);
    let totalTools = 0;

    if (raw) {
      try {
        const record = JSON.parse(raw) as {
          total: number;
          calls: Array<{ model: string; neurons: number; tool_name?: string }>;
        };
        for (const call of record.calls ?? []) {
          const toolName = call.tool_name || 'unknown';
          breakdown[toolName] = (breakdown[toolName] || 0) + 1;
          totalTools++;
        }
      } catch {
        // parse failed, return empty breakdown
      }
    }

    const toolNames = Object.keys(breakdown);
    checks.mcp_tools = {
      status: 'ok',
      detail:
        toolNames.length > 0
          ? `${totalTools} MCP tool calls across ${toolNames.length} tool(s): ${toolNames.join(', ')}`
          : 'no MCP tool calls recorded today',
    };

    return {
      mcp_tools_count: toolNames.length,
      mcp_tools_breakdown: breakdown,
      checks: { mcp_tools: checks.mcp_tools },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.mcp_tools = { status: 'unknown', detail: msg };
    return {
      mcp_tools_count: 0,
      mcp_tools_breakdown: {},
      checks: { mcp_tools: checks.mcp_tools },
    };
  }
}
