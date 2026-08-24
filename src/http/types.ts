export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  skipRateLimit?: boolean;
  skipRobots?: boolean;
  maxRedirects?: number;
  allowCrossHostRedirect?: boolean;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  purpose: 'page' | 'search' | 'download' | 'robots' | 'api';
  requestId?: string;
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  charset: string;
  redirectChain: string[];
  attempts: number;
  durationMs: number;
  text(): string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  download(
    req: HttpRequest,
    outputPath: string,
    maxBytes: number,
  ): Promise<{ url: string; status: number; headers: Record<string, string>; sizeBytes: number; redirectChain: string[]; attempts: number; durationMs: number }>;
  close(): Promise<void>;
}
