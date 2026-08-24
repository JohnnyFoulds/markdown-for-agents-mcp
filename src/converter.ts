/**
 * HTML to Markdown Converter
 * Uses markdown-for-agents for clean, token-efficient output
 */

import { convert as markdownify } from "markdown-for-agents";

interface ConvertOptions {
  stripImages?: boolean;
  preserveLinks?: boolean;
}

export class Converter {
  private options: ConvertOptions;

  constructor(options: ConvertOptions = {}) {
    this.options = {
      stripImages: false,
      preserveLinks: true,
      ...options,
    };
  }

  /**
   * Convert an HTML string to clean markdown.
   * Applies content extraction to strip nav, footer, ads, and boilerplate.
   * @param html - Raw HTML to convert
   * @returns Markdown string
   */
  convert(html: string): string {
    const result = markdownify(html, {
      // Extract main content, stripping nav, footer, ads, etc.
      extract: true,

      // Preserve links for reference
      linkStyle: this.options.preserveLinks ? "inlined" : "referenced",

      // Strip images when configured
      ...(this.options.stripImages ? { images: false } : {}),
    });

    return typeof result === "string" ? result : result.markdown;
  }

  /**
   * Convert an HTML string to markdown and prepend a heading.
   * When a page title is available it is used as the heading; otherwise the URL is used.
   * @param html - Raw HTML to convert
   * @param url - Source URL (always included as a "Source:" line when a title is present)
   * @param title - Optional page title extracted from document.title
   * @returns Markdown string with heading and attribution footer
   */
  convertWithMetadata(html: string, url: string, title?: string): string {
    const markdown = this.convert(html);
    const heading = title ? `# ${title}\n\nSource: ${url}` : `# ${url}`;

    return `${heading}

${markdown}

---
*Converted by markdown-for-agents-mcp*
`;
  }
}

export const converter = new Converter();
