/**
 * Fetch URL Tool
 * Fetches a single URL and converts to markdown
 */

import { fetcher } from "../fetcher.js";
import { converter } from "../converter.js";

export interface FetchUrlOptions {
  url: string;
  timeout?: number;
}

export async function fetchUrl(options: FetchUrlOptions): Promise<string> {
  const { url, timeout } = options;

  try {
    // Fetch HTML with JavaScript rendering
    const html = await fetcher.fetch(url, timeout);

    // Convert to markdown
    const markdown = converter.convertWithMetadata(html, url);

    return markdown;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return `# Error fetching ${url}

Failed to fetch URL: ${errorMessage}
`;
  }
}
