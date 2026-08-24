import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('./webSearch.js', () => ({
  webSearch: vi.fn().mockResolvedValue({ query: '', results: [], durationMs: 0 }),
}));

vi.mock('../crawl/engine.js', () => ({
  crawlSync: vi.fn(),
  startAsyncCrawl: vi.fn(),
}));

vi.mock('../services/mapSite.js', () => ({
  mapSite: vi.fn(),
}));

import { TOOLS } from './definitions.js';
import { webSearch } from './webSearch.js';

const wst = TOOLS.find(t => t.name === 'web_search')!;

describe('web_search tool — Phase 2 schema activation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // RED today: key absent from inputSchema
  it('inputSchema has searchDepth key', () => {
    expect(wst.inputSchema).toHaveProperty('searchDepth');
  });

  // RED today: key absent from inputSchema
  it('inputSchema has chunksPerSource key', () => {
    expect(wst.inputSchema).toHaveProperty('chunksPerSource');
  });

  // RED today: handler drops searchDepth before calling webSearch
  it('handler passes searchDepth to webSearch', async () => {
    await (wst.handler as (a: Record<string, unknown>) => Promise<unknown>)({
      query: 'test query',
      searchDepth: 'advanced',
    });
    expect(webSearch).toHaveBeenCalledWith(
      expect.objectContaining({ searchDepth: 'advanced' }),
    );
  });

  // RED today: handler drops chunksPerSource before calling webSearch
  it('handler passes chunksPerSource to webSearch', async () => {
    await (wst.handler as (a: Record<string, unknown>) => Promise<unknown>)({
      query: 'test query',
      chunksPerSource: 3,
    });
    expect(webSearch).toHaveBeenCalledWith(
      expect.objectContaining({ chunksPerSource: 3 }),
    );
  });

  // RED today: description still says "DuckDuckGo" — single provider claim
  it('description does not claim a single provider', () => {
    expect(wst.description).not.toContain('using DuckDuckGo');
  });
});

// ── Phase 4.1 — DAST probe coverage contract ─────────────────────────────────
//
// Mirrors the classification logic in scripts/scan-dast.mjs buildProbesForTool().
// If this test goes red, the DAST scan will also fail at the coverage gate for
// the same tool — both gates must be updated together when adding a new tool.
//
// Removing a tool from TOOLS without updating EXPECTED_PROBE_COVERAGE → test fails.
// Adding a tool to TOOLS without updating EXPECTED_PROBE_COVERAGE → test fails.
// Adding a parameter with a dangerous name to an existing tool → classification
//   function automatically picks it up (no manual update needed).

describe('Phase 4.1 — DAST probe coverage contract', () => {
  // Tools that carry no attack-relevant parameters. Must be kept in sync with
  // NO_ATTACK_SURFACE_TOOLS in scripts/scan-dast.mjs.
  const NO_ATTACK_SURFACE_TOOLS = new Set<string>(['health_check', 'crawl_list']);

  // Classify a tool's input schema parameters by attack-surface category.
  // Uses parameter NAMES only — no Zod internals — for resilience against Zod
  // version changes. The inputSchema keys are stable tool API surface.
  function getProbeClasses(tool: typeof TOOLS[number]): string[] {
    const classes = new Set<string>();
    for (const param of Object.keys(tool.inputSchema)) {
      const n = param.toLowerCase();
      if (n === 'url' || n === 'urls') classes.add('ssrf');
      if (n === 'outputpath' || n.endsWith('path') || n === 'filename') classes.add('path');
      if (n === 'headers') classes.add('headers');
      if (n === 'query' || n === 'jobid') classes.add('injection');
    }
    return [...classes];
  }

  it('every tool has at least one probe class, or is explicitly in NO_ATTACK_SURFACE_TOOLS', () => {
    const failures: string[] = [];
    for (const tool of TOOLS) {
      const classes = getProbeClasses(tool);
      if (classes.length === 0 && !NO_ATTACK_SURFACE_TOOLS.has(tool.name)) {
        failures.push(
          `Tool "${tool.name}" has no classifiable parameters and is not in NO_ATTACK_SURFACE_TOOLS.\n` +
          `  Params: [${Object.keys(tool.inputSchema).join(', ')}]\n` +
          `  Either add probe coverage in scripts/scan-dast.mjs, or add "${tool.name}" ` +
          `to NO_ATTACK_SURFACE_TOOLS if it truly has no attack surface.`,
        );
      }
    }
    if (failures.length > 0) throw new Error(failures.join('\n\n'));
  });

  it('NO_ATTACK_SURFACE_TOOLS contains only tools that exist in TOOLS', () => {
    const toolNames = new Set(TOOLS.map(t => t.name));
    for (const name of NO_ATTACK_SURFACE_TOOLS) {
      expect(toolNames.has(name), `NO_ATTACK_SURFACE_TOOLS contains "${name}" but no such tool exists`).toBe(true);
    }
  });

  it('all URL-accepting tools are classified as ssrf', () => {
    const expectedSsrfTools = [
      'fetch_url', 'fetch_urls', 'extract_urls',
      'map_site', 'download_file', 'crawl_site', 'crawl_start',
    ];
    const ssrfTools = TOOLS.filter(t => getProbeClasses(t).includes('ssrf')).map(t => t.name);
    for (const name of expectedSsrfTools) {
      expect(ssrfTools, `Tool "${name}" should be classified as ssrf (has url/urls param)`).toContain(name);
    }
  });

  it('download_file is classified as path (has outputPath)', () => {
    const dl = TOOLS.find(t => t.name === 'download_file');
    expect(dl).toBeDefined();
    expect(getProbeClasses(dl!)).toContain('path');
  });

  it('fetch_url and fetch_urls are classified as headers (have headers record param)', () => {
    for (const name of ['fetch_url', 'fetch_urls']) {
      const tool = TOOLS.find(t => t.name === name);
      expect(tool).toBeDefined();
      expect(getProbeClasses(tool!), `"${name}" should be classified as headers`).toContain('headers');
    }
  });

  it('injection-surface tools include web_search and crawl job management tools', () => {
    // crawl_start is no longer in this list: it previously had a `query` field that was accepted,
    // persisted, and never read (POPIA Phase 0 dead-field removal). The injection surface was the
    // dead field. crawl_start is still probed for SSRF via its `url` parameter.
    const expected = ['web_search', 'crawl_status', 'crawl_results', 'crawl_cancel'];
    const injectionTools = TOOLS.filter(t => getProbeClasses(t).includes('injection')).map(t => t.name);
    for (const name of expected) {
      expect(injectionTools, `Tool "${name}" should be classified as injection`).toContain(name);
    }
  });

  it('total tool count matches expected (update when tools are added/removed)', () => {
    // This assertion is intentionally strict: any new tool triggers a red test
    // until the author verifies probe coverage and updates this count.
    expect(TOOLS).toHaveLength(13);
  });
});
