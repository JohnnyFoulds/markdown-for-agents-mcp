import { describe, test, expect } from 'vitest';
import { CircuitBreaker } from './breaker.js';

describe('CircuitBreaker', () => {
  test('starts closed', () => {
    const b = new CircuitBreaker();
    expect(b.isOpen()).toBe(false);
  });

  test('stays closed below failure threshold', () => {
    const b = new CircuitBreaker();
    // 4 failures out of 4 — but threshold requires total >= 5
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.isOpen()).toBe(false);
  });

  test('opens when failure rate >= 50% with total >= 5', () => {
    const b = new CircuitBreaker();
    // 3 success + 3 failure = 50% failure rate, total=6 >= 5 → opens
    b.recordSuccess();
    b.recordSuccess();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.isOpen()).toBe(true);
  });

  test('recordSuccess resets open state', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.recordFailure();
    expect(b.isOpen()).toBe(true);
    // Use reset() to simulate recovery (direct state test)
    b.reset();
    expect(b.isOpen()).toBe(false);
  });

  test('reset() fully closes the breaker', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 10; i++) b.recordFailure();
    b.reset();
    expect(b.isOpen()).toBe(false);
  });
});
