import { duckDuckGoSearch, SearchOptions } from "../services/webSearch.js";
import { WebSearchResult } from "./types.js";

export async function webSearch(options: SearchOptions): Promise<WebSearchResult> {
  const { query, maxResults, allowedDomains, blockedDomains, fetchResults, timeout, searchDepth, chunksPerSource } = options;

  const response = await duckDuckGoSearch({
    query,
    maxResults: maxResults ?? 10,
    allowedDomains,
    blockedDomains,
    fetchResults,
    timeout,
    searchDepth,
    chunksPerSource,
  });

  return {
    query: response.query,
    results: response.results as WebSearchResult['results'],
    fetchedContent: response.markdownResults,
    durationMs: response.durationMs,
  };
}
