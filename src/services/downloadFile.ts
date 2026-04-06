/**
 * Binary file download service
 * Downloads files from URLs and saves them to local disk
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config.js';
import { validateUrl } from '../utils/domainBlacklist.js';

export interface DownloadResult {
  savedPath: string;
  sizeBytes: number;
  mimeType: string;
  filename: string;
}

export type HttpGetFn = (
  url: string,
  timeoutMs: number
) => Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>;

/**
 * Perform a single HTTP/HTTPS GET request, returning status, headers, and body as a Buffer.
 * Does not follow redirects — that is handled by the caller.
 */
export function httpGet(
  url: string,
  timeoutMs: number
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; markdown-for-agents-mcp/1.0)',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Download timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

/**
 * Download a binary file from a URL and save it to the specified path.
 * Skips path-pattern blocklist checks so legitimate download URLs are not blocked,
 * but still enforces SSRF protection and domain blocklist.
 *
 * @param url           - The URL to download from
 * @param outputPath    - Absolute local path to write the file to (parent directory must exist)
 * @param _httpGet      - Optional HTTP getter override (for testing)
 * @param _skipValidate - Skip URL validation (for testing with 127.0.0.1 test servers)
 * @returns Metadata about the saved file
 */
export async function downloadFile(
  url: string,
  outputPath: string,
  _httpGet: HttpGetFn = httpGet,
  _skipValidate = false
): Promise<DownloadResult> {
  const config = getConfig();
  const maxRedirects = config.MAX_REDIRECTS;
  const timeoutMs = config.DOWNLOAD_TIMEOUT_MS;

  // Validate URL (skip path-pattern checks — /download/... etc. are legitimate for binary files)
  if (!_skipValidate) {
    const validation = validateUrl(url, { skipPathPatterns: true });
    if (!validation.valid) {
      throw new Error(validation.error);
    }
  }

  let currentUrl = url;
  let redirectCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await _httpGet(currentUrl, timeoutMs);

    // Handle redirects
    if (
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      response.headers['location']
    ) {
      if (redirectCount >= maxRedirects) {
        throw new Error(`Redirect limit exceeded (max ${maxRedirects})`);
      }
      const location = Array.isArray(response.headers['location'])
        ? response.headers['location'][0]
        : response.headers['location'];
      currentUrl = new URL(location!, currentUrl).toString();
      redirectCount++;
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode} error downloading ${currentUrl}`);
    }

    // Reject HTML responses — caller likely wants fetch_url instead
    const rawContentType = response.headers['content-type'];
    const contentType = (
      Array.isArray(rawContentType) ? rawContentType[0] : rawContentType ?? ''
    ).toLowerCase();

    if (contentType.startsWith('text/html')) {
      throw new Error(
        'URL returned HTML, not a binary file. Use fetch_url to fetch web pages as markdown.'
      );
    }

    const mimeType = contentType.split(';')[0].trim() || 'application/octet-stream';
    const sizeBytes = response.body.length;

    // Write to disk
    fs.writeFileSync(outputPath, response.body);

    // Extract filename from original URL
    const urlPathname = new URL(url).pathname;
    const filename = path.basename(urlPathname) || 'download';

    return {
      savedPath: outputPath,
      sizeBytes,
      mimeType,
      filename,
    };
  }
}
