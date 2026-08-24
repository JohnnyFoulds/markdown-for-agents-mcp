#!/usr/bin/env node
/**
 * markdown-for-agents-mcp
 * MCP server for AI agents - fetch URLs and convert to clean markdown
 */

import { createRequire } from "module";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fetchUrl } from "./tools/fetchUrl.js";
import { fetchUrls } from "./tools/fetchUrls.js";
import { webSearch } from "./tools/webSearch.js";
import { WebSearchResult } from "./tools/types.js";
import { downloadFile } from "./services/downloadFile.js";
import { fetcher } from "./fetcher.js";
import { Logger } from "./utils/logger.js";
import { validateAndInitializeConfig } from "./config.js";

const require = createRequire(import.meta.url);

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  Logger.info(`Received ${signal}, initiating graceful shutdown...`);

  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    await fetcher.close();
    Logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    Logger.error(`Error during shutdown: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch((err) => {
    Logger.error(`Unhandled shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
});
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch((err) => {
    Logger.error(`Unhandled shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
});

const { version } = require("../package.json") as { version: string };

/**
 * Format web search results as a readable markdown string.
 * Used to populate the text content field in the MCP response.
 */
function formatWebSearchText(result: WebSearchResult): string {
  let output = `# Web Search Results\n\n## Query: ${result.query}\n**Found ${result.results.length} results in ${result.durationMs}ms**\n\n### Results:\n\n`;

  result.results.forEach((item, index) => {
    output += `${index + 1}. [${item.title}](${item.url})\n`;
    if (item.snippet) {
      output += `   ${item.snippet}\n`;
    }
    output += `\n`;
  });

  if (result.fetchedContent && result.fetchedContent.length > 0) {
    output += `---\n\n## Fetched Content:\n\n`;
    result.fetchedContent.forEach((item) => {
      output += `### ${item.url}\n${item.markdown}\n\n---\n\n`;
    });
  }

  return output.trim();
}

// Output schemas for structured content
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

const server = new McpServer({ name: "markdown-for-agents-mcp", version });

server.registerTool(
  "fetch_url",
  {
    description:
      "Fetch a URL with full JavaScript rendering (Playwright/Chromium) and convert to clean markdown. " +
      "Works on React, Vue, Angular, and any JS-heavy page. " +
      "Strips navigation, ads, and boilerplate. Optimized for AI agent use.",
    inputSchema: {
      url: z.string().describe("The URL to fetch and convert to markdown"),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 30000)"),
    },
    outputSchema: fetchUrlOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ url, timeout }) => {
    try {
      const result = await fetchUrl({ url: String(url), timeout });
      return {
        content: [{ type: "text" as const, text: result.markdown }],
        structuredContent: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `# Error\n\n${errorMessage}\n` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "fetch_urls",
  {
    description:
      "Fetch multiple URLs with full JavaScript rendering and convert each to clean markdown. " +
      "Batch operation with configurable parallelism. Each result includes the URL, title, and markdown.",
    inputSchema: {
      urls: z.array(z.string()).describe("Array of URLs to fetch and convert"),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 30000)"),
    },
    outputSchema: fetchUrlsOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ urls, timeout }) => {
    try {
      const result = await fetchUrls({ urls: urls.map(String), timeout });
      const textParts = result.results.map(r => {
        if (!r.success) return `## URL: ${r.url}\n\n**Error:** ${r.error || 'Unknown error'}\n\n---`;
        return `${r.markdown}\n\n---`;
      });
      return {
        content: [{ type: "text" as const, text: textParts.join("\n\n") }],
        structuredContent: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `# Error\n\n${errorMessage}\n` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "health_check",
  {
    description:
      "Check the health status of the MCP server. Returns server status, cache statistics, " +
      "and fetch metrics to verify the server is operating correctly.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => {
    const health = Logger.getHealth();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }],
    };
  }
);

server.registerTool(
  "download_file",
  {
    description:
      "Download a binary file (PDF, image, ZIP, etc.) from a URL and save it to a local path. " +
      "Returns JSON metadata including the saved path, file size, MIME type, and filename. " +
      "SSRF protection and domain block list are enforced. Use fetch_url for web pages.",
    inputSchema: {
      url: z.string().describe("URL of the file to download"),
      outputPath: z.string().describe("Absolute local path to save the file to (parent directory must exist)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ url, outputPath }) => {
    const path = String(outputPath);
    if (!path.startsWith("/") && !(/^[A-Za-z]:[/\\]/.test(path))) {
      return {
        content: [{ type: "text" as const, text: "# Error\n\noutputPath must be an absolute path\n" }],
        isError: true,
      };
    }
    try {
      const result = await downloadFile(String(url), path);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `# Error\n\n${errorMessage}\n` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "web_search",
  {
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
  },
  async (args) => {
    try {
      const result = await webSearch({
        query: String(args.query),
        maxResults: args.maxResults,
        allowedDomains: args.allowedDomains,
        blockedDomains: args.blockedDomains,
        fetchResults: args.fetchResults,
        timeout: args.timeout,
      });
      return {
        content: [{ type: "text" as const, text: formatWebSearchText(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `# Error\n\n${errorMessage}\n` }],
        isError: true,
      };
    }
  }
);

/**
 * Start an HTTP server using StreamableHTTPServerTransport.
 * Supports optional bearer token auth via MCP_AUTH_TOKEN env var.
 * All MCP traffic is handled at POST|GET|DELETE /mcp.
 */
async function startHttpServer(mcpServer: McpServer, port: number): Promise<void> {
  const authToken = process.env['MCP_AUTH_TOKEN'];

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const httpServer = createServer(async (req, res) => {
    if (authToken) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await mcpServer.connect(transport);

  httpServer.listen(port, () => {
    Logger.info(`markdown-for-agents-mcp HTTP server listening on port ${port}`);
    console.error(`markdown-for-agents-mcp server running on HTTP port ${port}`);
  });

  process.on('SIGTERM', () => { httpServer.close(); });
}

async function main() {
  try {
    validateAndInitializeConfig();
    Logger.info("Configuration validated successfully");
  } catch (error) {
    console.error("Configuration error:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
  }

  // Detect HTTP mode: --http [port] flag or HTTP_PORT env var
  const httpArgIdx = process.argv.indexOf('--http');
  const httpPort = httpArgIdx !== -1
    ? (parseInt(process.argv[httpArgIdx + 1] ?? '', 10) || 3000)
    : (process.env['HTTP_PORT'] ? Number(process.env['HTTP_PORT']) : null);

  if (httpPort) {
    await startHttpServer(server, httpPort);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("markdown-for-agents-mcp server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
