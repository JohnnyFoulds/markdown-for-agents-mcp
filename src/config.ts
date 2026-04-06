/**
 * Centralized configuration module
 * Validates and provides access to all environment variables
 */

import { z } from 'zod';

const configSchema = z.object({
  // Fetch settings
  FETCH_TIMEOUT_MS: z.string().default('30000').transform(Number),
  MAX_CONCURRENT_FETCHES: z.string().default('5').transform(Number),
  MAX_REDIRECTS: z.string().default('10').transform(Number),
  MAX_CONTENT_LENGTH: z.string().default('100000').transform(Number),

  // Logging
  LOG_LEVEL: z.string().default('INFO').refine(val => ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(val), {
    message: 'Invalid LOG_LEVEL',
  }),
  LOG_FORMAT: z.string().default('text').refine(val => ['text', 'json'].includes(val), {
    message: 'Invalid LOG_FORMAT',
  }),

  // Cache
  CACHE_MAX_BYTES: z.string().default('52428800').transform(Number), // 50MB
  CACHE_TTL_MS: z.string().default('900000').transform(Number), // 15 minutes

  // Security
  USE_ALLOWLIST_MODE: z.string().default('false').transform(val => val === 'true'),
  BLOCKLIST_DOMAINS: z.string().optional(),
  BLOCKLIST_URL_PATTERNS: z.string().optional(),

  // Web Search
  WEB_SEARCH_DEFAULT_TIMEOUT_MS: z.string().default('30000').transform(Number),

  // File Download
  DOWNLOAD_TIMEOUT_MS: z.string().default('60000').transform(Number),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Validate and parse configuration from environment variables
 */
export function validateConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((e) =>
      `  - ${e.path.join('.')}: ${e.message}`
    ).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * Get configuration - throws if not initialized
 */
export function getConfig(): Config {
  const globalWithConfig = globalThis as GlobalWithConfig;
  if (!globalWithConfig.__config) {
    throw new Error(
      'Configuration not initialized. Call validateConfig() first.'
    );
  }
  return globalWithConfig.__config;
}

/**
 * Initialize configuration (for testing)
 */
export function initializeConfig(env: Record<string, string>): Config {
  const globalWithConfig = globalThis as GlobalWithConfig;
  globalWithConfig.__config = configSchema.parse(env);
  return globalWithConfig.__config;
}

/**
 * Validate configuration from process.env, store globally, and return it.
 * Parses the environment exactly once.
 */
export function validateAndInitializeConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((e) =>
      `  - ${e.path.join('.')}: ${e.message}`
    ).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const globalWithConfig = globalThis as GlobalWithConfig;
  globalWithConfig.__config = result.data;
  return result.data;
}

// Store config in global for testing
interface GlobalWithConfig extends Global {
  __config?: Config;
}

export function resetConfig(): void {
  delete (globalThis as GlobalWithConfig).__config;
}
