import { describe, it, expect } from 'vitest';
import { registry, toolCallsTotal, inflightRequests, crawlQueueDepth } from './metrics.js';

describe('metrics registry', () => {
  it('registry is populated', async () => {
    const metrics = await registry.metrics();
    expect(metrics).toContain('mcp_tool_calls_total');
    expect(metrics).toContain('mcp_inflight_requests');
    expect(metrics).toContain('crawl_queue_depth');
  });

  it('counter increments correctly', async () => {
    toolCallsTotal.labels({ tool: 'test_tool', outcome: 'success' }).inc();
    const metrics = await registry.metrics();
    expect(metrics).toContain('tool="test_tool"');
  });

  it('gauge sets correctly', async () => {
    inflightRequests.set(7);
    const metrics = await registry.metrics();
    expect(metrics).toContain('mcp_inflight_requests 7');
  });

  it('labelled gauge sets correctly', async () => {
    crawlQueueDepth.labels({ job: 'job-abc' }).set(42);
    const metrics = await registry.metrics();
    expect(metrics).toContain('job="job-abc"');
  });

  it('contentType is prometheus text format', () => {
    expect(registry.contentType).toContain('text/plain');
  });
});
