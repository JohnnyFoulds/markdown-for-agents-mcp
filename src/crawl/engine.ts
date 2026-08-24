import { randomUUID } from 'node:crypto';
import { renderLadder } from '../render/ladder.js';
import { extract } from '../extract/pipeline.js';
import { validateUrl } from '../utils/domainBlacklist.js';
import { Logger } from '../utils/logger.js';
import type { JobSpec, QueueItem, LeasedItem, PageRecord } from '../store/types.js';

export interface CrawlPageResult {
  url: string;
  title: string;
  content: string;
  contentSize: number;
  depth: number;
  success: boolean;
  error?: string;
}

export interface SyncCrawlResult {
  rootUrl: string;
  pages: CrawlPageResult[];
  summary: { total: number; succeeded: number; failed: number };
}

// ── Link extraction ───────────────────────────────────────────────────────────

function extractLinks(html: string, baseUrl: string, rootOrigin: string): string[] {
  const links: string[] = [];
  const hrefRe = /<a\s[^>]*href=["']([^"'#][^"']*?)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1]!, baseUrl);
      resolved.hash = '';
      const url = resolved.toString();
      // same-origin only
      const origin = resolved.protocol + '//' + resolved.host;
      if (origin === rootOrigin) links.push(url);
    } catch { /* malformed href */ }
  }
  return links;
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol + '//' + ua.host === ub.protocol + '//' + ub.host;
  } catch { return false; }
}

function matchesDomainFilter(url: string, allowed?: string[], blocked?: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (blocked?.some(d => host === d || host.endsWith('.' + d))) return false;
    if (allowed && allowed.length > 0) {
      return allowed.some(d => host === d || host.endsWith('.' + d));
    }
    return true;
  } catch { return false; }
}

// ── Render + extract one URL ──────────────────────────────────────────────────

async function renderAndExtract(
  url: string,
  spec: Pick<JobSpec, 'includeSelector' | 'excludeSelectors' | 'outputFormat' | 'timeout'>,
): Promise<{ html: string; title: string; links: string[]; rootOrigin: string }> {
  const rootOrigin = new URL(url).protocol + '//' + new URL(url).host;
  const result = await renderLadder.render({
    url,
    timeoutMs: spec.timeout ?? 30_000,
    requestId: randomUUID(),
  });
  const links = extractLinks(result.html, url, rootOrigin);
  return { html: result.html, title: result.title, links, rootOrigin };
}

// ── Sync bounded BFS (crawl_site) ─────────────────────────────────────────────

export async function crawlSync(spec: JobSpec): Promise<SyncCrawlResult> {
  const {
    rootUrl, maxPages, maxDepth, allowedDomains, blockedDomains,
    includeSelector, excludeSelectors, outputFormat = 'markdown', timeout,
  } = spec;

  const validation = validateUrl(rootUrl);
  if (!validation.valid) throw new Error(validation.error);

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: rootUrl, depth: 0 }];
  const pages: CrawlPageResult[] = [];
  const rootOrigin = new URL(rootUrl).protocol + '//' + new URL(rootUrl).host;

  while (queue.length > 0 && pages.length < maxPages) {
    const batch = queue.splice(0, 5); // process up to 5 in parallel

    await Promise.all(batch.map(async ({ url, depth }) => {
      if (visited.has(url) || pages.length >= maxPages) return;
      visited.add(url);

      if (!matchesDomainFilter(url, allowedDomains, blockedDomains)) return;
      if (!validateUrl(url).valid) return;

      try {
        const { html, title, links } = await renderAndExtract(url, { includeSelector, excludeSelectors, outputFormat, timeout });
        const extracted = extract(html, { url, title, outputFormat, includeSelector, excludeSelectors });

        pages.push({
          url, title: extracted.title, content: extracted.markdown,
          contentSize: extracted.contentSize, depth, success: true,
        });

        if (depth < maxDepth) {
          for (const link of links) {
            if (!visited.has(link) && isSameOrigin(link, rootOrigin) &&
                matchesDomainFilter(link, allowedDomains, blockedDomains)) {
              queue.push({ url: link, depth: depth + 1 });
            }
          }
        }
      } catch (err) {
        pages.push({
          url, title: '', content: '', contentSize: 0, depth, success: false,
          error: err instanceof Error ? err.message : 'Fetch failed',
        });
      }
    }));
  }

  const succeeded = pages.filter(p => p.success).length;
  return {
    rootUrl,
    pages,
    summary: { total: pages.length, succeeded, failed: pages.length - succeeded },
  };
}

// ── Async crawl worker step ───────────────────────────────────────────────────

export interface WorkerStep {
  processItem(item: LeasedItem, spec: JobSpec): Promise<{ record: PageRecord; discoveredLinks: QueueItem[] }>;
}

export async function processQueueItem(
  item: LeasedItem,
  spec: JobSpec,
): Promise<{ record: PageRecord; discoveredLinks: QueueItem[] }> {
  const now = Date.now();

  if (!validateUrl(item.url).valid || !matchesDomainFilter(item.url, spec.allowedDomains, spec.blockedDomains)) {
    return {
      record: {
        url: item.url, jobId: item.jobId, status: 'failed',
        depth: item.depth, error: 'URL blocked or invalid', crawledAt: now,
      },
      discoveredLinks: [],
    };
  }

  try {
    const { html, title, links } = await renderAndExtract(item.url, {
      includeSelector: spec.includeSelector,
      excludeSelectors: spec.excludeSelectors,
      outputFormat: spec.outputFormat,
      timeout: spec.timeout,
    });

    const extracted = extract(html, {
      url: item.url, title,
      outputFormat: spec.outputFormat ?? 'markdown',
      includeSelector: spec.includeSelector,
      excludeSelectors: spec.excludeSelectors,
    });

    const record: PageRecord = {
      url: item.url, jobId: item.jobId, status: 'completed',
      title: extracted.title, content: extracted.markdown,
      contentFormat: spec.outputFormat ?? 'markdown',
      contentSize: extracted.contentSize,
      depth: item.depth, crawledAt: now,
    };

    const discoveredLinks: QueueItem[] = item.depth < spec.maxDepth
      ? links
          .filter(l => matchesDomainFilter(l, spec.allowedDomains, spec.blockedDomains) && validateUrl(l).valid)
          .map(url => ({ url, depth: item.depth + 1, parentUrl: item.url }))
      : [];

    return { record, discoveredLinks };
  } catch (err) {
    Logger.debug(`[crawl] Failed ${item.url}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      record: {
        url: item.url, jobId: item.jobId, status: 'failed',
        depth: item.depth, error: err instanceof Error ? err.message : 'Fetch failed', crawledAt: now,
      },
      discoveredLinks: [],
    };
  }
}

// ── Worker loop ───────────────────────────────────────────────────────────────

export async function runWorkerLoop(opts: {
  workerId: string;
  pollMs: number;
  leaseMs: number;
  batchSize: number;
  signal: AbortSignal;
}): Promise<void> {
  const { workerId, pollMs, leaseMs, batchSize, signal } = opts;

  Logger.info(`[worker:${workerId}] starting`);

  const { getStores } = await import('../store/factory.js');

  while (!signal.aborted) {
    const stores = getStores();

    // Claim a job
    const claim = await stores.queue.claimJob(workerId, leaseMs).catch(() => undefined);
    if (!claim) {
      await sleep(pollMs, signal);
      continue;
    }

    const summary = await stores.queue.status(claim.jobId);
    if (!summary || summary.status === 'cancelled') {
      await sleep(pollMs, signal);
      continue;
    }

    // Get job spec from queue
    const spec = await getJobSpec(claim.jobId, stores.queue);
    if (!spec) { await sleep(pollMs, signal); continue; }

    Logger.info(`[worker:${workerId}] processing job ${claim.jobId}`);

    // Drain the job
    while (!signal.aborted) {
      const items = await stores.queue.lease(claim.jobId, batchSize, leaseMs);
      if (items.length === 0) break;

      // Heartbeat while processing
      const heartbeatInterval = setInterval(async () => {
        await stores.queue.heartbeat(items, leaseMs).catch(() => {});
      }, Math.floor(leaseMs / 3));

      try {
        await Promise.all(items.map(async (item) => {
          const { record, discoveredLinks } = await processQueueItem(item, spec);

          if (record.status === 'completed') {
            await stores.queue.complete(item, record);
          } else {
            await stores.queue.fail(item, record.error ?? 'Unknown error', false);
          }

          if (discoveredLinks.length > 0) {
            const jobStatus = await stores.queue.status(claim.jobId);
            const cap = spec.maxPages - ((jobStatus?.completed ?? 0) + (jobStatus?.pending ?? 0));
            if (cap > 0) {
              await stores.queue.enqueue(claim.jobId, discoveredLinks.slice(0, cap));
            }
          }
        }));
      } finally {
        clearInterval(heartbeatInterval);
      }
    }

    Logger.info(`[worker:${workerId}] finished job ${claim.jobId}`);
  }

  Logger.info(`[worker:${workerId}] stopped`);
}

async function getJobSpec(jobId: string, _queue: import('../store/types.js').JobQueue): Promise<JobSpec | undefined> {
  // The spec is embedded in the summary's rootUrl — but we need the full spec.
  // We store the spec in the job. For memory backend it's in the entry.
  // For SQLite, we need to fetch it from the crawl_jobs table.
  // We access the spec indirectly through the summary.
  // Since JobSummary only has rootUrl, we need a different approach.
  // Let's store the spec in the KV store under job:<id>:spec.
  const { getStores } = await import('../store/factory.js');
  const stores = getStores();
  const raw = await stores.kv.get(`job:${jobId}:spec`);
  if (!raw) return undefined;
  try { return JSON.parse(raw.toString('utf8')) as JobSpec; }
  catch { return undefined; }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// ── Start async crawl ─────────────────────────────────────────────────────────

export async function startAsyncCrawl(spec: JobSpec): Promise<string> {
  const validation = validateUrl(spec.rootUrl);
  if (!validation.valid) throw new Error(validation.error);

  const { getStores } = await import('../store/factory.js');
  const stores = getStores();

  const jobId = await stores.queue.createJob(spec);

  // Store full spec in KV for worker retrieval
  await stores.kv.set(`job:${jobId}:spec`, Buffer.from(JSON.stringify(spec)), 7 * 24 * 60 * 60 * 1000);

  // Seed with root URL
  await stores.queue.enqueue(jobId, [{ url: spec.rootUrl, depth: 0 }]);

  return jobId;
}
