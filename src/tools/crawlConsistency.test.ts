/**
 * Phase 4: crawl_cancel and crawl_results must reject unknown job IDs.
 *
 * crawl_status already throws `Job not found: ${jobId}` for unknown IDs
 * (definitions.ts:475). crawl_cancel and crawl_results did not — they
 * silently returned success/empty, inconsistent with each other and with
 * the spec principle that referencing a nonexistent resource is an error.
 *
 * RED before fix: crawl_cancel returns {cancelled:true} for any jobId;
 * crawl_results returns {pages:[],total:0} for any jobId.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock the store factory — must be hoisted before any import that uses it.
// The mock provides a queue whose status() returns undefined for unknown jobs,
// matching the contract defined in src/store/__contract__/queue.test.ts:260.
vi.mock('../store/factory.js', () => ({
  getStores: vi.fn().mockReturnValue({
    queue: {
      status:  vi.fn().mockResolvedValue(undefined), // unknown → undefined
      results: vi.fn().mockResolvedValue([]),
      cancel:  vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

import { TOOLS } from './definitions.js';

const cancelTool  = TOOLS.find(t => t.name === 'crawl_cancel')!;
const resultsTool = TOOLS.find(t => t.name === 'crawl_results')!;
const statusTool  = TOOLS.find(t => t.name === 'crawl_status')!;

beforeEach(() => { vi.clearAllMocks(); });

const UNKNOWN_JOB_ID = '00000000-0000-0000-0000-000000000000';

describe('crawl tool consistency — unknown job IDs (Phase 4)', () => {
  // ── baseline: crawl_status already throws ──────────────────────────────────
  it('crawl_status throws for an unknown job ID (existing behaviour)', async () => {
    await expect(
      statusTool.handler({ jobId: UNKNOWN_JOB_ID }),
    ).rejects.toThrow(`Job not found: ${UNKNOWN_JOB_ID}`);
  });

  // ── RED before fix ──────────────────────────────────────────────────────────
  it('crawl_cancel throws for an unknown job ID', async () => {
    // Before fix: resolves with {cancelled:true} — this test must be RED.
    // After fix: rejects with "Job not found: …".
    await expect(
      cancelTool.handler({ jobId: UNKNOWN_JOB_ID }),
    ).rejects.toThrow(`Job not found: ${UNKNOWN_JOB_ID}`);
  });

  it('crawl_results throws for an unknown job ID', async () => {
    // Before fix: resolves with {pages:[],total:0,offset:0} — this test must be RED.
    // After fix: rejects with "Job not found: …".
    await expect(
      resultsTool.handler({ jobId: UNKNOWN_JOB_ID }),
    ).rejects.toThrow(`Job not found: ${UNKNOWN_JOB_ID}`);
  });

  // ── regression guards — known job must still work ──────────────────────────
  it('crawl_cancel succeeds for a known job ID', async () => {
    const { getStores } = await import('../store/factory.js');
    vi.mocked(getStores).mockReturnValue({
      queue: {
        status:  vi.fn().mockResolvedValue({ id: UNKNOWN_JOB_ID, status: 'running' }),
        results: vi.fn().mockResolvedValue([]),
        cancel:  vi.fn().mockResolvedValue(undefined),
      },
    } as any);

    const result = await cancelTool.handler({ jobId: UNKNOWN_JOB_ID });
    expect((result as any).cancelled).toBe(true);
  });

  it('crawl_results succeeds for a known job ID', async () => {
    const { getStores } = await import('../store/factory.js');
    vi.mocked(getStores).mockReturnValue({
      queue: {
        status:  vi.fn().mockResolvedValue({ id: UNKNOWN_JOB_ID, status: 'completed' }),
        results: vi.fn().mockResolvedValue([]),
        cancel:  vi.fn().mockResolvedValue(undefined),
      },
    } as any);

    const result = await resultsTool.handler({ jobId: UNKNOWN_JOB_ID });
    expect((result as any).pages).toBeDefined();
  });
});
