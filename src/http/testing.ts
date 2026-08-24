import fs from 'node:fs';
import type { HttpClient, HttpRequest, HttpResponse } from './types.js';
import { decodeBody } from './encoding.js';

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
  charset?: string;
  redirectChain?: string[];
  error?: Error;
}

type Handler = (req: HttpRequest) => FakeResponse | Promise<FakeResponse>;

export class FakeHttpClient implements HttpClient {
  private handlers: Map<string, Handler> = new Map();
  private defaultHandler?: Handler;
  readonly requests: HttpRequest[] = [];

  onUrl(url: string, response: FakeResponse | Handler): this {
    this.handlers.set(url, typeof response === 'function' ? response : () => response);
    return this;
  }

  onDefault(response: FakeResponse | Handler): this {
    this.defaultHandler = typeof response === 'function' ? response : () => response;
    return this;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const handler = this.handlers.get(req.url) ?? this.defaultHandler;
    if (!handler) throw new Error(`FakeHttpClient: no handler for ${req.url}`);
    const fake = await handler(req);
    if (fake.error) throw fake.error;
    const body = typeof fake.body === 'string' ? Buffer.from(fake.body, 'utf8') : (fake.body ?? Buffer.alloc(0));
    const charset = fake.charset ?? 'utf-8';
    return {
      url: fake.redirectChain?.at(-1) ?? req.url,
      status: fake.status,
      headers: fake.headers ?? {},
      body,
      charset,
      redirectChain: fake.redirectChain ?? [],
      attempts: 1,
      durationMs: 0,
      text() { return decodeBody(body, charset); },
    };
  }

  async download(
    req: HttpRequest,
    outputPath: string,
    maxBytes: number,
  ): Promise<{ url: string; status: number; headers: Record<string, string>; sizeBytes: number; redirectChain: string[]; attempts: number; durationMs: number }> {
    this.requests.push(req);
    const handler = this.handlers.get(req.url) ?? this.defaultHandler;
    if (!handler) throw new Error(`FakeHttpClient: no handler for ${req.url}`);
    const fake = await handler(req);
    if (fake.error) throw fake.error;
    if (fake.status < 200 || (fake.status >= 300 && fake.status < 400 && !fake.redirectChain)) {
      throw new Error(`HTTP ${fake.status} downloading ${req.url}`);
    }
    const body = typeof fake.body === 'string' ? Buffer.from(fake.body, 'utf8') : (fake.body ?? Buffer.alloc(0));
    if (body.length > maxBytes) throw new Error(`File too large: ${body.length} bytes (max ${maxBytes})`);
    await fs.promises.writeFile(outputPath, body);
    const finalUrl = fake.redirectChain?.at(-1) ?? req.url;
    return { url: finalUrl, status: fake.status, headers: fake.headers ?? {}, sizeBytes: body.length, redirectChain: fake.redirectChain ?? [], attempts: 1, durationMs: 0 };
  }

  async close(): Promise<void> {}
}
