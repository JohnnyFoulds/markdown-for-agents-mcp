/**
 * Simple LRU Cache implementation for URL caching
 * Supports size-based and time-based eviction
 */

export interface CacheOptions<T> {
  /** Maximum number of entries */
  maxLength?: number;
  /** Maximum size in bytes (sum of serialized values) */
  maxBytes?: number;
  /** Default TTL in milliseconds */
  ttl?: number;
}

export interface CacheEntry<T> {
  value: T;
  createdAt: number;
  accessAt: number;
  bytes: number;
}

export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private accessOrder: string[] = [];
  private options: Required<CacheOptions<T>>;
  private _totalBytes = 0;

  constructor(options: CacheOptions<T> = {}) {
    this.options = {
      maxLength: options.maxLength ?? 100,
      maxBytes: options.maxBytes ?? 50 * 1024 * 1024, // 50MB default
      ttl: options.ttl ?? 15 * 60 * 1000, // 15 minutes default
    };
  }

  /**
   * Get value from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.accessAt > this.options.ttl) {
      this.delete(key);
      return undefined;
    }

    // Update access time and order
    entry.accessAt = Date.now();
    this.updateAccessOrder(key);

    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, bytes?: number): void {
    const size = bytes ?? this.estimateBytes(value);

    // Check if key exists, delete if so
    if (this.cache.has(key)) {
      this.delete(key);
    }

    // Evict entries if at capacity
    while (
      (this.cache.size >= this.options.maxLength ||
        this._totalBytes + size > this.options.maxBytes) &&
      this.cache.size > 0
    ) {
      // Evict oldest (least recently used)
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) {
        this.delete(oldestKey);
      }
    }

    // Add new entry
    const entry: CacheEntry<T> = {
      value,
      createdAt: Date.now(),
      accessAt: Date.now(),
      bytes: size,
    };

    this.cache.set(key, entry);
    this.accessOrder.push(key);
    this._totalBytes += size;
  }

  /**
   * Delete entry from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    this.cache.delete(key);
    this._totalBytes -= entry.bytes;

    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }

    return true;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this._totalBytes = 0;
  }

  /**
   * Get cache size in bytes
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get total bytes used
   */
  get totalBytes(): number {
    return this._totalBytes;
  }

  /**
   * Get cache stats for monitoring
   */
  getStats(): {
    size: number;
    totalBytes: number;
    maxBytes: number;
    utilization: number;
  } {
    return {
      size: this.cache.size,
      totalBytes: this._totalBytes,
      maxBytes: this.options.maxBytes,
      utilization: this._totalBytes / this.options.maxBytes,
    };
  }

  /**
   * Get maxBytes (for external access)
   */
  get maxBytes(): number {
    return this.options.maxBytes;
  }

  /**
   * Estimate byte size of a value
   */
  private estimateBytes(value: T): number {
    if (typeof value === 'string') {
      return Buffer.byteLength(value, 'utf8');
    }
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      return 1024; // Default estimate
    }
  }

  /**
   * Update access order for LRU tracking
   */
  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }
}
