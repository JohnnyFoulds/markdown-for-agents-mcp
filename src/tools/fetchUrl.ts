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

  // Fetch HTML with JavaScript rendering
  const html = await fetcher.fetch(url, timeout);

  // Convert to markdown
  return converter.convertWithMetadata(html, url);
}
