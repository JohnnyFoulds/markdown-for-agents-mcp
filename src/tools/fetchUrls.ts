import { fetcher } from "../fetcher.js";
import { extract } from "../extract/pipeline.js";
import { FetchUrlsResult } from "./types.js";

export interface FetchUrlsOptions {
  urls: string[];
  timeout?: number;
  headers?: Record<string, string>;
}

export async function fetchUrls(options: FetchUrlsOptions): Promise<FetchUrlsResult> {
  const { urls, timeout, headers } = options;
  const results = await fetcher.fetchMultiple(urls, timeout, headers);
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
    const { markdown, contentSize } = extract(result.markdown, { url: result.url, title: result.title });
    return {
      url: result.url,
      title: result.title,
      markdown,
      fetchedAt: now,
      contentSize,
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
