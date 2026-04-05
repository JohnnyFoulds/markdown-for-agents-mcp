import { describe, test, expect, beforeEach } from 'vitest';
import { Converter } from './converter.js';

describe('Converter', () => {
  let converter: Converter;

  beforeEach(() => {
    converter = new Converter();
  });

  describe('convert', () => {
    test('converts h1 tag to markdown header', () => {
      const html = '<h1>Test Title</h1>';
      const result = converter.convert(html);
      expect(result).toContain('# Test Title');
    });

    test('converts h2 tag to markdown header', () => {
      const html = '<h2>Subsection</h2>';
      const result = converter.convert(html);
      expect(result).toContain('## Subsection');
    });

    test('converts p tags to paragraphs', () => {
      const html = '<p>This is a paragraph.</p>';
      const result = converter.convert(html);
      expect(result).toContain('This is a paragraph.');
    });

    test('converts ul to bullet lists', () => {
      const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
      const result = converter.convert(html);
      expect(result).toContain('- Item 1');
      expect(result).toContain('- Item 2');
    });

    test('converts a tags to markdown links', () => {
      const html = '<a href="https://example.com">Link Text</a>';
      const result = converter.convert(html);
      expect(result).toContain('[Link Text](https://example.com)');
    });

    test('converts strong tags to bold', () => {
      const html = '<strong>Bold text</strong>';
      const result = converter.convert(html);
      expect(result).toContain('**Bold text**');
    });

    test('converts em tags to italic', () => {
      const html = '<em>Italic text</em>';
      const result = converter.convert(html);
      expect(result).toContain('*Italic text*');
    });

    test('handles empty HTML', () => {
      const html = '';
      const result = converter.convert(html);
      // markdown-for-agents returns a newline for empty input
      expect(result).toBe('\n');
    });

    test('converts img tags to markdown', () => {
      const html = '<img src="test.jpg" alt="Test image">';
      const result = converter.convert(html);
      expect(result).toContain('![Test image](test.jpg)');
    });
  });

  describe('convertWithMetadata', () => {
    test('includes URL as title', () => {
      const html = '<h1>Article</h1>';
      const url = 'https://example.com/article';
      const result = converter.convertWithMetadata(html, url);
      expect(result).toContain(`# ${url}`);
    });

    test('includes converted markdown content', () => {
      const html = '<p>Main content</p>';
      const url = 'https://example.com';
      const result = converter.convertWithMetadata(html, url);
      expect(result).toContain('Main content');
    });

    test('includes footer metadata', () => {
      const html = '<p>Content</p>';
      const url = 'https://example.com';
      const result = converter.convertWithMetadata(html, url);
      expect(result).toContain('*Converted by markdown-for-agents-mcp*');
    });

    test('includes separator before footer', () => {
      const html = '<p>Content</p>';
      const url = 'https://example.com';
      const result = converter.convertWithMetadata(html, url);
      expect(result).toContain('---');
    });
  });
});
