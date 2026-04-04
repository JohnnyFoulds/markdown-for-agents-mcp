/**
 * Logger utility for fetch performance metrics
 */

export interface FetchMetrics {
  url: string;
  duration: number;
  success: boolean;
  error?: string;
}

export class Logger {
  private static metrics: FetchMetrics[] = [];

  static logFetch(metrics: FetchMetrics): void {
    this.metrics.push(metrics);
    if (process.env.DEBUG === 'true') {
      console.error(
        `[Fetch] ${metrics.url} - ${metrics.duration}ms - ${
          metrics.success ? 'success' : `failed: ${metrics.error}`
        }`
      );
    }
  }

  static getMetrics(): FetchMetrics[] {
    return this.metrics;
  }

  static clearMetrics(): void {
    this.metrics = [];
  }
}
