/**
 * Logger utility for fetch performance metrics
 */

import { getConfig } from '../config.js';

/**
 * Log levels for structured logging
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

function getLogLevel(): LogLevel {
  try {
    const config = getConfig();
    const levelKey = config.LOG_LEVEL as keyof typeof LogLevel;
    const levelValue = LogLevel[levelKey];
    // For numeric enums, string key lookup returns the numeric value (e.g., LogLevel['DEBUG'] === 0)
    return typeof levelValue === 'number' ? levelValue : LogLevel.INFO;
  } catch {
    return LogLevel.INFO;
  }
}

function getLogFormat(): 'text' | 'json' {
  try {
    const config = getConfig();
    return config.LOG_FORMAT === 'json' ? 'json' : 'text';
  } catch {
    return 'text';
  }
}

function formatTextEntry(level: LogLevel, message: string, _data?: object, requestId?: string): string {
  const timestamp = new Date().toISOString();
  const levelName = LogLevel[level];
  const prefix = `[${timestamp}] [${levelName}]`;

  if (requestId) {
    return `${prefix} [${requestId}] ${message}`;
  }

  return `${prefix} ${message}`;
}

function formatJsonEntry(level: LogLevel, message: string, data?: object, requestId?: string): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: LogLevel[level],
    message,
  };

  if (requestId) {
    entry.requestId = requestId;
  }

  if (data) {
    entry.data = data;
  }

  return JSON.stringify(entry);
}

export interface FetchMetrics {
  url: string;
  duration: number;
  success: boolean;
  error?: string;
  requestId?: string;
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
  private static readonly MAX_METRICS = 1000;
  private static metrics: FetchMetrics[] = [];
  private static domainMetrics: Map<string, DomainMetrics> = new Map();
  private static cacheMetrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    currentSize: 0,
    totalBytes: 0,
    maxBytes: 0,
  };

  static log(level: LogLevel, message: string, data?: object, requestId?: string): void {
    const logLevel = getLogLevel();
    if (level < logLevel) return;

    const format = getLogFormat();
    const entry = format === 'json'
      ? formatJsonEntry(level, message, data, requestId)
      : formatTextEntry(level, message, data, requestId);

    console.error(entry);
  }

  static debug(message: string, data?: object, requestId?: string): void {
    this.log(LogLevel.DEBUG, message, data, requestId);
  }

  static info(message: string, data?: object, requestId?: string): void {
    this.log(LogLevel.INFO, message, data, requestId);
  }

  static warn(message: string, data?: object, requestId?: string): void {
    this.log(LogLevel.WARN, message, data, requestId);
  }

  static error(message: string, data?: object, requestId?: string): void {
    this.log(LogLevel.ERROR, message, data, requestId);
  }

  static generateRequestId(): string {
    return crypto.randomUUID();
  }

  /**
   * Log a fetch operation with metrics
   */
  static logFetch(metrics: FetchMetrics): void {
  if (this.metrics.length >= this.MAX_METRICS) {
    this.metrics = this.metrics.slice(-Math.floor(this.MAX_METRICS / 2));
  }
  this.metrics.push(metrics);

  try {
    const hostname = new URL(metrics.url).hostname;
    this.updateDomainMetrics(hostname, metrics);
  } catch {
    // Ignore URL parsing errors
  }

  const level = metrics.success ? LogLevel.DEBUG : LogLevel.ERROR;
  const requestId = metrics.requestId;
  const status = metrics.success
    ? `success (${metrics.duration}ms)`
    : `failed: ${metrics.error}`;

  this.log(level, `[Fetch] ${metrics.url} - ${status}`, undefined, requestId);
}

  static logCacheHit(hostname: string, size: number, requestId?: string): void {
    this.cacheMetrics.hits++;
    this.updateDomainMetrics(hostname, {
      url: hostname,
      duration: 0,
      success: true,
    });
    this.domainMetrics.get(hostname)!.cacheHits++;

    this.log(LogLevel.DEBUG, `[Cache] HIT ${hostname} - ${size} bytes`, { size }, requestId);
  }

  static logCacheMiss(hostname: string, requestId?: string): void {
    this.cacheMetrics.misses++;
    this.updateDomainMetrics(hostname, {
      url: hostname,
      duration: 0,
      success: true,
    });
    this.domainMetrics.get(hostname)!.cacheMisses++;

    this.log(LogLevel.DEBUG, `[Cache] MISS ${hostname}`, undefined, requestId);
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

  static getHealth(): {
    status: 'healthy' | 'unhealthy';
    cache: CacheMetrics;
    metrics: {
      totalFetches: number;
      successCount: number;
      errorCount: number;
      avgDuration: number;
      cacheUtilization: number;
    };
  } {
    const summary = this.getSummary();
    return {
      status: summary.errorCount === 0 ? 'healthy' : 'unhealthy',
      cache: this.cacheMetrics,
      metrics: {
        totalFetches: summary.totalFetches,
        successCount: summary.successCount,
        errorCount: summary.errorCount,
        avgDuration: summary.avgDuration,
        cacheUtilization: summary.cacheUtilization,
      },
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
