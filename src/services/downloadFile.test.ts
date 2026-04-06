/**
 * downloadFile service unit tests
 * Uses real http.createServer on random ports to avoid flaky port conflicts.
 * SSRF protection blocks 127.0.0.1, so tests that hit real local servers pass
 * _skipValidate=true and inject the real httpGet.
 * Tests for SSRF/domain validation use the default path (no injection).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { downloadFile, httpGet, HttpGetFn } from './downloadFile.js';
import { initializeConfig, resetConfig } from '../config.js';

// Minimal PDF-like binary payload (not a real PDF, just recognisable bytes)
const BINARY_PAYLOAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

function tempFile(suffix = '.bin'): string {
  return path.join(os.tmpdir(), `dltest-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
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
  });
});

afterEach(() => {
  resetConfig();
});

describe('downloadFile', () => {
  test('downloads binary content and writes to outputPath', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(BINARY_PAYLOAD.length),
      });
      res.end(BINARY_PAYLOAD);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const outputPath = tempFile('.pdf');

    try {
      const result = await downloadFile(
        `http://127.0.0.1:${port}/report.pdf`,
        outputPath,
        httpGet,
        true // skip SSRF validation for test server
      );
      expect(result.savedPath).toBe(outputPath);
      expect(result.sizeBytes).toBe(BINARY_PAYLOAD.length);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('report.pdf');
      const written = fs.readFileSync(outputPath);
      expect(written).toEqual(BINARY_PAYLOAD);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  });

  test('extracts filename from URL path', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const outputPath = tempFile('.png');

    try {
      const result = await downloadFile(
        `http://127.0.0.1:${port}/images/logo.png`,
        outputPath,
        httpGet,
        true
      );
      expect(result.filename).toBe('logo.png');
      expect(result.mimeType).toBe('image/png');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  });

  test('falls back to "download" when URL has no filename', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(BINARY_PAYLOAD);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const outputPath = tempFile();

    try {
      const result = await downloadFile(
        `http://127.0.0.1:${port}/`,
        outputPath,
        httpGet,
        true
      );
      expect(result.filename).toBe('download');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  });

  test('follows a single redirect (302 → 200)', async () => {
    let port: number;
    const server = createServer((req, res) => {
      if (req.url === '/original') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/final` });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(BINARY_PAYLOAD);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    const outputPath = tempFile('.zip');

    try {
      const result = await downloadFile(
        `http://127.0.0.1:${port}/original`,
        outputPath,
        httpGet,
        true
      );
      expect(result.sizeBytes).toBe(BINARY_PAYLOAD.length);
      expect(result.mimeType).toBe('application/zip');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  });

  test('throws when redirect limit is exceeded', async () => {
    let port: number;
    const server = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/loop` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    const outputPath = tempFile();

    try {
      await expect(
        downloadFile(`http://127.0.0.1:${port}/loop`, outputPath, httpGet, true)
      ).rejects.toThrow('Redirect limit exceeded');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('rejects HTML content-type with helpful error', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>Login wall</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const outputPath = tempFile('.html');

    try {
      await expect(
        downloadFile(`http://127.0.0.1:${port}/page`, outputPath, httpGet, true)
      ).rejects.toThrow('URL returned HTML');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('throws on non-2xx HTTP status', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const outputPath = tempFile();

    try {
      await expect(
        downloadFile(`http://127.0.0.1:${port}/missing`, outputPath, httpGet, true)
      ).rejects.toThrow('HTTP 404');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('rejects blocked domains — validateUrl fires before any network call', async () => {
    const outputPath = tempFile();
    // doubleclick.net is in DEFAULT_BLOCKLIST
    await expect(
      downloadFile('https://doubleclick.net/file.pdf', outputPath)
    ).rejects.toThrow('Domain blocked');
  });

  test('rejects private/loopback addresses (SSRF)', async () => {
    const outputPath = tempFile();
    // 192.168.1.1 is RFC1918 — blocked by validateUrl before any network call
    await expect(
      downloadFile('http://192.168.1.1/secret.pdf', outputPath)
    ).rejects.toThrow('SSRF');
  });

  test('rejects invalid URLs', async () => {
    const outputPath = tempFile();
    await expect(downloadFile('not-a-url', outputPath)).rejects.toThrow();
  });

  test('allows /download/ paths (skipPathPatterns=true bypasses the path blocklist)', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(BINARY_PAYLOAD);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const outputPath = tempFile('.pdf');

    try {
      const result = await downloadFile(
        `http://127.0.0.1:${port}/download/report.pdf`,
        outputPath,
        httpGet,
        true
      );
      expect(result.sizeBytes).toBe(BINARY_PAYLOAD.length);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  });

  test('uses injected mock httpGet for full control over response', async () => {
    const outputPath = tempFile('.pdf');
    const mockGet: HttpGetFn = async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/pdf' },
      body: BINARY_PAYLOAD,
    });

    // Public URL so validateUrl passes normally (no SSRF skip needed)
    const result = await downloadFile('https://example.com/doc.pdf', outputPath, mockGet);
    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(BINARY_PAYLOAD.length);
    expect(result.filename).toBe('doc.pdf');

    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  });

  test('rejects connection errors', async () => {
    // Port 1 should never be open; _skipValidate so SSRF doesn't fire first
    await expect(
      downloadFile('http://127.0.0.1:1/file.pdf', tempFile(), httpGet, true)
    ).rejects.toThrow();
  });
});
