import fs from 'node:fs';
import zlib from 'node:zlib';
import { Agent, ProxyAgent, request as undiciRequest } from 'undici';
import type { Dispatcher } from 'undici';
import { getConfig } from '../config.js';
import { validateUrl } from '../utils/domainBlacklist.js';
import { DomainBlockedError } from '../utils/errors.js';
import type { HttpClient, HttpRequest, HttpResponse } from './types.js';
import { generateBrowserUA, BROWSER_HEADERS, CRAWLER_UA } from './fingerprint.js';
import { shouldRetry, computeBackoff, parseRetryAfter } from './retry.js';
import { detectCharset, decodeBody } from './encoding.js';
import { resolveRedirectUrl, assertRedirectPermitted, checkRedirectLimit } from './redirect.js';
import { resolveProxy } from './proxy.js';
import { dnsGuardLookup } from './dnsGuard.js';
import { RateLimiter } from './rateLimiter.js';
import { assertRobotsAllowed } from './robots.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

function buildAgent(proxyUrl?: string): Dispatcher {
  const connectOpts = { lookup: dnsGuardLookup };
  if (proxyUrl) {
    return new ProxyAgent({ uri: proxyUrl, connect: connectOpts });
  }
  return new Agent({ connect: connectOpts });
}

function purposeHeaders(purpose: HttpRequest['purpose'], ua: string): Record<string, string> {
  if (purpose === 'page' || purpose === 'search') {
    return { 'User-Agent': ua, ...BROWSER_HEADERS };
  }
  return { 'User-Agent': CRAWLER_UA };
}

function makeResponse(
  url: string,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  charset: string,
  redirectChain: string[],
  attempts: number,
  durationMs: number,
): HttpResponse {
  return {
    url, status, headers, body, charset, redirectChain, attempts, durationMs,
    text() { return decodeBody(body, charset); },
  };
}

class UndiciHttpClient implements HttpClient {
  private dispatcher: Dispatcher;
  private rateLimiter: RateLimiter;
  private readonly ua = generateBrowserUA();

  constructor() {
    const proxy = resolveProxy();
    this.dispatcher = buildAgent(proxy?.url);
    const cfg = this.cfg();
    this.rateLimiter = new RateLimiter(
      cfg.RATE_LIMIT_PER_HOST_RPS,
      cfg.RATE_LIMIT_BURST,
      cfg.RATE_LIMIT_MAX_WAIT_MS,
    );
  }

  private cfg() {
    try { return getConfig(); } catch {
      return {
        RATE_LIMIT_PER_HOST_RPS: 0, RATE_LIMIT_BURST: 10, RATE_LIMIT_MAX_WAIT_MS: 30_000,
        MAX_REDIRECTS: 10, RESPECT_ROBOTS_TXT: false, HTTP_DEFAULT_CHARSET: 'utf-8',
      };
    }
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const cfg = this.cfg();
    const maxAttempts = req.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseDelay = req.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxRedirects = req.maxRedirects ?? cfg.MAX_REDIRECTS;
    const allowCrossHost = req.allowCrossHostRedirect ?? false;

    if (!req.skipRobots && cfg.RESPECT_ROBOTS_TXT) {
      const delay = await assertRobotsAllowed(req.url, this, cfg.RESPECT_ROBOTS_TXT);
      if (delay !== undefined) this.rateLimiter.setCrawlDelay(new URL(req.url).hostname, delay);
    }

    const startTime = Date.now();
    let currentUrl = req.url;
    const redirectChain: string[] = [];
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const validation = validateUrl(currentUrl, { skipPathPatterns: req.purpose === 'download' });
        if (!validation.valid) throw new DomainBlockedError(new URL(currentUrl).hostname);

        if (!req.skipRateLimit) {
          await this.rateLimiter.take(new URL(currentUrl).hostname);
        }

        const headers: Record<string, string> = {
          ...purposeHeaders(req.purpose, this.ua),
          ...(req.headers ?? {}),
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await undiciRequest(currentUrl, {
          method: req.method ?? 'GET',
          headers,
          body: req.body,
          dispatcher: this.dispatcher,
          headersTimeout: req.timeoutMs ?? 30_000,
          bodyTimeout: req.timeoutMs ?? 30_000,
        } as any);

        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') respHeaders[k] = v;
          else if (Array.isArray(v)) respHeaders[k] = v[0] ?? '';
        }

        // Manual redirect handling so we can enforce same-host policy
        if (res.statusCode >= 300 && res.statusCode < 400 && respHeaders['location']) {
          await res.body.dump();
          checkRedirectLimit(redirectChain.length, maxRedirects);
          const next = resolveRedirectUrl(respHeaders['location'], currentUrl);
          assertRedirectPermitted(currentUrl, next, allowCrossHost);
          redirectChain.push(currentUrl);
          currentUrl = next;
          attempts = 0; // reset for the new URL
          continue;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of res.body) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        let body = Buffer.concat(chunks);

        // Decompress
        const enc = respHeaders['content-encoding'] ?? '';
        try {
          if (enc === 'gzip') body = zlib.gunzipSync(body);
          else if (enc === 'br') body = zlib.brotliDecompressSync(body);
          else if (enc === 'deflate') body = zlib.inflateSync(body);
        } catch { /* leave body as-is */ }

        const charset = detectCharset(respHeaders['content-type'], body, cfg.HTTP_DEFAULT_CHARSET);
        const durationMs = Date.now() - startTime;
        return makeResponse(currentUrl, res.statusCode, respHeaders, body, charset, redirectChain, attempts, durationMs);

      } catch (err) {
        const retryAfter = parseRetryAfter(undefined);
        if (attempts >= maxAttempts || !shouldRetry(err)) throw err;
        const delay = computeBackoff(attempts, baseDelay, retryAfter);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error(`Exhausted ${maxAttempts} attempts for ${req.url}`);
  }

  async download(
    req: HttpRequest,
    outputPath: string,
    maxBytes: number,
  ): Promise<{ url: string; status: number; headers: Record<string, string>; sizeBytes: number; redirectChain: string[]; attempts: number; durationMs: number }> {
    const cfg = this.cfg();
    const maxRedirects = req.maxRedirects ?? cfg.MAX_REDIRECTS;
    const allowCrossHost = req.allowCrossHostRedirect ?? false;

    const startTime = Date.now();
    let currentUrl = req.url;
    const redirectChain: string[] = [];
    let attempts = 0;

    while (attempts < 3) {
      attempts++;
      try {
        const validation = validateUrl(currentUrl, { skipPathPatterns: true });
        if (!validation.valid) throw new DomainBlockedError(new URL(currentUrl).hostname);

        const headers: Record<string, string> = {
          'User-Agent': CRAWLER_UA,
          ...(req.headers ?? {}),
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await undiciRequest(currentUrl, {
          method: 'GET',
          headers,
          dispatcher: this.dispatcher,
          headersTimeout: req.timeoutMs ?? 60_000,
          bodyTimeout: req.timeoutMs ?? 60_000,
        } as any);

        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') respHeaders[k] = v;
          else if (Array.isArray(v)) respHeaders[k] = v[0] ?? '';
        }

        if (res.statusCode >= 300 && res.statusCode < 400 && respHeaders['location']) {
          await res.body.dump();
          checkRedirectLimit(redirectChain.length, maxRedirects);
          const next = resolveRedirectUrl(respHeaders['location'], currentUrl);
          assertRedirectPermitted(currentUrl, next, allowCrossHost);
          redirectChain.push(currentUrl);
          currentUrl = next;
          attempts = 0;
          continue;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          await res.body.dump();
          throw new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`);
        }

        // Check declared Content-Length before streaming
        const declaredLen = parseInt(respHeaders['content-length'] ?? '', 10);
        if (!isNaN(declaredLen) && declaredLen > maxBytes) {
          await res.body.dump();
          throw new Error(`File too large: ${declaredLen} bytes (max ${maxBytes})`);
        }

        let sizeBytes = 0;
        const out = fs.createWriteStream(outputPath);
        await new Promise<void>((resolve, reject) => {
          out.on('error', reject);
          (async () => {
            try {
              for await (const chunk of res.body) {
                const buf = Buffer.from(chunk as Uint8Array);
                sizeBytes += buf.length;
                if (sizeBytes > maxBytes) {
                  out.destroy();
                  reject(new Error(`File too large: exceeded ${maxBytes} bytes`));
                  return;
                }
                out.write(buf);
              }
              out.end();
              out.once('finish', resolve);
            } catch (e) { reject(e); }
          })();
        });

        return { url: currentUrl, status: res.statusCode, headers: respHeaders, sizeBytes, redirectChain, attempts, durationMs: Date.now() - startTime };
      } catch (err) {
        if (attempts >= 3 || !shouldRetry(err)) throw err;
        await new Promise(r => setTimeout(r, computeBackoff(attempts, 500)));
      }
    }
    throw new Error(`Exhausted download attempts for ${req.url}`);
  }

  setRateLimitStore(store: import('../store/types.js').RateLimitStore): void {
    this.rateLimiter.setStore(store);
  }

  async close(): Promise<void> {
    await (this.dispatcher as Agent).close?.();
  }
}

export const httpClient = new UndiciHttpClient();
