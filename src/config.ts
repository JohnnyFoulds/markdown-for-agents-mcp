/**
 * Centralized configuration module
 * Validates and provides access to all environment variables
 */

import { z } from 'zod';

const configSchema = z.object({
  // Fetch settings
  FETCH_TIMEOUT_MS: z.string().default('30000').transform(Number),
  MAX_CONCURRENT_FETCHES: z.string().default('5').transform(Number),
  STABILIZATION_DELAY_MS: z.string().default('2000').transform(Number),
  MAX_REDIRECTS: z.string().default('10').transform(Number),
  MAX_CONTENT_LENGTH: z.string().default('100000').transform(Number),

  // Logging
  LOG_LEVEL: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),

  // Cache
  CACHE_MAX_BYTES: z.string().default('52428800').transform(Number), // 50MB
  CACHE_TTL_MS: z.string().default('900000').transform(Number), // 15 minutes

  // Security
  USE_ALLOWLIST_MODE: z.boolean().default(false),
  BLOCKLIST_DOMAINS: z.string().optional(),
  BLOCKLIST_URL_PATTERNS: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Validate and parse configuration from environment variables
 */
export function validateConfig(): Config {
  try {
    return configSchema.parse(process.env);
  } catch (error) {
    const zodError = error as { errors: z.ZodIssue[] };
    const issues = zodError.errors.map((e) =>
      `  - ${e.path.join('.')}: ${e.message}`
    ).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
}

/**
 * Parse a single environment variable as a number
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
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
 * Validate configuration and exit on error
 */
export function validateAndInitializeConfig(): Config {
  const config = validateConfig();
  // Filter out undefined values from process.env
  const envValues = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;
  initializeConfig(envValues);
  return config;
}

// Store config in global for testing
interface GlobalWithConfig extends Global {
  __config?: Config;
}

export function resetConfig(): void {
  delete (globalThis as GlobalWithConfig).__config;
}
