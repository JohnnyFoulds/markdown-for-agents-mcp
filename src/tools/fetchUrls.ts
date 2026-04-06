/**
 * Fetch URLs Tool
 * Fetches multiple URLs and converts each to markdown
 */

import { fetcher } from "../fetcher.js";
import { converter } from "../converter.js";

export interface FetchUrlsOptions {
  urls: string[];
  timeout?: number;
}

export async function fetchUrls(options: FetchUrlsOptions): Promise<string> {
  const { urls, timeout } = options;
  const results = await fetcher.fetchMultiple(urls, timeout);

  const output: string[] = [];

  for (const result of results) {
    output.push(`## URL: ${result.url}`);

    if (!result.success) {
      output.push(`**Error:** ${result.error || "Unknown error"}`);
    } else {
      output.push(converter.convertWithMetadata(result.markdown, result.url));
    }

    output.push("---");
  }

  return output.join("\n\n");
}
