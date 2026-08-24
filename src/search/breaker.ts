const WINDOW = 20;
const OPEN_THRESHOLD = 0.5;
const COOLDOWN_MS = 60_000;
const HALF_OPEN_MAX = 1;

export class CircuitBreaker {
  private failures = 0;
  private total = 0;
  private openUntil = 0;
  private halfOpenInflight = 0;

  isOpen(): boolean {
    if (Date.now() < this.openUntil) return true;
    if (this.openUntil > 0) {
      // Half-open: allow one probe
      if (this.halfOpenInflight >= HALF_OPEN_MAX) return true;
      this.halfOpenInflight++;
    }
    return false;
  }

  recordSuccess(): void {
    this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
    this.openUntil = 0;
    this.total++;
    this.age();
  }

  recordFailure(): void {
    this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
    this.failures++;
    this.total++;
    this.age();
    if (this.total >= 5 && this.failures / this.total >= OPEN_THRESHOLD) {
      this.openUntil = Date.now() + COOLDOWN_MS;
    }
  }

  private age(): void {
    if (this.total > WINDOW) {
      this.failures = Math.floor(this.failures / 2);
      this.total = Math.floor(this.total / 2);
    }
  }

  reset(): void {
    this.failures = 0;
    this.total = 0;
    this.openUntil = 0;
    this.halfOpenInflight = 0;
  }
}
