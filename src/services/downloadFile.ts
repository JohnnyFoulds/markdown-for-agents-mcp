import path from 'path';
import { getConfig } from '../config.js';
import { validateUrl } from '../utils/domainBlacklist.js';
import { httpClient as defaultHttpClient } from '../http/client.js';
import type { HttpClient } from '../http/types.js';

export interface DownloadResult {
  savedPath: string;
  sizeBytes: number;
  mimeType: string;
  filename: string;
}

/** Options for downloadFile — fields prefixed with _ are test-only seams. */
export interface DownloadFileOptions {
  _httpClient?: HttpClient;
  _skipValidate?: boolean;
}

/**
 * Download a binary file from a URL and save it to the specified path.
 * Streams to disk so MAX_DOWNLOAD_BYTES is enforced before the full body is buffered.
 *
 * @param url        - The URL to download from
 * @param outputPath - Absolute local path to write the file to (parent directory must exist)
 * @param options    - Optional overrides (mainly for testing)
 */
export async function downloadFile(
  url: string,
  outputPath: string,
  options: DownloadFileOptions = {},
): Promise<DownloadResult> {
  const { _httpClient = defaultHttpClient, _skipValidate = false } = options;
  const config = getConfig();

  if (!_skipValidate) {
    const validation = validateUrl(url, { skipPathPatterns: true });
    if (!validation.valid) throw new Error(validation.error);
  }

  const result = await _httpClient.download(
    {
      url,
      purpose: 'download',
      timeoutMs: config.DOWNLOAD_TIMEOUT_MS,
      allowCrossHostRedirect: true,
    },
    outputPath,
    config.MAX_DOWNLOAD_BYTES,
  );

  const rawContentType = result.headers['content-type'] ?? '';
  const contentType = rawContentType.toLowerCase();

  if (contentType.startsWith('text/html')) {
    throw new Error('URL returned HTML, not a binary file. Use fetch_url to fetch web pages as markdown.');
  }

  const mimeType = (contentType.split(';')[0] ?? '').trim() || 'application/octet-stream';
  const filename = path.basename(new URL(result.url).pathname) || 'download';

  return { savedPath: outputPath, sizeBytes: result.sizeBytes, mimeType, filename };
}
