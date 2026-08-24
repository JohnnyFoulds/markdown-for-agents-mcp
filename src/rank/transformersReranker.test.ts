import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// RED today: rerankWorker.ts sends { type: 'error', message: '...' } but
//            transformersReranker.ts reads msg.error — field name mismatch
//            means every init failure surfaces as Error('undefined').
//            Fix: change 'message' → 'error' in rerankWorker.ts init().catch().
describe('rerankWorker — error field name contract (Phase 2 fix)', () => {
  it('init error response uses "error" field (not "message")', () => {
    const src = readFileSync(join(__dirname, 'rerankWorker.ts'), 'utf8');
    expect(src).toContain("type: 'error', error:");
    expect(src).not.toContain("type: 'error', message:");
  });
});
