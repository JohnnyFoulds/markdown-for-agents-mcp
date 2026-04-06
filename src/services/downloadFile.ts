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
        // Intentionally minimal UA — identifies the tool without browser impersonation
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; markdown-for-agents-mcp/1.0)' },
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

/** Options for downloadFile — fields prefixed with _ are test-only seams. */
export interface DownloadFileOptions {
  /** Override the HTTP client (inject a mock in tests). */
  _httpGet?: HttpGetFn;
  /** Skip URL validation so test servers on 127.0.0.1 are reachable. */
  _skipValidate?: boolean;
}

/**
 * Download a binary file from a URL and save it to the specified path.
 * Skips path-pattern checks (/download/... etc.) — legitimate for binary files —
 * but still enforces SSRF protection and the domain block list.
 *
 * @param url        - The URL to download from
 * @param outputPath - Absolute local path to write the file to (parent directory must exist)
 * @param options    - Optional overrides (mainly for testing)
 */
export async function downloadFile(
  url: string,
  outputPath: string,
  options: DownloadFileOptions = {}
): Promise<DownloadResult> {
  const { _httpGet = httpGet, _skipValidate = false } = options;
  const config = getConfig();
  const { MAX_REDIRECTS: maxRedirects, DOWNLOAD_TIMEOUT_MS: timeoutMs, MAX_DOWNLOAD_BYTES: maxBytes } = config;

  if (!_skipValidate) {
    const validation = validateUrl(url, { skipPathPatterns: true });
    if (!validation.valid) {
      throw new Error(validation.error);
    }
  }

  let currentUrl = url;
  for (let redirectCount = 0; redirectCount < maxRedirects; redirectCount++) {
    const response = await _httpGet(currentUrl, timeoutMs);

    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers['location']) {
      const location = Array.isArray(response.headers['location'])
        ? response.headers['location'][0]
        : response.headers['location'];
      currentUrl = new URL(location!, currentUrl).toString();
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode} error downloading ${currentUrl}`);
    }

    const rawContentType = response.headers['content-type'];
    const contentType = (
      Array.isArray(rawContentType) ? rawContentType[0] : rawContentType ?? ''
    ).toLowerCase();

    if (contentType.startsWith('text/html')) {
      throw new Error(
        'URL returned HTML, not a binary file. Use fetch_url to fetch web pages as markdown.'
      );
    }

    // Guard against unexpectedly large responses before writing to disk
    const contentLengthHeader = response.headers['content-length'];
    const declaredLength = parseInt(
      Array.isArray(contentLengthHeader) ? contentLengthHeader[0]! : (contentLengthHeader ?? ''),
      10
    );
    if (!isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`File too large: ${declaredLength} bytes (max ${maxBytes})`);
    }
    if (response.body.length > maxBytes) {
      throw new Error(`File too large: ${response.body.length} bytes (max ${maxBytes})`);
    }

    const mimeType = contentType.split(';')[0].trim() || 'application/octet-stream';
    await fs.promises.writeFile(outputPath, response.body);

    const filename = path.basename(new URL(currentUrl).pathname) || 'download';
    return { savedPath: outputPath, sizeBytes: response.body.length, mimeType, filename };
  }

  throw new Error(`Redirect limit exceeded (max ${maxRedirects})`);
}
