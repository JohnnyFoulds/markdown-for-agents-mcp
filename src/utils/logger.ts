/**
 * Logger utility for fetch performance metrics
 */

import { createHmac, randomBytes } from 'node:crypto';
import { getConfig } from '../config.js';
import { redactUrl } from '../privacy/redact.js';

// Per-process HMAC-SHA-256 salt for redactQuery.
// Undefined until first call — lazy-initialised from LOG_REDACT_SALT or randomBytes.
// Uncorrelatable across restarts and replicas by default (privacy-safe).
// Set LOG_REDACT_SALT to share the salt explicitly: cross-replica debug, trading
// privacy for linkability.
let _querySalt: string | undefined;

/** Test-only export — resets the salt so a fresh random one is generated next call. */
export function _resetQuerySaltForTest(): void {
  _querySalt = undefined;
}

function getQuerySalt(): string {
  if (!_querySalt) {
    let explicit = '';
    try { explicit = getConfig().LOG_REDACT_SALT ?? ''; } catch { /* not initialised */ }
    _querySalt = explicit || randomBytes(32).toString('hex');
  }
  return _querySalt;
}

/**
 * Returns a privacy-safe representation of a query string.
 * When LOG_REDACT_QUERIES=true (default), returns 16 hex chars of an
 * HMAC-SHA-256 hash keyed by a per-process random salt.  Hashes are
 * stable within a process for debugging correlation, but uncorrelatable
 * across restarts/replicas unless LOG_REDACT_SALT is set explicitly.
 *
 * 16 chars (64-bit) rather than the previous 8 (32-bit) — at 65 k values
 * the 32-bit space expected ~one collision per process; 64-bit is collision-safe
 * across the full retention window.
 */
export function redactQuery(query: string): string {
  let redact = true;
  try { redact = getConfig().LOG_REDACT_QUERIES; } catch { /* default true */ }
  if (!redact) return query;
  return `[redacted:${createHmac('sha256', getQuerySalt()).update(query).digest('hex').slice(0, 16)}]`;
}

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

const SENSITIVE_JSON_KEYS = new Set(['authorization', 'cookie', 'set-cookie']);

function scrubSensitiveKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = SENSITIVE_JSON_KEYS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
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
    entry.data = scrubSensitiveKeys(data as Record<string, unknown>);
  }

  return JSON.stringify(entry);
}

export interface FetchMetrics {
  url: string;
  duration: number;
  success: boolean;
  error?: string;
  requestId?: string;
  /** Epoch ms when this entry was recorded — used for age-based eviction. */
  timestamp?: number;
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
  const now = Date.now();
  // Age-based eviction: raw URLs must not persist beyond the retention window
  let retentionMs = 7 * 24 * 60 * 60 * 1000; // 7-day default matches CRAWL_RETENTION_MS
  try { retentionMs = getConfig().CRAWL_RETENTION_MS; } catch { /* config not initialized */ }
  const ageCutoff = now - retentionMs;
  this.metrics = this.metrics.filter(m => (m.timestamp ?? 0) > ageCutoff);

  if (this.metrics.length >= this.MAX_METRICS) {
    this.metrics = this.metrics.slice(-Math.floor(this.MAX_METRICS / 2));
  }
  this.metrics.push({ ...metrics, timestamp: now });

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

  this.log(level, `[Fetch] ${redactUrl(metrics.url)} - ${status}`, undefined, requestId);
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
      status: summary.totalFetches === 0 || summary.errorCount / summary.totalFetches <= 0.1
        ? 'healthy'
        : 'unhealthy',
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
