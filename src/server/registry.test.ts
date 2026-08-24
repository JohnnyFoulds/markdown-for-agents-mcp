import { describe, it, expect } from 'vitest';
import { TOOLS } from '../tools/definitions.js';

describe('TOOLS registry invariants', () => {
  it('every tool has a non-empty name', () => {
    TOOLS.forEach(def => {
      expect(def.name.length).toBeGreaterThan(0);
    });
  });

  it('every tool has a non-empty description', () => {
    TOOLS.forEach(def => {
      expect(def.description.length).toBeGreaterThan(0);
    });
  });

  it('every tool has a non-empty outputSchema', () => {
    TOOLS.forEach(def => {
      expect(def.outputSchema).toBeDefined();
      expect(Object.keys(def.outputSchema).length).toBeGreaterThan(0);
    });
  });

  it('every tool has a toText function', () => {
    TOOLS.forEach(def => {
      expect(typeof def.toText).toBe('function');
    });
  });

  it('tool names are unique', () => {
    const names = TOOLS.map(d => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains all expected tools', () => {
    const names = new Set(TOOLS.map(d => d.name));
    for (const expected of [
      'fetch_url', 'fetch_urls', 'web_search', 'health_check', 'download_file',
      'extract_urls', 'map_site',
      'crawl_site', 'crawl_start', 'crawl_status', 'crawl_results', 'crawl_cancel', 'crawl_list',
    ]) {
      expect(names.has(expected), `tool ${expected} missing`).toBe(true);
    }
  });
});
