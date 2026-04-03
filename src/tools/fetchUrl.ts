/**
 * Fetch URL Tool
 * Fetches a single URL and converts to markdown
 */

import { fetcher } from "../fetcher.js";
import { converter } from "../converter.js";

export async function fetchUrl(url: string): Promise<string> {
  try {
    // Fetch HTML with JavaScript rendering
    const html = await fetcher.fetch(url);

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
