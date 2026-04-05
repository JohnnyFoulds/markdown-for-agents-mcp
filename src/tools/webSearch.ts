/**
 * Web Search Tool
 * Searches DuckDuckGo and optionally fetches results to markdown
 */

import { duckDuckGoSearch, SearchResponse } from "../services/webSearch.js";

export interface WebSearchOptions {
  query: string;
  maxResults?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  fetchResults?: boolean;
  timeout?: number;
}

/**
 * Format search results as structured markdown
 */
function formatSearchResults(
  response: SearchResponse
): string {
  const { query, results, markdownResults, durationMs } = response;

  let output = `# Web Search Results

## Query: ${query}
**Found ${results.length} results in ${durationMs}ms**

### Results:

`;

  // Format structured results
  results.forEach((result, index) => {
    output += `${index + 1}. [${result.title}](${result.url})\n`;
    if (result.snippet) {
      output += `   ${result.snippet}\n`;
    }
    output += `\n`;
  });

  // Format fetched content if available (hybrid mode)
  if (markdownResults && markdownResults.length > 0) {
    output += `---

## Fetched Content:

`;

    markdownResults.forEach((item) => {
      output += `### ${item.url}
${item.markdown}

---

`;
    });
  }

  return output.trim();
}

/**
 * Web search tool that queries DuckDuckGo and optionally fetches results
 */
export async function webSearch(
  options: WebSearchOptions
): Promise<string> {
  const { query, maxResults, allowedDomains, blockedDomains, fetchResults, timeout } = options;

  try {
    const response = await duckDuckGoSearch({
      query,
      maxResults: maxResults ?? 10,
      allowedDomains,
      blockedDomains,
      fetchResults: fetchResults ?? false,
      timeout,
    });

    return formatSearchResults(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return `# Web Search Error

Failed to perform search: ${errorMessage}
`;
  }
}
