/**
 * Phase 1 — Observability truth (TDD — these tests are RED before the fix).
 *
 * Tests that registerAll() wires mcp_inflight_requests, mcp_tool_calls_total,
 * and mcp_tool_duration_seconds into every tool handler.
 *
 * RED reason: registry.ts:68-91 wraps every handler and increments nothing.
 *
 * SDK internals: McpServer._registeredTools is a plain object (not a Map)
 * keyed by tool name.  Each entry has a .handler property that is exactly the
 * callback we pass to server.registerTool().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inflightRequests, registry as promRegistry } from '../obs/metrics.js';
import { registerAll } from './registry.js';
import type { ToolContext, ToolDefinition } from './registry.js';

afterEach(() => {
  inflightRequests.set(0);
});

function makeServer() {
  return new McpServer({ name: 'test', version: '0.0.0' });
}

function makeTool(
  name: string,
  handler: (args: Record<string, never>, ctx: ToolContext) => Promise<{ ok: boolean }>,
): ToolDefinition {
  return {
    name,
    description: 'test tool',
    inputSchema: {},
    outputSchema: { ok: z.boolean() },
    annotations: { readOnlyHint: true },
    handler: handler as ToolDefinition['handler'],
    toText: (r) => JSON.stringify(r),
  };
}

/**
 * Invoke a registered tool handler directly, bypassing MCP protocol layer.
 * _registeredTools is a plain object; .handler is the callback we registered.
 */
async function callTool(server: McpServer, toolName: string, args: unknown = {}): Promise<unknown> {
  type Internals = {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
  };
  const internals = server as unknown as Internals;
  const tool = internals._registeredTools[toolName];
  if (!tool) throw new Error(`Tool not registered: ${toolName}`);
  return tool.handler(args, {});
}

describe('registerAll — inflight gauge', () => {
  it('increments inflightRequests during handler execution and decrements after', async () => {
    const server = makeServer();
    let inflightDuringExec = -1;

    registerAll(server, {}, [
      makeTool('test_inflight', async () => {
        // Read the gauge while still inside the handler.
        // With the fix, this must be ≥ 1.
        const metrics = await promRegistry.metrics();
        const match = metrics.match(/mcp_inflight_requests (\d+(\.\d+)?)/);
        inflightDuringExec = match ? parseFloat(match[1]!) : 0;
        return { ok: true };
      }),
    ]);

    await callTool(server, 'test_inflight');

    const afterMetrics = await promRegistry.metrics();
    const afterMatch = afterMetrics.match(/mcp_inflight_requests (\d+(\.\d+)?)/);
    const inflightAfter = afterMatch ? parseFloat(afterMatch[1]!) : 0;

    expect(inflightDuringExec, 'inflight should be ≥1 during handler').toBeGreaterThanOrEqual(1);
    expect(inflightAfter, 'inflight should return to 0 after handler').toBe(0);
  });

  it('decrements inflightRequests even when handler throws', async () => {
    const server = makeServer();
    registerAll(server, {}, [
      makeTool('test_inflight_throw', async () => {
        throw new Error('deliberate failure');
      }),
    ]);

    // registry.ts catches the error and returns isError:true — should not rethrow
    await callTool(server, 'test_inflight_throw');

    const afterMetrics = await promRegistry.metrics();
    const afterMatch = afterMetrics.match(/mcp_inflight_requests (\d+(\.\d+)?)/);
    const inflightAfter = afterMatch ? parseFloat(afterMatch[1]!) : 0;
    expect(inflightAfter, 'inflight must return to 0 even on error').toBe(0);
  });
});

describe('registerAll — toolCallsTotal counter', () => {
  it('increments mcp_tool_calls_total{outcome=success} on a successful call', async () => {
    const server = makeServer();
    const toolName = `test_calls_success_${Date.now()}`;

    registerAll(server, {}, [makeTool(toolName, async () => ({ ok: true }))]);
    await callTool(server, toolName);

    const metrics = await promRegistry.metrics();
    // Metric output must contain a label for this tool + outcome=success.
    expect(metrics).toMatch(new RegExp(`tool="${toolName}".*outcome="success"|outcome="success".*tool="${toolName}"`));
  });

  it('increments mcp_tool_calls_total{outcome=error} when handler throws', async () => {
    const server = makeServer();
    const toolName = `test_calls_error_${Date.now()}`;

    registerAll(server, {}, [
      makeTool(toolName, async () => { throw new Error('oops'); }),
    ]);
    await callTool(server, toolName);

    const metrics = await promRegistry.metrics();
    expect(metrics).toMatch(new RegExp(`tool="${toolName}".*outcome="error"|outcome="error".*tool="${toolName}"`));
  });
});

describe('registerAll — toolDurationSeconds histogram', () => {
  it('records mcp_tool_duration_seconds observation after a call', async () => {
    const server = makeServer();
    const toolName = `test_dur_${Date.now()}`;

    registerAll(server, {}, [makeTool(toolName, async () => ({ ok: true }))]);
    await callTool(server, toolName);

    const metrics = await promRegistry.metrics();
    // The histogram _count for this label set should be ≥ 1.
    // Prometheus text format: mcp_tool_duration_seconds_count{tool="..."} 1
    expect(metrics).toContain(`tool="${toolName}"`);
    const countMatch = metrics.match(
      new RegExp(`mcp_tool_duration_seconds_count\\{[^}]*tool="${toolName}"[^}]*\\}\\s+(\\d+)`),
    );
    expect(countMatch, 'duration histogram count must exist for this tool').toBeTruthy();
    expect(parseInt(countMatch![1]!, 10), 'duration histogram count must be ≥ 1').toBeGreaterThanOrEqual(1);
  });
});
