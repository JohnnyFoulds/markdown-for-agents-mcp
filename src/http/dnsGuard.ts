import dns from 'node:dns';
import { isPrivateIp } from '../utils/domainBlacklist.js';
import { SsrfViolationError } from '../utils/errors.js';
import { ssrfViolationsTotal } from '../obs/metrics.js';

export type LookupFn = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

export const dnsGuardLookup: LookupFn = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const addrs = Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }];
    for (const { address } of addrs) {
      if (isPrivateIp(address)) {
        ssrfViolationsTotal.labels({ stage: 'dns_guard' }).inc();
        return callback(new SsrfViolationError(hostname, address) as NodeJS.ErrnoException, '', 4);
      }
    }
    const first = addrs[0]!;
    callback(null, first.address, first.family as number);
  });
};

export async function guardDns(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return reject(err);
      const addrs = Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string }];
      for (const { address } of addrs) {
        if (isPrivateIp(address)) {
          ssrfViolationsTotal.labels({ stage: 'dns_guard' }).inc();
          return reject(new SsrfViolationError(hostname, address));
        }
      }
      resolve(addrs.map(a => a.address));
    });
  });
}
