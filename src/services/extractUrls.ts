import { fetcher } from '../fetcher.js';
import { extract } from '../extract/pipeline.js';
import type { OutputFormat, ExtractOptions } from '../extract/pipeline.js';

export interface ExtractUrlsOptions {
  urls: string[];
  timeout?: number;
  outputFormat?: OutputFormat;
  includeSelector?: string;
  excludeSelectors?: string[];
  maxChars?: number;
  offset?: number;
}

export interface ExtractUrlResult {
  url: string;
  title: string;
  content: string;
  format: OutputFormat;
  totalLength: number;
  truncated: boolean;
  contentSize: number;
  success: boolean;
  error?: string;
  fetchedAt: string;
}

export interface ExtractUrlsResult {
  results: ExtractUrlResult[];
  summary: { total: number; succeeded: number; failed: number };
}

export async function extractUrls(options: ExtractUrlsOptions): Promise<ExtractUrlsResult> {
  const {
    urls,
    timeout,
    outputFormat = 'markdown',
    includeSelector,
    excludeSelectors,
    maxChars,
    offset,
  } = options;

  const fetchedPages = await fetcher.fetchMultiple(urls, timeout);

  const extractOpts: ExtractOptions = { outputFormat, includeSelector, excludeSelectors, maxChars, offset };

  const results: ExtractUrlResult[] = fetchedPages.map(page => {
    const fetchedAt = new Date().toISOString();

    if (!page.success) {
      return {
        url: page.url,
        title: '',
        content: '',
        format: outputFormat,
        totalLength: 0,
        truncated: false,
        contentSize: 0,
        success: false,
        error: page.error ?? 'Fetch failed',
        fetchedAt,
      };
    }

    try {
      const extracted = extract(page.markdown, { ...extractOpts, url: page.url, title: page.title ?? '' });
      return {
        url: page.url,
        title: extracted.title,
        content: extracted.markdown,
        format: outputFormat,
        totalLength: extracted.totalLength ?? extracted.contentSize,
        truncated: extracted.truncated ?? false,
        contentSize: extracted.contentSize,
        success: true,
        fetchedAt,
      };
    } catch (err) {
      return {
        url: page.url,
        title: '',
        content: '',
        format: outputFormat,
        totalLength: 0,
        truncated: false,
        contentSize: 0,
        success: false,
        error: err instanceof Error ? err.message : 'Extraction failed',
        fetchedAt,
      };
    }
  });

  const succeeded = results.filter(r => r.success).length;
  return {
    results,
    summary: { total: results.length, succeeded, failed: results.length - succeeded },
  };
}
