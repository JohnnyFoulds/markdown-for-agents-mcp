const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_reader', 'utm_name', 'utm_publ', 'utm_cid',
  'gclid', 'gclsrc', 'dclid',
  'fbclid', 'igshid',
  '_ga', '_gl', '_gid',
  'mc_cid', 'mc_eid',
  'ref', 'referrer',
  'source', 'via',
  'yclid', 'msclkid',
]);

export function canonicalizeUrl(raw: string): string {
  let resolved = raw;

  // Unwrap DDG redirect: ?uddg=<encoded-url>
  try {
    const u = new URL(raw);
    const uddg = u.searchParams.get('uddg');
    if (uddg) {
      resolved = decodeURIComponent(uddg.replace(/&amp;$/, ''));
    }
    // Unwrap Google /url?q=<url> redirects
    if ((u.hostname === 'www.google.com' || u.hostname === 'google.com') &&
        u.pathname === '/url') {
      const q = u.searchParams.get('q');
      if (q) resolved = q;
    }
  } catch {
    return raw;
  }

  try {
    const u = new URL(resolved);

    // Strip fragment
    u.hash = '';

    // Strip tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key)) u.searchParams.delete(key);
    }

    // Sort remaining params for stable keys
    u.searchParams.sort();

    // Normalize host: lowercase + strip leading www.
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const normalizedUrl = u.protocol + '//' + host + (u.port ? `:${u.port}` : '') +
      u.pathname.replace(/\/+$/, '') +
      (u.search || '');

    return normalizedUrl;
  } catch {
    return resolved;
  }
}

export function deduplicateByCanonical<T extends { url: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  return results.filter(r => {
    const key = canonicalizeUrl(r.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
