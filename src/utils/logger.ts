/**
 * Logger utility for fetch performance metrics
 */

export interface FetchMetrics {
  url: string;
  duration: number;
  success: boolean;
  error?: string;
}

interface DomainMetrics {
  hostname: string;
  fetchCount: number;
  successCount: number;
  errorCount: number;
  totalDuration: number;
  cacheHits: number;
  cacheMisses: number;
}

interface CacheMetrics {
  hits: number;
  misses: number;
  currentSize: number;
  totalBytes: number;
  maxBytes: number;
}

export class Logger {
  private static metrics: FetchMetrics[] = [];
  private static domainMetrics: Map<string, DomainMetrics> = new Map();
  private static cacheMetrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    currentSize: 0,
    totalBytes: 0,
    maxBytes: 0,
  };

  static logFetch(metrics: FetchMetrics): void {
    this.metrics.push(metrics);

    // Track domain metrics
    try {
      const hostname = new URL(metrics.url).hostname;
      this.updateDomainMetrics(hostname, metrics);
    } catch {
      // Ignore URL parsing errors
    }

    if (process.env.DEBUG === 'true') {
      const status = metrics.success ? 'success' : `failed: ${metrics.error}`;
      console.error(`[Fetch] ${metrics.url} - ${metrics.duration}ms - ${status}`);
    }
  }

  static logCacheHit(hostname: string, size: number): void {
    this.cacheMetrics.hits++;
    this.updateDomainMetrics(hostname, {
      url: hostname,
      duration: 0,
      success: true,
    });
    this.domainMetrics.get(hostname)!.cacheHits++;

    if (process.env.DEBUG === 'true') {
      console.error(`[Cache] HIT ${hostname} - ${size} bytes`);
    }
  }

  static logCacheMiss(hostname: string): void {
    this.cacheMetrics.misses++;
    this.updateDomainMetrics(hostname, {
      url: hostname,
      duration: 0,
      success: true,
    });
    this.domainMetrics.get(hostname)!.cacheMisses++;

    if (process.env.DEBUG === 'true') {
      console.error(`[Cache] MISS ${hostname}`);
    }
  }

  static updateCacheStats(size: number, bytes: number, maxBytes: number): void {
    this.cacheMetrics.currentSize = size;
    this.cacheMetrics.totalBytes = bytes;
    this.cacheMetrics.maxBytes = maxBytes;
  }

  static getMetrics(): FetchMetrics[] {
    return this.metrics;
  }

  static getDomainMetrics(): Map<string, DomainMetrics> {
    return this.domainMetrics;
  }

  static getCacheMetrics(): CacheMetrics {
    return this.cacheMetrics;
  }

  static clearMetrics(): void {
    this.metrics = [];
    this.domainMetrics.clear();
    this.cacheMetrics = {
      hits: 0,
      misses: 0,
      currentSize: 0,
      totalBytes: 0,
      maxBytes: 0,
    };
  }

  static getSummary(): {
    totalFetches: number;
    successCount: number;
    errorCount: number;
    avgDuration: number;
    cacheHits: number;
    cacheMisses: number;
    cacheUtilization: number;
  } {
    const total = this.metrics.length;
    const success = this.metrics.filter(m => m.success).length;
    const errors = total - success;
    const avgDuration = total > 0 ? this.metrics.reduce((sum, m) => sum + m.duration, 0) / total : 0;

    return {
      totalFetches: total,
      successCount: success,
      errorCount: errors,
      avgDuration: Math.round(avgDuration * 100) / 100,
      cacheHits: this.cacheMetrics.hits,
      cacheMisses: this.cacheMetrics.misses,
      cacheUtilization: Math.round((this.cacheMetrics.hits / (this.cacheMetrics.hits + this.cacheMetrics.misses)) * 100) || 0,
    };
  }

  private static updateDomainMetrics(hostname: string, metrics: FetchMetrics): void {
    let domainMetric = this.domainMetrics.get(hostname);

    if (!domainMetric) {
      domainMetric = {
        hostname,
        fetchCount: 0,
        successCount: 0,
        errorCount: 0,
        totalDuration: 0,
        cacheHits: 0,
        cacheMisses: 0,
      };
      this.domainMetrics.set(hostname, domainMetric);
    }

    domainMetric.fetchCount++;
    domainMetric.totalDuration += metrics.duration;

    if (metrics.success) {
      domainMetric.successCount++;
    } else {
      domainMetric.errorCount++;
    }
  }
}
