export type RenderTier = 'http' | 'lightpanda' | 'playwright';

export const TIER_ORDER: RenderTier[] = ['http', 'lightpanda', 'playwright'];

export type ResourceType = 'image' | 'stylesheet' | 'font' | 'media' | 'script';

export interface RenderRequest {
  url: string;
  timeoutMs: number;
  minTier?: RenderTier;
  maxTier?: RenderTier;
  blockResources?: ResourceType[];
  screenshot?: boolean;
  requestId?: string;
  /** Extra HTTP headers forwarded verbatim to every request for this page (auth, cookies, etc.). */
  headers?: Record<string, string>;
}

export interface EscalationRecord {
  from: RenderTier;
  to: RenderTier;
  reason: string;
}

export interface RenderResult {
  url: string;
  html: string;
  title: string;
  status: number;
  tier: RenderTier;
  escalations: EscalationRecord[];
  screenshotPng?: Buffer;
  durationMs: number;
  /**
   * Response headers from the HTTP request.  Populated by each tier so that
   * the render ladder can pass them to needsEscalation() for header-based
   * bot-challenge detection (cf-mitigated, x-datadome-request, etc.).
   * Absent only for tiers that cannot surface headers (e.g. screenshot-only).
   */
  headers?: Record<string, string>;
}

export interface RenderTierImpl {
  readonly tier: RenderTier;
  isAvailable(): Promise<boolean>;
  render(req: RenderRequest): Promise<RenderResult>;
  warmup?(): Promise<void>;
  drain?(): Promise<void>;
}
