/**
 * Shared result types for MCP tool responses.
 * These types are returned by tool functions and used to populate
 * both the text content and structuredContent in MCP responses.
 */

export interface FetchUrlResult {
  [key: string]: unknown;
  url: string;
  title: string;
  markdown: string;
  fetchedAt: string;    // ISO 8601 timestamp
  contentSize: number;  // byte length of markdown
}

export interface FetchUrlsResultItem {
  [key: string]: unknown;
  url: string;
  title: string;
  markdown: string;
  fetchedAt: string;
  contentSize: number;
  success: boolean;
  error?: string;
}

export interface FetchUrlsResult {
  [key: string]: unknown;
  results: FetchUrlsResultItem[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };
}

export interface WebSearchResultItem {
  [key: string]: unknown;
  title: string;
  url: string;
  snippet: string;
  domain?: string;
}

export interface WebSearchResult {
  [key: string]: unknown;
  query: string;
  results: WebSearchResultItem[];
  fetchedContent?: Array<{ url: string; markdown: string }>;
  durationMs: number;
}
