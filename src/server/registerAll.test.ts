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
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inflightRequests, registry as promRegistry } from '../obs/metrics.js';
import { registerAll } from './registry.js';
import type { ToolContext, ToolDefinition } from './registry.js';
import { initializeConfig, resetConfig } from '../config.js';
import { _resetCallerSaltForTest } from '../privacy/redact.js';

beforeEach(() => {
  resetConfig();
  initializeConfig({});
});

afterEach(() => {
  inflightRequests.set(0);
  vi.restoreAllMocks();
  _resetCallerSaltForTest();
  resetConfig();
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

// ── Caller identity attribution tests ────────────────────────────────────────

/** Helper: call a registered tool with an optional per-request extra object */
async function callToolWithExtra(
  server: McpServer,
  toolName: string,
  args: unknown = {},
  extra: unknown = {},
): Promise<unknown> {
  type Internals = {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
  };
  const internals = server as unknown as Internals;
  const tool = internals._registeredTools[toolName];
  if (!tool) throw new Error(`Tool not registered: ${toolName}`);
  return tool.handler(args, extra);
}

// N5 — WRITE FIRST: the raw header value must NEVER appear in any output
describe('registerAll — N5 sentinel: raw caller ID never reaches output', () => {
  it('audit event and stderr do not contain the raw header value', async () => {
    const SENTINEL = 'SENTINEL-DO-NOT-LOG-9f3a';
    const capturedEvents: unknown[] = [];
    const server = makeServer();

    registerAll(server, { audit: (e) => capturedEvents.push(e) }, [
      makeTool('test_sentinel', async () => ({ ok: true })),
    ]);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await callToolWithExtra(server, 'test_sentinel', {}, {
      requestInfo: { headers: { 'x-mcp-caller-id': SENTINEL } },
    });

    const allOutput = JSON.stringify(capturedEvents) + stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(allOutput).not.toContain(SENTINEL);
  });
});

// N1/N2/N3: identity reaches all three call sites; distinct inputs differ; same → stable
describe('registerAll — caller identity propagation', () => {
  it('N1 — callerHash on audit event matches 16-hex pattern', async () => {
    const captured: { callerHash?: string | null }[] = [];
    const server = makeServer();
    registerAll(server, { audit: (e) => captured.push(e) }, [
      makeTool('test_id_n1', async () => ({ ok: true })),
    ]);

    await callToolWithExtra(server, 'test_id_n1', {}, {
      requestInfo: { headers: { 'x-mcp-caller-id': 'alice@corp.co.za' } },
    });

    expect(captured[0]?.callerHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('N2 — distinct inputs produce distinct hashes; same input is stable', async () => {
    const hashes: (string | null | undefined)[] = [];
    const server = makeServer();
    registerAll(server, { audit: (e) => hashes.push(e.callerHash) }, [
      makeTool('test_id_n2', async () => ({ ok: true })),
    ]);

    await callToolWithExtra(server, 'test_id_n2', {}, {
      requestInfo: { headers: { 'x-mcp-caller-id': 'alice@corp' } },
    });
    await callToolWithExtra(server, 'test_id_n2', {}, {
      requestInfo: { headers: { 'x-mcp-caller-id': 'bob@corp' } },
    });
    await callToolWithExtra(server, 'test_id_n2', {}, {
      requestInfo: { headers: { 'x-mcp-caller-id': 'alice@corp' } },
    });

    expect(hashes[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(hashes[1]).toMatch(/^[0-9a-f]{16}$/);
    expect(hashes[0]).not.toBe(hashes[1]);  // alice ≠ bob
    expect(hashes[0]).toBe(hashes[2]);       // alice is stable
  });

  it('N3 — callerHash present on blocked, success, and error audit callsites', async () => {
    const captured: { outcome: string; callerHash?: string | null }[] = [];
    const server = makeServer();
    registerAll(server, { audit: (e) => captured.push(e) }, [
      // success path
      makeTool('test_id_success', async () => ({ ok: true })),
      // error path
      makeTool('test_id_error', async () => { throw new Error('deliberate'); }),
    ]);

    const extra = { requestInfo: { headers: { 'x-mcp-caller-id': 'tester@corp' } } };

    // The blocked path requires POPIA detect — pass a SA ID number
    // (piiClasses=['sa_id'] triggers 'block' when POPIA_MODE=enforce)
    await callToolWithExtra(server, 'test_id_success', { query: '8001015009087' }, extra);
    await callToolWithExtra(server, 'test_id_success', {}, extra);
    await callToolWithExtra(server, 'test_id_error', {}, extra);

    // Every captured event must carry callerHash
    for (const event of captured) {
      expect(event.callerHash, `callerHash missing on ${event.outcome} event`).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  // N16/N17: absent or empty extra → callerHash null, no throw
  it('N16 — tool.handler(args, {}) → callerHash null, no TypeError', async () => {
    const captured: { callerHash?: string | null }[] = [];
    const server = makeServer();
    registerAll(server, { audit: (e) => captured.push(e) }, [
      makeTool('test_id_n16', async () => ({ ok: true })),
    ]);

    // callTool uses {} as extra — the original test harness shape
    await callTool(server, 'test_id_n16');

    expect(captured[0]?.callerHash).toBeNull();
  });

  it('N17 — {requestInfo:{headers:{}}} → callerHash null', async () => {
    const captured: { callerHash?: string | null }[] = [];
    const server = makeServer();
    registerAll(server, { audit: (e) => captured.push(e) }, [
      makeTool('test_id_n17', async () => ({ ok: true })),
    ]);

    await callToolWithExtra(server, 'test_id_n17', {}, { requestInfo: { headers: {} } });

    expect(captured[0]?.callerHash).toBeNull();
  });
});
