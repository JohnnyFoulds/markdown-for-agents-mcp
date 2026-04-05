import { duckDuckGoSearch, SearchResponse, SearchOptions } from "../services/webSearch.js";

function formatSearchResults(
  response: SearchResponse
): string {
  const { query, results, markdownResults, durationMs } = response;

  let output = `# Web Search Results

## Query: ${query}
**Found ${results.length} results in ${durationMs}ms**

### Results:

`;

  results.forEach((result, index) => {
    output += `${index + 1}. [${result.title}](${result.url})\n`;
    if (result.snippet) {
      output += `   ${result.snippet}\n`;
    }
    output += `\n`;
  });

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

export async function webSearch(options: SearchOptions): Promise<string> {
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
    return `# Web Search Error

Failed to perform search: ${error instanceof Error ? error.message : "Unknown error"}
`;
  }
}
