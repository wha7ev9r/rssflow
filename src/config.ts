/** Environment bindings and derived runtime configuration. */

export interface Env {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;

  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  AUTH_SECRET?: string;
  CRON_SECRET?: string;

  SITE_NAME?: string;
  FETCH_INTERVAL_MINUTES?: string;
  MAX_FEEDS_PER_RUN?: string;
  MAX_ITEMS_PER_FETCH?: string;
  RETENTION_DAYS?: string;
  MAX_ENTRIES_PER_FEED?: string;
  USER_AGENT?: string;
}

export interface AppConfig {
  siteName: string;
  adminUsername: string;
  adminPassword: string;
  authSecret: string;
  cronSecret: string;
  fetchIntervalMinutes: number;
  maxFeedsPerRun: number;
  maxItemsPerFetch: number;
  retentionDays: number;
  maxEntriesPerFeed: number;
  userAgent: string;
}

function num(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function readConfig(env: Env): AppConfig {
  return {
    siteName: (env.SITE_NAME ?? '').trim() || 'Buffy Reader',
    adminUsername: (env.ADMIN_USERNAME ?? '').trim() || 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? '',
    authSecret: env.AUTH_SECRET ?? '',
    cronSecret: env.CRON_SECRET ?? '',
    fetchIntervalMinutes: num(env.FETCH_INTERVAL_MINUTES, 15, 1, 1440),
    maxFeedsPerRun: num(env.MAX_FEEDS_PER_RUN, 2, 1, 20),
    maxItemsPerFetch: num(env.MAX_ITEMS_PER_FETCH, 40, 1, 300),
    retentionDays: num(env.RETENTION_DAYS, 120, 1, 3650),
    maxEntriesPerFeed: num(env.MAX_ENTRIES_PER_FEED, 500, 10, 100000),
    userAgent:
      (env.USER_AGENT ?? '').trim() ||
      'Mozilla/5.0 (compatible; BuffyReader/1.0)',
  };
}

export function databaseUrl(env: Env): string {
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? '';
}

/** Fatal misconfiguration: without these the app cannot authenticate anyone. */
export function configProblems(env: Env): string[] {
  const problems: string[] = [];
  if (!env.ADMIN_PASSWORD) problems.push('ADMIN_PASSWORD is not set.');
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 16) {
    problems.push('AUTH_SECRET is missing or shorter than 16 characters.');
  }
  if (!databaseUrl(env)) {
    problems.push('No database: bind HYPERDRIVE or set DATABASE_URL.');
  }
  return problems;
}
