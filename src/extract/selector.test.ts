import { describe, it, expect } from 'vitest';
import { applyIncludeSelector, applyExcludeSelectors, htmlToText } from './selector.js';

const SIMPLE_HTML = `<html><body>
  <nav id="nav"><a href="/">Home</a></nav>
  <main class="content"><p>Hello world</p><p>Second paragraph</p></main>
  <footer class="footer"><p>Footer text</p></footer>
</body></html>`;

describe('applyIncludeSelector', () => {
  it('extracts element by tag', () => {
    const result = applyIncludeSelector('<div><main><p>content</p></main><footer>f</footer></div>', 'main');
    expect(result).toContain('content');
    expect(result).not.toContain('footer');
  });

  it('extracts element by #id', () => {
    const result = applyIncludeSelector(SIMPLE_HTML, '#nav');
    expect(result).toContain('Home');
    expect(result).not.toContain('Hello world');
  });

  it('extracts element by .class', () => {
    const result = applyIncludeSelector(SIMPLE_HTML, '.content');
    expect(result).toContain('Hello world');
    expect(result).not.toContain('Footer text');
  });

  it('returns full html for complex selectors', () => {
    const result = applyIncludeSelector(SIMPLE_HTML, 'main > p');
    expect(result).toBe(SIMPLE_HTML);
  });

  it('returns full html when selector not found', () => {
    const result = applyIncludeSelector(SIMPLE_HTML, '#nonexistent');
    expect(result).toBe(SIMPLE_HTML);
  });

  it('handles nested tags correctly', () => {
    const html = '<div id="outer"><div><span>inner</span></div><p>after</p></div>';
    const result = applyIncludeSelector(html, '#outer');
    expect(result).toBe(html);
  });
});

describe('applyExcludeSelectors', () => {
  it('removes elements by tag', () => {
    const result = applyExcludeSelectors(SIMPLE_HTML, ['nav', 'footer']);
    expect(result).not.toContain('Home');
    expect(result).not.toContain('Footer text');
    expect(result).toContain('Hello world');
  });

  it('removes elements by #id', () => {
    const result = applyExcludeSelectors(SIMPLE_HTML, ['#nav']);
    expect(result).not.toContain('Home');
    expect(result).toContain('Hello world');
  });

  it('removes elements by .class', () => {
    const result = applyExcludeSelectors(SIMPLE_HTML, ['.footer']);
    expect(result).not.toContain('Footer text');
    expect(result).toContain('Hello world');
  });

  it('skips complex selectors silently', () => {
    const result = applyExcludeSelectors(SIMPLE_HTML, ['nav > a']);
    expect(result).toBe(SIMPLE_HTML);
  });

  it('handles multiple removes', () => {
    const html = '<p class="a">A</p><p class="a">B</p><span>C</span>';
    const result = applyExcludeSelectors(html, ['.a']);
    expect(result).not.toContain('class="a"');
    expect(result).toContain('C');
  });
});

describe('htmlToText', () => {
  it('strips html tags', () => {
    const result = htmlToText('<p>Hello <b>world</b></p>');
    expect(result).not.toContain('<');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('strips script and style content', () => {
    const result = htmlToText('<p>text</p><script>var x = 1;</script><style>.a{color:red}</style>');
    expect(result).not.toContain('var x');
    expect(result).not.toContain('color:red');
    expect(result).toContain('text');
  });

  it('decodes common html entities', () => {
    const result = htmlToText('<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>');
    expect(result).toContain('&');
    expect(result).toContain('<');
    expect(result).toContain('>');
    expect(result).toContain('"');
    expect(result).toContain("'");
  });

  it('collapses whitespace', () => {
    const result = htmlToText('<p>  hello   world  </p>');
    expect(result).toBe('hello world');
  });
});
