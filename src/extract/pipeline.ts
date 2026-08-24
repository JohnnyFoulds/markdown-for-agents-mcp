import { convert as markdownify } from "markdown-for-agents";
import { applyIncludeSelector, applyExcludeSelectors, htmlToText } from './selector.js';

export type OutputFormat = 'markdown' | 'html' | 'text';

export interface ExtractOptions {
  url?: string;
  title?: string;
  stripImages?: boolean;
  preserveLinks?: boolean;
  outputFormat?: OutputFormat;
  includeSelector?: string;
  excludeSelectors?: string[];
  maxChars?: number;
  offset?: number;
}

export interface ExtractResult {
  markdown: string;
  title: string;
  contentSize: number;
  totalLength?: number;
  truncated?: boolean;
}

function truncateAtParagraph(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  // For markdown/text: split on double newlines and accumulate whole paragraphs
  const paragraphs = text.split(/\n\n/);
  let accumulated = '';
  for (const para of paragraphs) {
    const candidate = accumulated ? accumulated + '\n\n' + para : para;
    if (candidate.length > maxChars) break;
    accumulated = candidate;
  }

  // Fallback: hard slice if even the first paragraph is too long
  if (!accumulated) accumulated = text.slice(0, maxChars);
  return { text: accumulated, truncated: true };
}

export function extract(html: string, opts: ExtractOptions = {}): ExtractResult {
  const {
    url,
    title,
    stripImages,
    preserveLinks,
    outputFormat = 'markdown',
    includeSelector,
    excludeSelectors,
    maxChars,
    offset = 0,
  } = opts;

  // Apply CSS selector filtering on raw HTML
  let processedHtml = html;
  if (includeSelector) {
    processedHtml = applyIncludeSelector(processedHtml, includeSelector);
  }
  if (excludeSelectors?.length) {
    processedHtml = applyExcludeSelectors(processedHtml, excludeSelectors);
  }

  let content: string;

  if (outputFormat === 'html') {
    content = processedHtml;
  } else if (outputFormat === 'text') {
    content = htmlToText(processedHtml);
  } else {
    // markdown (default)
    const { markdown: body } = markdownify(processedHtml, {
      extract: true,
      ...(url ? { baseUrl: url } : {}),
      linkStyle: preserveLinks !== false ? "inlined" : "referenced",
      ...(stripImages ? { images: false } : {}),
    });

    const heading = title
      ? `# ${title}\n\nSource: ${url ?? ''}`
      : url
      ? `# ${url}`
      : '';

    content = heading
      ? `${heading}\n\n${body}\n\n---\n*Converted by markdown-for-agents-mcp*\n`
      : body;
  }

  const totalLength = content.length;

  // Apply offset + pagination
  let paged = content;
  if (offset > 0) {
    paged = content.slice(offset);
  }

  let truncated = false;
  if (maxChars !== undefined && paged.length > maxChars) {
    const result = truncateAtParagraph(paged, maxChars);
    paged = result.text;
    truncated = result.truncated;
  }

  return {
    markdown: paged,
    title: title ?? '',
    contentSize: Buffer.byteLength(paged, 'utf8'),
    totalLength,
    truncated,
  };
}
