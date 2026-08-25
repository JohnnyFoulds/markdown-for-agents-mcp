import { z } from "zod";
import { fetchUrl } from "./fetchUrl.js";
import { fetchUrls } from "./fetchUrls.js";
import { webSearch } from "./webSearch.js";
import { downloadFile } from "../services/downloadFile.js";
import { getConfig } from "../config.js";
import { extractUrls } from "../services/extractUrls.js";
import { mapSite } from "../services/mapSite.js";
import { crawlSync, startAsyncCrawl } from "../crawl/engine.js";
import { Logger } from "../utils/logger.js";
import type { ToolDefinition } from "../server/registry.js";

// ── Output schemas ────────────────────────────────────────────────────────────

const fetchUrlOutputSchema = {
  url: z.string(),
  title: z.string(),
  markdown: z.string(),
  fetchedAt: z.string(),
  contentSize: z.number(),
};

const fetchUrlsOutputSchema = {
  results: z.array(z.object({
    url: z.string(),
    title: z.string(),
    markdown: z.string(),
    fetchedAt: z.string(),
    contentSize: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
  })),
  summary: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
  }),
};

const webSearchOutputSchema = {
  query: z.string(),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    domain: z.string().optional(),
  })),
  fetchedContent: z.array(z.object({
    url: z.string(),
    markdown: z.string(),
  })).optional(),
  durationMs: z.number(),
};

const healthCheckOutputSchema = {
  status: z.enum(['healthy', 'unhealthy']),
  cache: z.object({
    hits: z.number(),
    misses: z.number(),
    currentSize: z.number(),
    totalBytes: z.number(),
    maxBytes: z.number(),
  }),
  metrics: z.object({
    totalFetches: z.number(),
    successCount: z.number(),
    errorCount: z.number(),
    avgDuration: z.number(),
    cacheUtilization: z.number(),
  }),
};

const downloadFileOutputSchema = {
  savedPath: z.string(),
  sizeBytes: z.number(),
  mimeType: z.string(),
  filename: z.string(),
};

const extractUrlsOutputSchema = {
  results: z.array(z.object({
    url: z.string(),
    title: z.string(),
    content: z.string(),
    format: z.enum(['markdown', 'html', 'text']),
    totalLength: z.number(),
    truncated: z.boolean(),
    contentSize: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
    fetchedAt: z.string(),
  })),
  summary: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
  }),
};

const mapSiteOutputSchema = {
  rootUrl: z.string(),
  urls: z.array(z.string()),
  total: z.number(),
  fromSitemap: z.boolean(),
  fromCrawl: z.boolean(),
};

const crawlPageSchema = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  contentSize: z.number(),
  depth: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
});

const crawlSiteOutputSchema = {
  rootUrl: z.string(),
  pages: z.array(crawlPageSchema),
  summary: z.object({ total: z.number(), succeeded: z.number(), failed: z.number() }),
};

const crawlStartOutputSchema = {
  jobId: z.string(),
  status: z.string(),
  rootUrl: z.string(),
};

const crawlStatusOutputSchema = {
  id: z.string(),
  rootUrl: z.string(),
  status: z.string(),
  total: z.number(),
  completed: z.number(),
  failed: z.number(),
  pending: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
};

const crawlResultsOutputSchema = {
  jobId: z.string(),
  pages: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    contentFormat: z.string().optional(),
    contentSize: z.number().optional(),
    depth: z.number(),
    status: z.string(),
    error: z.string().optional(),
    crawledAt: z.number().optional(),
  })),
  total: z.number(),
  offset: z.number(),
};

const crawlCancelOutputSchema = { jobId: z.string(), cancelled: z.boolean() };

const crawlListOutputSchema = {
  jobs: z.array(z.object({
    id: z.string(),
    rootUrl: z.string(),
    status: z.string(),
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
    pending: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })),
};

// ── Text formatters ───────────────────────────────────────────────────────────

type WebSearchOut = z.infer<z.ZodObject<typeof webSearchOutputSchema>>;

function formatWebSearchText(result: WebSearchOut): string {
  let out = `# Web Search Results\n\n## Query: ${result.query}\n` +
    `**Found ${result.results.length} results in ${result.durationMs}ms**\n\n### Results:\n\n`;
  result.results.forEach((item, i) => {
    out += `${i + 1}. [${item.title}](${item.url})\n`;
    if (item.snippet) out += `   ${item.snippet}\n`;
    out += '\n';
  });
  if (result.fetchedContent?.length) {
    out += `---\n\n## Fetched Content:\n\n`;
    result.fetchedContent.forEach(item => {
      out += `### ${item.url}\n${item.markdown}\n\n---\n\n`;
    });
  }
  return out.trim();
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [
  {
    name: 'fetch_url',
    description:
      "Fetch a URL with full JavaScript rendering (Playwright/Chromium) and convert to clean " +
      "markdown. Works on React, Vue, Angular, and any JS-heavy page. " +
      "Strips navigation, ads, and boilerplate. Optimized for AI agent use.",
    inputSchema: {
      url: z.string().describe("The URL to fetch and convert to markdown"),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 30000)"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers forwarded to the target (e.g. Authorization, Cookie)"),
    },
    outputSchema: fetchUrlOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => fetchUrl({ url: String(a.url), timeout: a.timeout as number | undefined, headers: a.headers as Record<string,string> | undefined }),
    toText: (r: any) => String(r.markdown),
  },

  {
    name: 'fetch_urls',
    description:
      "Fetch multiple URLs with full JavaScript rendering and convert each to clean markdown. " +
      "Batch operation with configurable parallelism. Each result includes the URL, title, and markdown.",
    inputSchema: {
      urls: z.array(z.string()).describe("Array of URLs to fetch and convert"),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 30000)"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers forwarded to every target URL (e.g. Authorization, Cookie)"),
    },
    outputSchema: fetchUrlsOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => fetchUrls({ urls: (a.urls as string[]).map(String), timeout: a.timeout as number | undefined, headers: a.headers as Record<string,string> | undefined }),
    toText: (r: any) => (r.results as any[]).map((item: any) =>
      item.success
        ? `${item.markdown}\n\n---`
        : `## URL: ${item.url}\n\n**Error:** ${item.error ?? 'Unknown error'}\n\n---`
    ).join('\n\n'),
  },

  {
    name: 'web_search',
    description:
      "Search the web using multiple providers (SearXNG, Brave, Serper, DuckDuckGo) with " +
      "automatic failover. Three depth modes: fast = SERP snippets only (~500ms); " +
      "basic = fetch and convert top pages to markdown; " +
      "advanced = fetch + rerank chunks by relevance to the query (best quality, ~10-15s). " +
      "Supports domain filtering via allowedDomains and blockedDomains.",
    inputSchema: {
      query: z.string().describe("The search query to perform"),
      maxResults: z.number().optional().describe("Maximum number of search results to return (default: 10)"),
      searchDepth: z.enum(['fast', 'basic', 'advanced']).optional().describe(
        "fast = snippets only (fastest, no page fetching); " +
        "basic = fetch and render top pages; " +
        "advanced = fetch + rerank chunks by relevance (default: fast)",
      ),
      chunksPerSource: z.number().optional().describe(
        "Top-N reranked chunks to include per source URL (advanced only, default: 1)",
      ),
      allowedDomains: z.array(z.string()).optional().describe("Only include results from these domains"),
      blockedDomains: z.array(z.string()).optional().describe("Exclude results from these domains"),
      fetchResults: z.boolean().optional().describe(
        "Explicitly enable (true) or disable (false) page fetching, overriding searchDepth",
      ),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 30000)"),
    },
    outputSchema: webSearchOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => webSearch({
      query: String(a.query),
      maxResults: a.maxResults as number | undefined,
      searchDepth: a.searchDepth as 'fast' | 'basic' | 'advanced' | undefined,
      chunksPerSource: a.chunksPerSource as number | undefined,
      allowedDomains: a.allowedDomains as string[] | undefined,
      blockedDomains: a.blockedDomains as string[] | undefined,
      fetchResults: a.fetchResults as boolean | undefined,
      timeout: a.timeout as number | undefined,
    }),
    toText: (r: any) => formatWebSearchText(r as WebSearchOut),
  },

  {
    name: 'health_check',
    description:
      "Check the health status of the MCP server. Returns server status, cache statistics, " +
      "and fetch metrics to verify the server is operating correctly.",
    inputSchema: {},
    outputSchema: healthCheckOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async () => Logger.getHealth(),
    toText: (r: any) => JSON.stringify(r, null, 2),
  },

  {
    name: 'extract_urls',
    description:
      "Fetch one or more URLs and extract their content in a specified format. " +
      "Supports markdown (default), HTML, and plain text output. " +
      "Supports CSS selector targeting to extract specific page sections, " +
      "and pagination via maxChars/offset to handle large pages. " +
      "Returns per-URL results with title, content, and truncation metadata.",
    inputSchema: {
      urls: z.array(z.string()).describe("URLs to fetch and extract content from"),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 30000)"),
      outputFormat: z.enum(['markdown', 'html', 'text']).optional().describe("Output format (default: markdown)"),
      includeSelector: z.string().optional().describe("CSS selector to extract a specific element (e.g. 'main', '#content', '.article')"),
      excludeSelectors: z.array(z.string()).optional().describe("CSS selectors of elements to remove before extraction"),
      maxChars: z.number().optional().describe("Maximum characters to return per URL (enables pagination)"),
      offset: z.number().optional().describe("Character offset to start from (for pagination)"),
    },
    outputSchema: extractUrlsOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => extractUrls({
      urls: (a.urls as string[]).map(String),
      timeout: a.timeout as number | undefined,
      outputFormat: a.outputFormat as 'markdown' | 'html' | 'text' | undefined,
      includeSelector: a.includeSelector as string | undefined,
      excludeSelectors: a.excludeSelectors as string[] | undefined,
      maxChars: a.maxChars as number | undefined,
      offset: a.offset as number | undefined,
    }) as unknown as Promise<Record<string, unknown>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toText: (r: any) => (r.results as any[]).map((item: any) =>
      item.success
        ? `${item.content}\n\n---`
        : `## URL: ${item.url}\n\n**Error:** ${item.error ?? 'Unknown error'}\n\n---`
    ).join('\n\n'),
  },

  {
    name: 'map_site',
    description:
      "Discover all URLs on a website by checking sitemap.xml and optionally crawling HTML links. " +
      "Returns a deduplicated list of same-origin URLs. Useful before crawling a site to understand its structure.",
    inputSchema: {
      url: z.string().describe("URL of the website to map (any page on the site; the root origin is used for sitemap discovery)"),
      maxUrls: z.number().optional().describe("Maximum number of URLs to return (default: 100)"),
      followLinks: z.boolean().optional().describe("Crawl HTML links in addition to sitemap.xml (default: true)"),
      timeout: z.number().optional().describe("Request timeout in milliseconds per page (default: 30000)"),
    },
    outputSchema: mapSiteOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => mapSite({
      url: String(a.url),
      maxUrls: a.maxUrls as number | undefined,
      followLinks: a.followLinks as boolean | undefined,
      timeout: a.timeout as number | undefined,
    }) as unknown as Promise<Record<string, unknown>>,
    toText: (r: any) => `# Site Map: ${r.rootUrl}\n\n**${r.total} URLs found** (sitemap: ${r.fromSitemap}, crawl: ${r.fromCrawl})\n\n${(r.urls as string[]).map((u: string) => `- ${u}`).join('\n')}`,
  },

  {
    name: 'download_file',
    description:
      "Download a binary file (PDF, image, ZIP, etc.) from a URL and save it to a local path. " +
      "Returns JSON metadata including the saved path, file size, MIME type, and filename. " +
      "SSRF protection and domain block list are enforced. Use fetch_url for web pages.",
    inputSchema: {
      url: z.string().describe("URL of the file to download"),
      outputPath: z.string().describe("Absolute local path to save the file to (parent directory must exist)"),
    },
    outputSchema: downloadFileOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => {
      const path = String(a.outputPath);
      if (!path.startsWith("/") && !(/^[A-Za-z]:[/\\]/.test(path))) {
        throw new Error("outputPath must be an absolute path");
      }
      const allowlist = getConfig().DOWNLOAD_DIR_ALLOWLIST
        .split(',').map(s => s.trim()).filter(Boolean);
      if (!allowlist.some(prefix => path.startsWith(prefix))) {
        throw new Error(
          `outputPath must be within an allowed directory. Allowed: ${allowlist.join(', ')} ` +
          '(set DOWNLOAD_DIR_ALLOWLIST to extend — POPIA s19)',
        );
      }
      return downloadFile(String(a.url), path) as unknown as Promise<Record<string, unknown>>;
    },
    toText: (r: any) => JSON.stringify(r, null, 2),
  },

  // ── Crawl tools (Phase 6) ────────────────────────────────────────────────────

  {
    name: 'crawl_site',
    description:
      "Crawl a website synchronously using BFS link traversal and return all discovered pages. " +
      "Respects maxPages/maxDepth limits. For large sites, use crawl_start instead. " +
      "Strips navigation and boilerplate. Returns page content in the specified format.",
    inputSchema: {
      url: z.string().describe("Root URL to start crawling from"),
      maxPages: z.number().optional().describe("Maximum pages to crawl (default: 50)"),
      maxDepth: z.number().optional().describe("Maximum link depth from root (default: 3)"),
      allowedDomains: z.array(z.string()).optional().describe("Only crawl these domains (default: same origin as root)"),
      blockedDomains: z.array(z.string()).optional().describe("Domains to exclude"),
      includeSelector: z.string().optional().describe("CSS selector to extract from each page"),
      excludeSelectors: z.array(z.string()).optional().describe("CSS selectors to strip from each page"),
      outputFormat: z.enum(['markdown', 'html', 'text']).optional().describe("Output format (default: markdown)"),
      timeout: z.number().optional().describe("Per-page timeout ms (default: 30000)"),
    },
    outputSchema: crawlSiteOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => crawlSync({
      rootUrl: String(a.url),
      maxPages: (a.maxPages as number | undefined) ?? 50,
      maxDepth: (a.maxDepth as number | undefined) ?? 3,
      allowedDomains: a.allowedDomains as string[] | undefined,
      blockedDomains: a.blockedDomains as string[] | undefined,
      includeSelector: a.includeSelector as string | undefined,
      excludeSelectors: a.excludeSelectors as string[] | undefined,
      outputFormat: a.outputFormat as 'markdown' | 'html' | 'text' | undefined,
      timeout: a.timeout as number | undefined,
    }) as unknown as Promise<Record<string, unknown>>,
    toText: (r: any) => {
      const pages = r.pages as any[];
      const lines: string[] = [`# Crawl: ${r.rootUrl}`, `**${r.summary.succeeded}/${r.summary.total} pages**\n`];
      for (const p of pages) {
        if (p.success) lines.push(`## ${p.url}\n${p.content}\n\n---`);
        else lines.push(`## ${p.url}\n**Error:** ${p.error}\n\n---`);
      }
      return lines.join('\n');
    },
  },

  {
    name: 'crawl_start',
    description:
      "Start an asynchronous crawl job for a website. Returns a jobId immediately. " +
      "Use crawl_status to monitor progress and crawl_results to retrieve pages when done.",
    inputSchema: {
      url: z.string().describe("Root URL to crawl"),
      maxPages: z.number().optional().describe("Maximum pages (default: 1000)"),
      maxDepth: z.number().optional().describe("Maximum link depth (default: 10)"),
      allowedDomains: z.array(z.string()).optional(),
      blockedDomains: z.array(z.string()).optional(),
      includeSelector: z.string().optional(),
      excludeSelectors: z.array(z.string()).optional(),
      outputFormat: z.enum(['markdown', 'html', 'text']).optional(),
      timeout: z.number().optional(),
    },
    outputSchema: crawlStartOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => {
      const { getStores } = await import('../store/factory.js');
      getStores(); // ensure initialized
      const jobId = await startAsyncCrawl({
        rootUrl: String(a.url),
        maxPages: (a.maxPages as number | undefined) ?? 1000,
        maxDepth: (a.maxDepth as number | undefined) ?? 10,
        allowedDomains: a.allowedDomains as string[] | undefined,
        blockedDomains: a.blockedDomains as string[] | undefined,
        includeSelector: a.includeSelector as string | undefined,
        excludeSelectors: a.excludeSelectors as string[] | undefined,
        outputFormat: a.outputFormat as 'markdown' | 'html' | 'text' | undefined,
        timeout: a.timeout as number | undefined,
      });
      return { jobId, status: 'running', rootUrl: String(a.url) };
    },
    toText: (r: any) => `Crawl started. Job ID: ${r.jobId}\nStatus: ${r.status}`,
  },

  {
    name: 'crawl_status',
    description: "Get the status and progress of an async crawl job.",
    inputSchema: { jobId: z.string().describe("Job ID returned by crawl_start") },
    outputSchema: crawlStatusOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => {
      const { getStores } = await import('../store/factory.js');
      const status = await getStores().queue.status(String(a.jobId));
      if (!status) throw new Error(`Job not found: ${a.jobId}`);
      return status as unknown as Record<string, unknown>;
    },
    toText: (r: any) => `Job ${r.id}: ${r.status} — ${r.completed}/${r.total} pages (${r.failed} failed)`,
  },

  {
    name: 'crawl_results',
    description: "Retrieve page results from an async crawl job with pagination.",
    inputSchema: {
      jobId: z.string().describe("Job ID"),
      offset: z.number().optional().describe("Pagination offset (default: 0)"),
      limit: z.number().optional().describe("Max pages to return (default: 50)"),
      filter: z.enum(['all', 'completed', 'failed']).optional().describe("Filter by page status (default: all)"),
    },
    outputSchema: crawlResultsOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => {
      const { getStores } = await import('../store/factory.js');
      const jobId = String(a.jobId);
      const exists = await getStores().queue.status(jobId);
      if (!exists) throw new Error(`Job not found: ${jobId}`);
      const offset = (a.offset as number | undefined) ?? 0;
      const limit = (a.limit as number | undefined) ?? 50;
      const filter = (a.filter as 'all' | 'completed' | 'failed' | undefined) ?? 'all';
      const pages = await getStores().queue.results(jobId, offset, limit, filter);
      return { jobId, pages, total: pages.length, offset };
    },
    toText: (r: any) => {
      const pages = r.pages as any[];
      const lines: string[] = [`# Results for job ${r.jobId} (offset ${r.offset})`];
      for (const p of pages) {
        if (p.status === 'completed' && p.content) lines.push(`## ${p.url}\n${p.content}\n\n---`);
        else lines.push(`## ${p.url}\n**Status:** ${p.status}${p.error ? ` — ${p.error}` : ''}\n\n---`);
      }
      return lines.join('\n');
    },
  },

  {
    name: 'crawl_cancel',
    description: "Cancel a running async crawl job.",
    inputSchema: { jobId: z.string() },
    outputSchema: crawlCancelOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => {
      const { getStores } = await import('../store/factory.js');
      const jobId = String(a.jobId);
      const exists = await getStores().queue.status(jobId);
      if (!exists) throw new Error(`Job not found: ${jobId}`);
      await getStores().queue.cancel(jobId);
      return { jobId, cancelled: true };
    },
    toText: (r: any) => `Job ${r.jobId} cancelled.`,
  },

  {
    name: 'crawl_list',
    description: "List all crawl jobs with their current status.",
    inputSchema: {},
    outputSchema: crawlListOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async () => {
      const { getStores } = await import('../store/factory.js');
      const jobs = await getStores().queue.list();
      return { jobs } as unknown as Record<string, unknown>;
    },
    toText: (r: any) => {
      const jobs = r.jobs as any[];
      if (jobs.length === 0) return 'No crawl jobs.';
      return jobs.map((j: any) => `- ${j.id} [${j.status}] ${j.rootUrl} — ${j.completed}/${j.total} pages`).join('\n');
    },
  },
];
