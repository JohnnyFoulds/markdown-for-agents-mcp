/**
 * downloadFile service unit tests.
 * All HTTP interactions are handled via FakeHttpClient — no real network calls.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { downloadFile } from './downloadFile.js';
import { FakeHttpClient } from '../http/testing.js';
import { initializeConfig, resetConfig } from '../config.js';

const BINARY_PAYLOAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

function tempFile(suffix = '.bin'): string {
  return path.join(os.tmpdir(), `dltest-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

function cleanup(...paths: string[]) {
  for (const p of paths) { if (fs.existsSync(p)) fs.unlinkSync(p); }
}

beforeEach(() => {
  resetConfig();
  initializeConfig({
    FETCH_TIMEOUT_MS: '30000',
    MAX_CONCURRENT_FETCHES: '5',
    MAX_REDIRECTS: '3',
    MAX_CONTENT_LENGTH: '100000',
    LOG_LEVEL: 'INFO',
    LOG_FORMAT: 'text',
    CACHE_MAX_BYTES: '52428800',
    CACHE_TTL_MS: '900000',
    USE_ALLOWLIST_MODE: 'false',
    WEB_SEARCH_DEFAULT_TIMEOUT_MS: '30000',
    DOWNLOAD_TIMEOUT_MS: '5000',
    MAX_DOWNLOAD_BYTES: '100000',
  });
});

afterEach(() => resetConfig());

describe('downloadFile', () => {
  test('downloads binary content and writes to outputPath', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/report.pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': String(BINARY_PAYLOAD.length) },
      body: BINARY_PAYLOAD,
    });
    const outputPath = tempFile('.pdf');
    try {
      const result = await downloadFile('https://example.com/report.pdf', outputPath, { _httpClient: client });
      expect(result.savedPath).toBe(outputPath);
      expect(result.sizeBytes).toBe(BINARY_PAYLOAD.length);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('report.pdf');
      expect(fs.readFileSync(outputPath)).toEqual(BINARY_PAYLOAD);
    } finally { cleanup(outputPath); }
  });

  test('extracts filename from URL path', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/images/logo.png', {
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const outputPath = tempFile('.png');
    try {
      const result = await downloadFile('https://example.com/images/logo.png', outputPath, { _httpClient: client });
      expect(result.filename).toBe('logo.png');
      expect(result.mimeType).toBe('image/png');
    } finally { cleanup(outputPath); }
  });

  test('falls back to "download" when URL has no filename', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: BINARY_PAYLOAD,
    });
    const outputPath = tempFile();
    try {
      const result = await downloadFile('https://example.com/', outputPath, { _httpClient: client });
      expect(result.filename).toBe('download');
    } finally { cleanup(outputPath); }
  });

  test('filename is taken from the final URL after redirect', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/redirect', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: BINARY_PAYLOAD,
      redirectChain: ['https://example.com/redirect', 'https://example.com/final/document.pdf'],
    });
    const outputPath = tempFile('.pdf');
    try {
      const result = await downloadFile('https://example.com/redirect', outputPath, { _httpClient: client });
      expect(result.filename).toBe('document.pdf');
    } finally { cleanup(outputPath); }
  });

  test('follows a single redirect (302 → 200)', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/original', {
      status: 200,
      headers: { 'content-type': 'application/zip' },
      body: BINARY_PAYLOAD,
      redirectChain: ['https://example.com/original', 'https://example.com/final'],
    });
    const outputPath = tempFile('.zip');
    try {
      const result = await downloadFile('https://example.com/original', outputPath, { _httpClient: client });
      expect(result.sizeBytes).toBe(BINARY_PAYLOAD.length);
      expect(result.mimeType).toBe('application/zip');
    } finally { cleanup(outputPath); }
  });

  test('throws when redirect limit is exceeded', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/loop', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: BINARY_PAYLOAD,
    });
    // Simulate redirect error from the client layer
    client.onUrl('https://example.com/loop', { status: 200, body: BINARY_PAYLOAD, headers: { 'content-type': 'application/pdf' }, error: new Error('Redirect limit exceeded (max 3)') });
    await expect(
      downloadFile('https://example.com/loop', tempFile(), { _httpClient: client })
    ).rejects.toThrow('Redirect limit exceeded');
  });

  test('rejects HTML content-type with helpful error', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/page', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from('<html><body>Login</body></html>'),
    });
    const outputPath = tempFile('.html');
    try {
      await expect(
        downloadFile('https://example.com/page', outputPath, { _httpClient: client })
      ).rejects.toThrow('URL returned HTML');
    } finally { cleanup(outputPath); }
  });

  test('throws on non-2xx HTTP status', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/missing', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('Not found'),
      error: new Error('HTTP 404 downloading https://example.com/missing'),
    });
    await expect(
      downloadFile('https://example.com/missing', tempFile(), { _httpClient: client })
    ).rejects.toThrow('HTTP 404');
  });

  test('rejects blocked domains — validateUrl fires before any network call', async () => {
    await expect(
      downloadFile('https://doubleclick.net/file.pdf', tempFile())
    ).rejects.toThrow('Domain blocked');
  });

  test('rejects private/loopback addresses (SSRF)', async () => {
    await expect(
      downloadFile('http://192.168.1.1/secret.pdf', tempFile())
    ).rejects.toThrow('SSRF');
  });

  test('rejects decimal-encoded IP (SSRF bypass)', async () => {
    await expect(
      downloadFile('http://2130706433/secret.pdf', tempFile())
    ).rejects.toThrow('SSRF');
  });

  test('rejects IPv6 ULA address (SSRF)', async () => {
    await expect(
      downloadFile('http://[fd00::1]/secret.pdf', tempFile())
    ).rejects.toThrow('SSRF');
  });

  test('rejects invalid URLs', async () => {
    await expect(downloadFile('not-a-url', tempFile())).rejects.toThrow();
  });

  test('allows /download/ paths (skipPathPatterns=true bypasses the path blocklist)', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/download/report.pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: BINARY_PAYLOAD,
    });
    const outputPath = tempFile('.pdf');
    try {
      const result = await downloadFile('https://example.com/download/report.pdf', outputPath, { _httpClient: client });
      expect(result.sizeBytes).toBe(BINARY_PAYLOAD.length);
    } finally { cleanup(outputPath); }
  });

  test('rejects when Content-Length header exceeds MAX_DOWNLOAD_BYTES', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/big.pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': '200000' },
      body: BINARY_PAYLOAD,
      error: new Error('File too large: 200000 bytes (max 100000)'),
    });
    await expect(
      downloadFile('https://example.com/big.pdf', tempFile(), { _httpClient: client })
    ).rejects.toThrow('File too large');
  });

  test('rejects when body size exceeds MAX_DOWNLOAD_BYTES (no Content-Length header)', async () => {
    const bigBody = Buffer.alloc(200000);
    const client = new FakeHttpClient().onUrl('https://example.com/big.pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: bigBody,
    });
    await expect(
      downloadFile('https://example.com/big.pdf', tempFile(), { _httpClient: client })
    ).rejects.toThrow('File too large');
  });

  test('rejects connection errors', async () => {
    const client = new FakeHttpClient().onUrl('https://example.com/file.pdf', {
      status: 0,
      error: new Error('ECONNREFUSED'),
    });
    await expect(
      downloadFile('https://example.com/file.pdf', tempFile(), { _httpClient: client })
    ).rejects.toThrow();
  });
});
