import { convert as markdownify } from "markdown-for-agents";

export interface ExtractOptions {
  url?: string;
  title?: string;
  stripImages?: boolean;
  preserveLinks?: boolean;
}

export interface ExtractResult {
  markdown: string;
  title: string;
  contentSize: number;
}

/**
 * Convert raw HTML to clean, token-efficient markdown.
 *
 * Pure host-side function — no browser required. Used by all render tiers
 * so extraction behaviour is identical regardless of how the HTML was obtained.
 * Passing `url` also fixes broken relative links (live quality bug in the
 * old browser-side path that never set baseUrl).
 */
export function extract(html: string, opts: ExtractOptions = {}): ExtractResult {
  const { markdown: body } = markdownify(html, {
    extract: true,
    ...(opts.url ? { baseUrl: opts.url } : {}),
    linkStyle: opts.preserveLinks !== false ? "inlined" : "referenced",
    ...(opts.stripImages ? { images: false } : {}),
  });

  const heading = opts.title
    ? `# ${opts.title}\n\nSource: ${opts.url ?? ''}`
    : opts.url
    ? `# ${opts.url}`
    : '';

  const fullMarkdown = heading
    ? `${heading}\n\n${body}\n\n---\n*Converted by markdown-for-agents-mcp*\n`
    : body;

  return {
    markdown: fullMarkdown,
    title: opts.title ?? '',
    contentSize: Buffer.byteLength(fullMarkdown, 'utf8'),
  };
}
