/**
 * Markdown anchor integrity guard.
 *
 * Purpose: catch the class of failure where a heading is renamed (e.g. during
 * de-branding) but at least one inbound ](#slug) TOC link is not updated to match.
 *
 * Strategy:
 *   1. Slug every heading in every git-tracked *.md file using the GitHub slug rule.
 *   2. Find every ](#slug) link in each file.
 *   3. Collect dead links (links whose slug has no matching heading in that file).
 *   4. Fail if any dead link is not in the pre-existing allowlist below.
 *
 * The allowlist was captured at commit ed79d8b (before de-branding began).
 * It enumerates broken TOC links that pre-date this guard.  Add to it only when
 * a commit knowingly introduces a new dead anchor, and document why there.
 *
 * Key format: "relative/path.md#slug" — line number excluded so that nearby
 * line-count changes don't produce false positives.
 *
 * To verify: rename a heading (without updating its TOC link) in any *.md
 * file → this test goes RED.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── GitHub slug rule (validated against this repo's own live TOCs) ────────────
// Example: "## 12. Current RERANK_BACKEND: What We Have and Gaps"
//       →  "#12-current-rerank_backend-what-we-have-and-gaps"
// Note: underscore survives; "." and ":" vanish.
function slugify(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, '')          // strip inline HTML
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '') // keep letters, digits, space, _, -
    .trim()
    .replace(/\s+/g, '-');
}

// ── Dead-anchor scanner for one file ─────────────────────────────────────────
interface DeadAnchor { file: string; line: number; anchorSlug: string }

function findDeadAnchors(relPath: string): DeadAnchor[] {
  const lines = readFileSync(join(ROOT, relPath), 'utf8').split('\n');
  let inFence = false;
  const headings = new Set<string>();
  const links: { line: number; anchorSlug: string }[] = [];

  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (h) headings.add(slugify(h[2]));
    for (const m of line.matchAll(/\]\(#([^)]+)\)/g)) {
      links.push({ line: i + 1, anchorSlug: m[1] });
    }
  });

  return links
    .filter(({ anchorSlug }) => !headings.has(anchorSlug))
    .map(({ line, anchorSlug }) => ({ file: relPath, line, anchorSlug }));
}

// ── Tracked markdown files (respects .gitignore) ─────────────────────────────
function trackedMarkdownFiles(): string[] {
  return execSync('git ls-files "*.md"', { cwd: ROOT })
    .toString().trim().split('\n').filter(Boolean);
}

// ── Pre-existing dead anchors — allowlisted at ed79d8b ────────────────────────
// These existed before this guard was introduced.  Do NOT add new entries here
// without a matching commit that documents why the dead anchor is acceptable.
const KNOWN_DEAD = new Set<string>([
  'FUTURE_WORK.md#moat-3-visual--screenshot-based-extraction',
  'FUTURE_WORK.md#4-anti-bot--stealth-improvements',
  'FUTURE_WORK.md#8-authentication--cookie-passthrough',
  'docs/enterprise/RUNBOOK.md#1-readyz-returning-503',
  'docs/enterprise/RUNBOOK.md#2-high-mcp-error-rate',
  'docs/enterprise/RUNBOOK.md#3-search-degradation',
  'docs/enterprise/RUNBOOK.md#4-cache-hit-rate-collapse',
  'docs/enterprise/RUNBOOK.md#5-latency-spike',
  'docs/enterprise/RUNBOOK.md#6-hpa-not-scaling',
  'docs/enterprise/RUNBOOK.md#7-oom--pod-eviction',
  'docs/enterprise/RUNBOOK.md#8-ssrf-violation',
  'docs/enterprise/RUNBOOK.md#9-rollback',
  'docs/research/connectors/email-exchange.md#3-graph-mail-api--complete-reference',
  'docs/research/connectors/email-exchange.md#6-delta-sync--incremental-indexing',
  'docs/research/connectors/email-exchange.md#7-message-schema--all-fields',
  'docs/research/connectors/email-exchange.md#11-html-to-markdown--text-extraction',
  'docs/research/connectors/email-exchange.md#16-exchange-web-services-ews--deprecated',
  'docs/research/connectors/jira.md#4-issue-search--the-core-endpoint',
  'docs/research/connectors/jira.md#11-issue-history--changelog',
  'docs/research/connectors/notion.md#5-rich-text-to-markdown',
  'docs/research/connectors/notion.md#12-rate-limits-and-retry',
  'docs/research/connectors/notion.md#14-complete-typescript-connector',
  'docs/research/connectors/other-connectors.md#12-top-5-connectors-to-build-after-sharepoint--confluence',
  'docs/research/connectors/slack.md#searchmessages--legacy-search-api',
  'docs/research/connectors/slack.md#assistantsearchcontext--real-time-search-api-recommended',
  'docs/research/connectors/slack.md#conversationshistory--full-history-crawl',
  'docs/research/connectors/slack.md#conversationsreplies--thread-handling',
  'docs/research/connectors/slack.md#conversationslist--channel-discovery',
  'docs/research/connectors/slack.md#event-subscriptions--real-time-indexing',
  'docs/research/enterprise-knowledge/dust.md#2-agent-builder--how-agents-are-defined',
  'docs/research/enterprise-knowledge/dust.md#3-skills-system--reusable-intelligence-packages',
  'docs/research/enterprise-knowledge/dust.md#4-knowledge--data-source-connections',
  'docs/research/enterprise-knowledge/dust.md#5-knowledge-retrieval--rag-architecture',
  'docs/research/enterprise-knowledge/dust.md#6-tool-ecosystem--what-agents-can-do',
  'docs/research/enterprise-knowledge/dust.md#7-triggers--scheduling-and-automation',
  'docs/research/enterprise-knowledge/dust.md#8-permission-model--access-control-architecture',
  'docs/research/enterprise-knowledge/dust.md#9-mcp-integration--both-directions',
  'docs/research/enterprise-knowledge/dust.md#12-pricing--plans-seats-credits',
  'docs/research/enterprise-knowledge/dust.md#13-pods--collaborative-workspaces',
  'docs/research/enterprise-knowledge/dust.md#14-frames--interactive-outputs',
  'docs/research/enterprise-knowledge/dust.md#16-competitive-positioning--dust-vs-alternatives',
  'docs/research/enterprise-knowledge/glean.md#3-connector-catalog--complete-breakdown',
  'docs/research/enterprise-knowledge/microsoft-graph.md#3-entra-id-app-registration',
  'docs/research/enterprise-knowledge/microsoft-graph.md#5-graph-search-api',
  'docs/research/enterprise-knowledge/microsoft-graph.md#7-delta-sync',
  'docs/research/enterprise-knowledge/microsoft-graph.md#9-microsoft-graph-mcp-server',
  'docs/research/enterprise-knowledge/microsoft-graph.md#10-transitivememberof-acl',
  'docs/research/enterprise-knowledge/microsoft-graph.md#11-msal-nodejs',
  'docs/research/enterprise-knowledge/microsoft-graph.md#12-throttling',
  'docs/research/enterprise-knowledge/microsoft-graph.md#14-build-vs-skip',
  'docs/research/enterprise-knowledge/microsoft-graph.md#15-limitations-and-gotchas',
  'docs/research/enterprise-knowledge/onyx.md#5-permission-architecture--acl-mirroring',
  'docs/research/enterprise-knowledge/onyx.md#6-mcp-server--full-reference',
  'docs/research/enterprise-knowledge/onyx.md#7-hybrid-search--bm25--vector',
  'docs/research/enterprise-knowledge/onyx.md#15-10-architectural-decisions-to-adopt',
  'docs/research/patterns/acl-enforcement.md#4-pattern-c-in-depth-crawl-time-snapshot--query-time-token-validation',
  'docs/research/patterns/acl-enforcement.md#11-pgvector--postgresql-rls-for-acl',
  'docs/research/patterns/embeddings.md#2-mteb-leaderboard-2026--retrieval-rankings',
  'docs/research/patterns/embeddings.md#4-multilingual-quality--south-african-languages',
  'docs/research/patterns/embeddings.md#8-transformersjs--onnx-in-nodejs',
  'docs/research/patterns/hybrid-search.md#7-postgresql-pgvector--bm25-hybrid',
  'docs/research/patterns/hybrid-search.md#8-qdrant-dense--sparse-hybrid',
  'docs/research/patterns/hybrid-search.md#10-sqlite-fts5--sqlite-vec-lightweight-hybrid',
  'docs/research/web-layer/jina.md#2-reader-api--rjinaai',
  'docs/research/web-layer/jina.md#3-search-api--sjinaai',
  'docs/research/web-layer/jina.md#4-grounding--fact-check-api--gjinaai',
  'docs/research/web-layer/jina.md#14-nodejs--typescript-implementation-patterns',
  'docs/research/web-layer/perplexity.md#9-rate-limits',
  'docs/research/web-layer/perplexity.md#13-answer-synthesis-pipeline',
  'docs/research/web-layer/perplexity.md#15-limitations',
  'docs/research/web-layer/searxng.md#2-engine-catalogue--all-272-engines',
  'docs/research/web-layer/searxng.md#3-json-api--complete-reference',
  'docs/research/web-layer/searxng.md#4-settingsyml--full-configuration-reference',
  'docs/research/web-layer/searxng.md#11-searxng-vs-whoogle-vs-kagi-api--decision-guide',
  'docs/research/web-layer/web-scraping-apis.md#2-scrapingbee--complete-api-reference',
  'docs/research/web-layer/web-scraping-apis.md#3-spidercloud--complete-api-reference',
  'docs/research/web-layer/web-scraping-apis.md#4-apify--actor-model-architecture',
  'docs/research/web-layer/web-scraping-apis.md#5-zenrows--anti-bot-infrastructure',
  'docs/research/web-layer/web-scraping-apis.md#6-scrapfly--middleware-anti-bot-platform',
]);

// ── Collect and test ──────────────────────────────────────────────────────────
const files = trackedMarkdownFiles();
const newDeadAnchors: DeadAnchor[] = [];
for (const file of files) {
  for (const da of findDeadAnchors(file)) {
    if (!KNOWN_DEAD.has(`${da.file}#${da.anchorSlug}`)) {
      newDeadAnchors.push(da);
    }
  }
}

describe('Markdown anchor integrity', () => {
  it('no heading renames have introduced new dead TOC links', () => {
    const report = newDeadAnchors
      .map(({ file, line, anchorSlug }) => `  ${file}:${line}: dead anchor #${anchorSlug}`)
      .join('\n');
    expect(
      newDeadAnchors,
      `New dead anchors detected (not in KNOWN_DEAD allowlist):\n${report}\n\n` +
      'Either update the heading\'s TOC link, or — if intentional — add the entry\n' +
      'to KNOWN_DEAD in src/docsAnchors.test.ts and document the reason in the commit.',
    ).toHaveLength(0);
  });
});
