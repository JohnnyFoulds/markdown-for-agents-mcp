/**
 * Fetch URLs Tool
 * Fetches multiple URLs and converts each to markdown
 */

import { fetcher } from "../fetcher.js";

export interface FetchUrlsOptions {
  urls: string[];
  timeout?: number;
}

export async function fetchUrls(options: FetchUrlsOptions): Promise<string> {
  const { urls, timeout } = options;
  try {
    const results = await fetcher.fetchMultiple(urls, timeout);

    const output: string[] = [];

    for (const result of results) {
      output.push(`## URL: ${result.url}`);

      if (!result.success) {
        output.push(`**Error:** ${result.error || "Unknown error"}`);
      } else {
        output.push(result.markdown);
      }

      output.push("---");
    }

    return output.join("\n\n");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return `# Error fetching URLs

Failed to fetch URLs: ${errorMessage}
`;
  }
}
