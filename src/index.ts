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

// List available tools
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
          },
          required: ["urls"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "fetch_url") {
    if (!args || typeof args !== "object" || !("url" in args) || !args.url) {
      throw new Error("Missing required argument: url");
    }
    const result = await fetchUrl(String(args.url));
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
    const results = await fetchUrls(urls.map((u) => String(u)));
    return {
      content: [{ type: "text", text: results }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("markdown-for-agents-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
