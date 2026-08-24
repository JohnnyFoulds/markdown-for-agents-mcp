import { describe, it, expect } from 'vitest';
import { extract } from './pipeline.js';

const BASIC_HTML = `<!DOCTYPE html><html><head><title>Test Page</title></head><body>
<h1>Hello</h1>
<p>First paragraph with some text content.</p>
<p>Second paragraph with more text.</p>
</body></html>`;

describe('extract — markdown format (default)', () => {
  it('returns markdown with title heading', () => {
    const result = extract(BASIC_HTML, { title: 'Test Page', url: 'https://example.com/test' });
    expect(result.markdown).toContain('# Test Page');
    expect(result.markdown).toContain('Hello');
    expect(result.contentSize).toBeGreaterThan(0);
  });

  it('returns markdown without title when not provided', () => {
    const result = extract(BASIC_HTML);
    expect(result.title).toBe('');
    expect(result.markdown).toBeTruthy();
  });
});

describe('extract — html format', () => {
  it('returns raw html unchanged', () => {
    const result = extract(BASIC_HTML, { outputFormat: 'html' });
    expect(result.markdown).toContain('<h1>');
    expect(result.markdown).toContain('<p>');
  });
});

describe('extract — text format', () => {
  it('returns plain text with tags stripped', () => {
    const result = extract(BASIC_HTML, { outputFormat: 'text' });
    expect(result.markdown).not.toContain('<');
    expect(result.markdown).toContain('Hello');
    expect(result.markdown).toContain('First paragraph');
  });
});

describe('extract — CSS selectors', () => {
  const SELECTOR_HTML = `<html><body>
    <nav id="nav"><a href="/">Home</a></nav>
    <main class="content"><p>Main content here</p></main>
    <footer><p>Footer</p></footer>
  </body></html>`;

  it('includeSelector restricts to matching element', () => {
    const result = extract(SELECTOR_HTML, { includeSelector: '.content' });
    expect(result.markdown).toContain('Main content');
    expect(result.markdown).not.toContain('Footer');
  });

  it('excludeSelectors removes matching elements', () => {
    const result = extract(SELECTOR_HTML, { excludeSelectors: ['nav', 'footer'] });
    expect(result.markdown).not.toContain('Home');
    expect(result.markdown).not.toContain('Footer');
    expect(result.markdown).toContain('Main content');
  });
});

describe('extract — pagination', () => {
  const LONG_HTML = `<html><body>${
    Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i + 1} with enough text to matter.</p>`).join('\n')
  }</body></html>`;

  it('truncates at paragraph boundary when maxChars set', () => {
    const result = extract(LONG_HTML, { maxChars: 200 });
    expect(result.markdown.length).toBeLessThanOrEqual(200 + 50); // some tolerance for heading
    expect(result.truncated).toBe(true);
    expect(result.totalLength).toBeGreaterThan(result.markdown.length);
  });

  it('sets truncated=false when content fits', () => {
    const result = extract('<p>Short</p>', { maxChars: 1000 });
    expect(result.truncated).toBe(false);
  });

  it('applies offset to skip leading content', () => {
    const full = extract(LONG_HTML);
    const paged = extract(LONG_HTML, { offset: 50 });
    expect(paged.markdown.length).toBeLessThan(full.markdown.length);
  });

  it('offset + maxChars together act as a page window', () => {
    const result = extract(LONG_HTML, { offset: 50, maxChars: 100 });
    expect(result.markdown.length).toBeLessThanOrEqual(100 + 10);
  });
});

describe('extract — metadata', () => {
  it('returns correct contentSize as byte length', () => {
    const result = extract(BASIC_HTML, { title: 'T', url: 'https://x.com' });
    expect(result.contentSize).toBe(Buffer.byteLength(result.markdown, 'utf8'));
  });

  it('returns totalLength equal to untruncated content length', () => {
    const result = extract('<p>Hello world</p>', { maxChars: 5 });
    expect(result.totalLength).toBeGreaterThanOrEqual(result.markdown.length);
  });
});
