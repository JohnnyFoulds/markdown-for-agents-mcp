declare module 'readability' {
  export interface ArticleResult {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
    lang: string;
  }

  export class Readability {
    constructor(document: Document, options?: unknown);
    parse(): ArticleResult | null;
  }

  export { Readability as default };
}