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
}

export interface RenderTierImpl {
  readonly tier: RenderTier;
  isAvailable(): Promise<boolean>;
  render(req: RenderRequest): Promise<RenderResult>;
  warmup?(): Promise<void>;
  drain?(): Promise<void>;
}
