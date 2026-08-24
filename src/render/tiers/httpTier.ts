import { httpClient } from '../../http/client.js';
import type { HttpClient } from '../../http/types.js';
import type { RenderTierImpl, RenderRequest, RenderResult } from '../types.js';

export class HttpTier implements RenderTierImpl {
  readonly tier = 'http' as const;

  constructor(private readonly client: HttpClient = httpClient) {}

  async isAvailable(): Promise<boolean> { return true; }

  async render(req: RenderRequest): Promise<RenderResult> {
    const start = Date.now();
    const res = await this.client.request({
      url: req.url,
      purpose: 'page',
      timeoutMs: req.timeoutMs,
      requestId: req.requestId,
      ...(req.headers ? { headers: req.headers } : {}),
    });

    return {
      url: res.url,
      html: res.text(),
      title: '',
      status: res.status,
      tier: 'http',
      escalations: [],
      durationMs: Date.now() - start,
    };
  }
}
