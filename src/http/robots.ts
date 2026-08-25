import { createRequire } from 'module';
import { LRUCache } from '../utils/cache.js';

const _require = createRequire(import.meta.url);
type RobotsInstance = {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
};
const robotsParser = _require('robots-parser') as (url: string, txt: string) => RobotsInstance;
import { RobotsDeniedError } from '../utils/errors.js';
import type { HttpClient } from './types.js';
import { robotsDeniedTotal } from '../obs/metrics.js';
import { getConfig } from '../config.js';

const CACHE = new LRUCache<string>({ maxBytes: 4 * 1024 * 1024, ttl: 60 * 60 * 1000 });

const UA = 'markdown-for-agents-mcp';

export async function fetchRobotsTxt(origin: string, client: HttpClient): Promise<string | null> {
  const robotsUrl = `${origin}/robots.txt`;
  const cached = CACHE.get(robotsUrl);
  if (cached !== undefined) return cached;

  try {
    const res = await client.request({
      url: robotsUrl,
      purpose: 'robots',
      skipRobots: true,
      skipRateLimit: true,
      retry: { maxAttempts: 1 },
    });
    // 4xx → allow (no robots.txt)
    if (res.status >= 400 && res.status < 500) {
      CACHE.set(robotsUrl, '', 0);
      return '';
    }
    if (res.status >= 200 && res.status < 300) {
      const txt = res.text();
      CACHE.set(robotsUrl, txt, Buffer.byteLength(txt, 'utf8'));
      return txt;
    }
    // 5xx / other → honour ROBOTS_ON_ERROR (RFC 9309 §2.3.1.4: SHOULD disallow when unreachable)
    let onError = 'allow';
    try { onError = getConfig().ROBOTS_ON_ERROR; } catch { /* config not yet initialised */ }
    // deny: return a disallow-all synthetic robots.txt so the caller blocks the fetch
    return onError === 'deny' ? 'User-agent: *\nDisallow: /\n' : null;
  } catch {
    return null;
  }
}

export async function assertRobotsAllowed(
  url: string,
  client: HttpClient,
  respectRobots: boolean,
): Promise<number | undefined> {
  if (!respectRobots) return undefined;

  const parsed = new URL(url);
  const origin = parsed.origin;
  const txt = await fetchRobotsTxt(origin, client);
  if (txt === null || txt === '') return undefined;

  const robots = robotsParser(`${origin}/robots.txt`, txt);
  if (robots.isDisallowed(url, UA)) {
    robotsDeniedTotal.inc();
    throw new RobotsDeniedError(url);
  }

  const delay = robots.getCrawlDelay(UA) ?? robots.getCrawlDelay('*');
  return delay;
}
