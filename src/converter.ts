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

  convert(html: string): string {
    const result = markdownify(html, {
      // Extract main content, stripping nav, footer, ads, etc.
      extract: true,

      // Preserve links for reference
      linkStyle: this.options.preserveLinks ? "inlined" : "referenced",
    });

    return typeof result === "string" ? result : result.markdown;
  }

  convertWithMetadata(html: string, url: string): string {
    const markdown = this.convert(html);

    return `# ${url}

${markdown}

---
*Converted by markdown-for-agents-mcp*
`;
  }
}

export const converter = new Converter();
