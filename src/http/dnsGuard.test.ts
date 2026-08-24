import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock node:dns to return a controllable address
vi.mock('node:dns', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'node:dns';
import { registry } from '../obs/metrics.js';

async function getViolationCount(): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find(m => m.name === 'ssrf_violations_total');
  if (!metric) return 0;
  const values = (metric as { values: Array<{ labels: Record<string, string>; value: number }> }).values;
  const v = values.find(x => x.labels.stage === 'dns_guard');
  return v?.value ?? 0;
}

function mockResolve(address: string, family = 4): void {
  vi.mocked(dns.lookup).mockImplementation((_host, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    // The guard calls with { all: true } so returns an array
    (callback as (err: null, addrs: Array<{address: string; family: number}>, family: number) => void)(
      null, [{ address, family }], family
    );
  });
}

describe('dnsGuardLookup — ssrf_violations_total{stage="dns_guard"}', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('increments ssrf_violations_total when DNS resolves to private IPv4', async () => {
    mockResolve('10.0.0.1');
    const { dnsGuardLookup } = await import('./dnsGuard.js');
    const before = await getViolationCount();

    await new Promise<void>(resolve => {
      dnsGuardLookup('host.internal', { family: 4 }, () => resolve());
    });

    // RED: dnsGuard.ts does not call ssrfViolationsTotal.inc() — value stays at before
    const after = await getViolationCount();
    expect(after).toBe(before + 1);
  });

  test('does not increment metric when DNS resolves to a public IP', async () => {
    mockResolve('1.2.3.4');
    const { dnsGuardLookup } = await import('./dnsGuard.js');
    const before = await getViolationCount();

    await new Promise<void>(resolve => {
      dnsGuardLookup('safe.example.com', { family: 4 }, () => resolve());
    });

    const after = await getViolationCount();
    expect(after).toBe(before);
  });

  test('increments for link-local 169.254.x.x (metadata endpoint)', async () => {
    mockResolve('169.254.169.254');
    const { dnsGuardLookup } = await import('./dnsGuard.js');
    const before = await getViolationCount();

    await new Promise<void>(resolve => {
      dnsGuardLookup('metadata.internal', { family: 4 }, () => resolve());
    });

    const after = await getViolationCount();
    expect(after).toBe(before + 1);
  });
});
