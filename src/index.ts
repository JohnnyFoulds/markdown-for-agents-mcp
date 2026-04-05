#!/usr/bin/env node
/**
 * markdown-for-agents-mcp
 * MCP server for AI agents - fetch URLs and convert to clean markdown
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchUrl } from "./tools/fetchUrl.js";
import { fetchUrls } from "./tools/fetchUrls.js";
import { webSearch } from "./tools/webSearch.js";
import { fetcher } from "./fetcher.js";
import { Logger } from "./utils/logger.js";
import { validateAndInitializeConfig } from "./config.js";

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

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const server = new Server(
  {
    name: "markdown-for-agents-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "fetch_url",
        description:
          "Fetch a URL with JavaScript rendering and convert to clean markdown. " +
          "Strips navigation, ads, and boilerplate content. Optimized for AI agent use.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch and convert to markdown",
            },
            timeout: {
              type: "number",
              description: "Request timeout in milliseconds (default: 30000)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "fetch_urls",
        description:
          "Fetch multiple URLs with JavaScript rendering and convert each to clean markdown. " +
          "Batch operation for efficiency. Each result includes the URL and corresponding markdown.",
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Array of URLs to fetch and convert",
            },
            timeout: {
              type: "number",
              description: "Request timeout in milliseconds (default: 30000)",
            },
          },
          required: ["urls"],
        },
      },
      {
        name: "health_check",
        description:
          "Check the health status of the MCP server. Returns server status, cache statistics, " +
          "and fetch metrics to verify the server is operating correctly.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "web_search",
        description:
          "Search the web using DuckDuckGo and optionally fetch results to markdown. " +
          "Returns structured search results with title, URL, and snippet. " +
          "Supports domain filtering via allowedDomains and blockedDomains.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query to perform",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of search results to return (default: 10)",
            },
            allowedDomains: {
              type: "array",
              items: { type: "string" },
              description: "Only include results from these domains",
            },
            blockedDomains: {
              type: "array",
              items: { type: "string" },
              description: "Exclude results from these domains",
            },
            fetchResults: {
              type: "boolean",
              description: "Fetch and convert top results to markdown (hybrid mode)",
            },
            timeout: {
              type: "number",
              description: "Request timeout in milliseconds (default: 30000)",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "fetch_url") {
    if (!args || typeof args !== "object" || !("url" in args) || !args.url) {
      throw new Error("Missing required argument: url");
    }
    const timeoutArg = args.timeout;
    const timeout =
      timeoutArg !== undefined && typeof timeoutArg === "number"
        ? timeoutArg
        : undefined;
    const result = await fetchUrl({ url: String(args.url), timeout });
    return {
      content: [{ type: "text", text: result }],
    };
  }

  if (name === "fetch_urls") {
    if (!args || typeof args !== "object" || !("urls" in args)) {
      throw new Error("Missing required argument: urls (array)");
    }
    const urls = args.urls;
    if (!Array.isArray(urls)) {
      throw new Error("Missing required argument: urls (array)");
    }
    const timeoutArg = args.timeout;
    const timeout =
      timeoutArg !== undefined && typeof timeoutArg === "number"
        ? timeoutArg
        : undefined;
    const results = await fetchUrls({
      urls: urls.map((u) => String(u)),
      timeout,
    });
    return {
      content: [{ type: "text", text: results }],
    };
  }

  if (name === "health_check") {
    const health = Logger.getHealth();
    return {
      content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
    };
  }

  if (name === "web_search") {
    if (!args || typeof args !== "object" || !("query" in args) || !args.query) {
      throw new Error("Missing required argument: query");
    }
    const result = await webSearch({
      query: String(args.query),
      maxResults:
        args.maxResults !== undefined ? Number(args.maxResults) : undefined,
      allowedDomains: Array.isArray(args.allowedDomains) ? args.allowedDomains : undefined,
      blockedDomains: Array.isArray(args.blockedDomains) ? args.blockedDomains : undefined,
      fetchResults: args.fetchResults !== undefined ? !!args.fetchResults : undefined,
      timeout:
        args.timeout !== undefined ? Number(args.timeout) : undefined,
    });
    return {
      content: [{ type: "text", text: result }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  try {
    validateAndInitializeConfig();
    Logger.info("Configuration validated successfully");
  } catch (error) {
    console.error("Configuration error:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("markdown-for-agents-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
