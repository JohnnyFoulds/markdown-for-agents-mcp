/**
 * Fetch URL Tool
 * Fetches a single URL and converts to markdown
 */

import { fetcher } from "../fetcher.js";
import { converter } from "../converter.js";
import { FetchUrlResult } from "./types.js";

export interface FetchUrlOptions {
  url: string;
  timeout?: number;
}

export async function fetchUrl(options: FetchUrlOptions): Promise<FetchUrlResult> {
  const { url, timeout } = options;

  // Fetch HTML with JavaScript rendering
  const pageResult = await fetcher.fetch(url, timeout);

  // Convert to markdown using page title when available
  const markdown = converter.convertWithMetadata(pageResult.html, url, pageResult.title);

  return {
    url,
    title: pageResult.title,
    markdown,
    fetchedAt: new Date().toISOString(),
    contentSize: Buffer.byteLength(markdown, 'utf8'),
  };
}
