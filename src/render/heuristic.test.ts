import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { needsEscalation } from './heuristic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

const EMPTY_HEADERS: Record<string, string> = {};

describe('needsEscalation — fixture tests', () => {
  test('static article: no escalation', () => {
    const html = fixture('static-article.html');
    const { escalate, score } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(false);
    expect(score).toBeLessThan(0);  // rich-content weight drives it negative
  });

  test('Next.js app shell: escalate to lightpanda', () => {
    const html = fixture('next-app-shell.html');
    const { escalate, targetTier, reasons } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(targetTier).toBe('lightpanda');
    expect(reasons).toContain('spa-payload');
  });

  test('Cloudflare challenge: escalate straight to playwright', () => {
    const html = fixture('cf-challenge.html');
    const { escalate, targetTier, reasons } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(targetTier).toBe('playwright');
    expect(reasons).toContain('bot-challenge');
  });

  test('empty root div (CRA): escalate', () => {
    const html = fixture('empty-root-div.html');
    const { escalate, targetTier, reasons } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(targetTier).toBe('lightpanda');
    expect(reasons).toContain('noscript-warning');
  });
});

describe('needsEscalation — inline cases', () => {
  test('403 status: bot challenge → playwright', () => {
    const { escalate, targetTier } = needsEscalation('<html></html>', 403, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(targetTier).toBe('playwright');
  });

  test('429 status: bot challenge → playwright', () => {
    const { escalate, targetTier } = needsEscalation('<html></html>', 429, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(targetTier).toBe('playwright');
  });

  test('cf-mitigated header → playwright', () => {
    const html = '<html><body>hello world</body></html>';
    const { escalate, targetTier } = needsEscalation(html, 200, { 'cf-mitigated': 'challenge' });
    expect(escalate).toBe(true);
    expect(targetTier).toBe('playwright');
  });

  test('non-HTML content-type: never escalate', () => {
    const { escalate } = needsEscalation('{"key":"val"}', 200, { 'content-type': 'application/json' });
    expect(escalate).toBe(false);
  });

  test('empty body: escalates', () => {
    const { escalate, reasons } = needsEscalation('<html><head></head><body></body></html>', 200, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(reasons).toContain('near-empty-body');
  });

  test('__NEXT_DATA__ in body: escalates', () => {
    const html = '<html><body><script id="__NEXT_DATA__">{}</script></body></html>';
    const { escalate, reasons } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(reasons).toContain('spa-payload');
  });

  test('window.__NUXT__ in body: escalates', () => {
    const html = '<html><body><script>window.__NUXT__={}</script></body></html>';
    const { escalate, reasons } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(reasons).toContain('spa-payload');
  });

  test('noscript requires JavaScript: escalates', () => {
    const html = '<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>';
    const { escalate, reasons } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(true);
    expect(reasons).toContain('noscript-warning');
  });

  test('rich paragraph content: does not escalate', () => {
    const longText = 'This is a long paragraph with substantial content. '.repeat(30);
    const html = `<html><body>
      <p>${longText}</p>
      <p>${longText}</p>
      <p>${longText}</p>
    </body></html>`;
    const { escalate, reasons } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(false);
    expect(reasons).toContain('rich-static-content');
  });

  test('200 with enough text: no escalation', () => {
    const html = '<html><body><p>' + 'word '.repeat(200) + '</p></body></html>';
    const { escalate } = needsEscalation(html, 200, EMPTY_HEADERS);
    expect(escalate).toBe(false);
  });
});
