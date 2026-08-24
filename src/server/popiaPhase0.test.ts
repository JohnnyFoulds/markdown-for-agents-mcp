/**
 * POPIA Phase 0 — truth and dead-field assertions.
 *
 * Phase 0 RED reason (before fix):
 *   DATA_FLOW.md contains at least five claims that contradict the code:
 *   1. "queries are used … and then discarded" / "not written to any persistent store"
 *      — FALSE: JobSpec.query is persisted in crawl_jobs.spec and kv job:{id}:spec
 *   2. "Full page content … never written to disk or a database"
 *      — FALSE: crawl_pages.content TEXT; Redis mcp:job:{id}:pages; download_file; search cache
 *   3. "the only data that leaves the cluster is the query string and the page fetch requests"
 *      — FALSE: DuckDuckGo isConfigured() always returns true (no config gate)
 *   4. "Crawl job queue … TTL set on enqueue"
 *      — FALSE: enqueue() sets no EXPIRE at all
 *   5. Log table shows tool/durationMs/provider/query fields per-request
 *      — FALSE: LOG_FORMAT=text drops the data object; these fields do not appear
 *
 *   POPIA_ASSESSMENT.md:
 *   6. [ASSESSOR_NAME] placeholder still present — unsigned document asserting compliance
 *   7. Four "✓ Compliant" rows that are currently false
 *
 *   JobSpec / crawl_start dead fields:
 *   8. JobSpec.query and JobSpec.relevanceThreshold are accepted, persisted, and NEVER read
 *   9. crawl_start tool description promises "pages scored below relevanceThreshold are skipped"
 *      — that scoring never happens
 *
 *   THREAT_MODEL.md:
 *  10. Says "only /tmp and /dev/shm writable by UID 1000" but readOnlyRootFilesystem
 *      is omitted in server.yaml and worker.yaml, so /home/pwuser is also writable
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = join(__dirname, '../../docs/enterprise');
const REPO_ROOT = join(__dirname, '../..');

function readDoc(file: string): string {
  return readFileSync(join(DOCS, file), 'utf8');
}

// ── DATA_FLOW.md false claims ─────────────────────────────────────────────────

describe('DATA_FLOW.md — false claims must be corrected (Phase 0)', () => {
  const df = readDoc('DATA_FLOW.md');

  it('does NOT claim query text is discarded without persisting', () => {
    // The false claim: "queries are used to build the search request and then discarded.
    //   They are not written to any persistent store."
    // Reality: JobSpec.query is written to crawl_jobs.spec and kv job:{id}:spec.
    expect(df).not.toMatch(/not written to any persistent store/i);
  });

  it('does NOT claim page content is never written to disk or database', () => {
    // The false claim: "It is never written to disk or a database."
    // Reality: crawl_pages.content TEXT; Redis mcp:job:{id}:pages; download_file; search cache.
    expect(df).not.toMatch(/never written to disk or a database/i);
  });

  it('does NOT claim crawl queue has TTL set on enqueue', () => {
    // The false claim: "Until processed; TTL set on enqueue"
    // Reality: enqueue() sets no EXPIRE in any backend.
    expect(df).not.toMatch(/TTL set on enqueue/i);
  });

  it('does NOT claim only query+page fetches leave the cluster (omits DuckDuckGo)', () => {
    // The false claim: "the only data that leaves the cluster is the query string
    //   and the page fetch requests"
    // Reality: DuckDuckGo isConfigured() returns true unconditionally — always in the
    //   fanout, US-hosted, no agreement, no mention in this document.
    expect(df).not.toMatch(/only data that leaves the cluster is the query string/i);
  });

  it('mentions DuckDuckGo in the egress section', () => {
    // DuckDuckGo receives query text on every degraded search. Must be disclosed.
    expect(df).toMatch(/DuckDuckGo/i);
  });

  it('documents that the URL page cache (urlCache) is process-global and cross-caller', () => {
    // Phase 1 will fix this; Phase 0 must document the gap before the fix.
    expect(df).toMatch(/urlCache|page cache|shared.*cache|cross-caller/i);
  });
});

// ── POPIA_ASSESSMENT.md placeholder and false summary rows ────────────────────

describe('POPIA_ASSESSMENT.md — must not contain false assertions (Phase 0)', () => {
  const pa = readDoc('POPIA_ASSESSMENT.md');

  it('does NOT contain the [ASSESSOR_NAME] placeholder', () => {
    // An unsigned document asserting compliance is worse than a documented gap.
    expect(pa).not.toMatch(/\[ASSESSOR_NAME\]/);
  });

  it('does NOT have four "✓ Compliant" rows (at least two must be corrected)', () => {
    // Reality: Purpose specification, Information quality, and Openness rows are false.
    // After Phase 0 these must be downgraded to "⚠ Gap" or "✗ Not yet".
    const compliantRows = (pa.match(/✓ Compliant/g) || []).length;
    expect(compliantRows).toBeLessThan(4);
  });

  it('does NOT claim query text is not retained', () => {
    // False: JobSpec.query is persisted in crawl_jobs.spec and kv store.
    expect(pa).not.toMatch(/not retained beyond the request lifecycle/i);
  });

  it('does NOT claim no personal information is written to any database', () => {
    expect(pa).not.toMatch(/not written to any database/i);
  });
});

// ── JobSpec dead fields ───────────────────────────────────────────────────────

describe('JobSpec — dead fields must be removed (Phase 0)', () => {
  const typesPath = join(REPO_ROOT, 'src/store/types.ts');
  const types = readFileSync(typesPath, 'utf8');

  it('JobSpec does NOT have a query field', () => {
    // This field is accepted, persisted in two places, and NEVER read.
    // It collects PII with no purpose — POPIA s10 minimality violation.
    expect(types).not.toMatch(/^\s+query\?\s*:/m);
  });

  it('JobSpec does NOT have a relevanceThreshold field', () => {
    // This field is accepted, persisted, and NEVER read.
    // crawl_start description falsely promises it is used for scoring.
    expect(types).not.toMatch(/^\s+relevanceThreshold\?\s*:/m);
  });
});

// ── crawl_start tool description dead promise ─────────────────────────────────

describe('crawl_start inputSchema — dead description must be removed (Phase 0)', () => {
  const defsPath = join(REPO_ROOT, 'src/tools/definitions.ts');
  const defs = readFileSync(defsPath, 'utf8');

  it('does NOT describe a relevanceThreshold field', () => {
    // "Minimum relevance score 0–1 (requires query)" — the scoring never happens.
    expect(defs).not.toMatch(/relevanceThreshold/i);
  });

  it('does NOT describe a query field that promises scoring', () => {
    // "Relevance query — pages scored below relevanceThreshold are skipped"
    // — the scoring never happens.
    expect(defs).not.toMatch(/pages scored below relevanceThreshold/i);
  });
});

// ── THREAT_MODEL.md filesystem write containment claim ───────────────────────

describe('THREAT_MODEL.md — filesystem containment claim must be corrected (Phase 0)', () => {
  const tm = readDoc('THREAT_MODEL.md');

  it('does NOT claim only /tmp and /dev/shm are writable by UID 1000', () => {
    // readOnlyRootFilesystem is omitted in both server.yaml and worker.yaml,
    // so /home/pwuser is also writable. The claim overstates containment.
    expect(tm).not.toMatch(/only.*writable locations are.*\/tmp.*and.*\/dev\/shm/i);
  });
});
