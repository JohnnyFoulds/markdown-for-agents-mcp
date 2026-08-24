import { z } from "zod";
import { fetchUrl } from "./fetchUrl.js";
import { fetchUrls } from "./fetchUrls.js";
import { webSearch } from "./webSearch.js";
import { downloadFile } from "../services/downloadFile.js";
import { extractUrls } from "../services/extractUrls.js";
import { mapSite } from "../services/mapSite.js";
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
    },
    outputSchema: fetchUrlOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => fetchUrl({ url: String(a.url), timeout: a.timeout as number | undefined }),
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
    },
    outputSchema: fetchUrlsOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => fetchUrls({ urls: (a.urls as string[]).map(String), timeout: a.timeout as number | undefined }),
    toText: (r: any) => (r.results as any[]).map((item: any) =>
      item.success
        ? `${item.markdown}\n\n---`
        : `## URL: ${item.url}\n\n**Error:** ${item.error ?? 'Unknown error'}\n\n---`
    ).join('\n\n'),
  },

  {
    name: 'web_search',
    description:
      "Search the web using DuckDuckGo and optionally fetch results to markdown. " +
      "Returns structured search results with title, URL, and snippet. " +
      "Supports domain filtering via allowedDomains and blockedDomains.",
    inputSchema: {
      query: z.string().describe("The search query to perform"),
      maxResults: z.number().optional().describe("Maximum number of search results to return (default: 10)"),
      allowedDomains: z.array(z.string()).optional().describe("Only include results from these domains"),
      blockedDomains: z.array(z.string()).optional().describe("Exclude results from these domains"),
      fetchResults: z.boolean().optional().describe("Fetch and convert top results to markdown (hybrid mode)"),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 30000)"),
    },
    outputSchema: webSearchOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (a: any) => webSearch({
      query: String(a.query),
      maxResults: a.maxResults as number | undefined,
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
      return downloadFile(String(a.url), path) as unknown as Promise<Record<string, unknown>>;
    },
    toText: (r: any) => JSON.stringify(r, null, 2),
  },
];
