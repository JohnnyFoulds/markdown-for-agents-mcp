/**
 * Fetch URLs Tool
 * Fetches multiple URLs and converts each to markdown
 */

import { fetcher } from "../fetcher.js";
import { converter } from "../converter.js";
import { FetchUrlsResult } from "./types.js";

export interface FetchUrlsOptions {
  urls: string[];
  timeout?: number;
}

export async function fetchUrls(options: FetchUrlsOptions): Promise<FetchUrlsResult> {
  const { urls, timeout } = options;
  const results = await fetcher.fetchMultiple(urls, timeout);
  const now = new Date().toISOString();

  const items = results.map(result => {
    if (!result.success) {
      return {
        url: result.url,
        title: '',
        markdown: '',
        fetchedAt: now,
        contentSize: 0,
        success: false as const,
        error: result.error || 'Unknown error',
      };
    }
    const markdown = converter.convertWithMetadata(result.markdown, result.url, result.title);
    return {
      url: result.url,
      title: result.title,
      markdown,
      fetchedAt: now,
      contentSize: Buffer.byteLength(markdown, 'utf8'),
      success: true as const,
    };
  });

  return {
    results: items,
    summary: {
      total: items.length,
      succeeded: items.filter(r => r.success).length,
      failed: items.filter(r => !r.success).length,
    },
  };
}
