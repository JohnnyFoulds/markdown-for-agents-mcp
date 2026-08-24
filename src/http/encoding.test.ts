import { describe, test, expect } from 'vitest';
import { detectCharset, decodeBody } from './encoding.js';

describe('detectCharset', () => {
  test('detects UTF-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]);
    expect(detectCharset(undefined, buf)).toBe('utf-8');
  });

  test('detects charset from Content-Type header', () => {
    expect(detectCharset('text/html; charset=windows-1251', Buffer.from('hello'))).toBe('windows-1251');
  });

  test('detects charset from meta tag in first 2 KB', () => {
    const html = '<html><head><meta charset="iso-8859-1"></head><body>hi</body></html>';
    expect(detectCharset(undefined, Buffer.from(html))).toBe('iso-8859-1');
  });

  test('falls back to provided fallback', () => {
    expect(detectCharset(undefined, Buffer.from('hello'), 'latin1')).toBe('latin1');
  });

  test('falls back to utf-8 by default', () => {
    expect(detectCharset(undefined, Buffer.from('hello'))).toBe('utf-8');
  });

  test('Content-Type takes priority over meta tag', () => {
    const html = '<meta charset="iso-8859-1">';
    expect(detectCharset('text/html; charset=utf-8', Buffer.from(html))).toBe('utf-8');
  });
});

describe('decodeBody', () => {
  test('decodes utf-8', () => {
    expect(decodeBody(Buffer.from('hello', 'utf8'), 'utf-8')).toBe('hello');
  });

  test('falls back to utf-8 on unknown charset', () => {
    expect(decodeBody(Buffer.from('hello'), 'not-a-real-charset')).toBe('hello');
  });

  test('decodes windows-1252 correctly', () => {
    // 0x80 in windows-1252 is € (euro sign)
    const buf = Buffer.from([0x80]);
    expect(decodeBody(buf, 'windows-1252')).toBe('€');
  });
});
