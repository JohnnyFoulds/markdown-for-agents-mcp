import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setReady, isReady, gracefulDrain } from './lifecycle.js';

beforeEach(() => setReady(false));

describe('setReady / isReady', () => {
  it('starts not ready', () => {
    expect(isReady()).toBe(false);
  });

  it('becomes ready after setReady(true)', () => {
    setReady(true);
    expect(isReady()).toBe(true);
  });

  it('becomes not ready after setReady(false)', () => {
    setReady(true);
    setReady(false);
    expect(isReady()).toBe(false);
  });
});

describe('gracefulDrain', () => {
  it('calls all drain hooks and exits', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });

    const closeStores = vi.fn().mockResolvedValue(undefined);
    const closeBrowserPool = vi.fn().mockResolvedValue(undefined);
    const closeReranker = vi.fn().mockResolvedValue(undefined);

    const httpServer = {
      close: vi.fn((cb?: () => void) => { cb?.(); }),
    } as unknown as import('node:http').Server;

    const workerAbort = new AbortController();

    await expect(gracefulDrain('SIGTERM', {
      httpServer,
      workerAbort,
      drainMs: 0,
      timeoutMs: 0,
      closeStores,
      closeBrowserPool,
      closeReranker,
    })).rejects.toThrow('process.exit called');

    expect(closeStores).toHaveBeenCalled();
    expect(closeBrowserPool).toHaveBeenCalled();
    expect(closeReranker).toHaveBeenCalled();
    expect(httpServer.close).toHaveBeenCalled();
    expect(workerAbort.signal.aborted).toBe(true);

    mockExit.mockRestore();
  });

  it('flips readyz to false during drain', async () => {
    setReady(true);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(gracefulDrain('SIGTERM', {
      drainMs: 0,
      timeoutMs: 0,
    })).rejects.toThrow('exit');

    expect(isReady()).toBe(false);
    mockExit.mockRestore();
  });
});
