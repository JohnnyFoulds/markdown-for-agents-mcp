/**
 * HTML to Markdown Converter
 * Uses markdown-for-agents for clean, token-efficient output
 */

import { markdownify } from "markdown-for-agents";

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
      // Strip images for token efficiency (AI agents don't need image content)
      strip: this.options.stripImages ? ["img"] : [],

      // Preserve links for reference
      linkStyle: this.options.preserveLinks ? "inlined" : "none",

      // Use bullet points for lists
      bulletListMarker: "-",

      // Remove unnecessary whitespace
      trim: true,

      // Convert headers to markdown headers
      defaultHeaderLevel: 1,
    });

    return result;
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
