import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CACHE_FRESH_MS = 5 * 60 * 1000;
const CACHE_STALE_MS = 60 * 60 * 1000;
const API_TIMEOUT = 5000;
const MAX_429_BACKOFF_MS = 10 * 60 * 1000;

export interface LimitEntry {
  utilization: number;
  resets_at: string | null;
}

export interface RawScopedLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

export interface UsageLimits {
  five_hour: LimitEntry | null;
  seven_day: LimitEntry | null;
  limits?: RawScopedLimit[] | null;
}

export interface CodexUsageWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

export interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexUsageWindow | null;
    secondary_window?: CodexUsageWindow | null;
  } | null;
}

export type Staleness = "fresh" | "stale" | "expired";

export interface CacheRecord {
  data: UsageLimits | null;
  timestamp: number;
  nextRetryAt: number | null;
}

export type KeychainFallback = () => Promise<string | null>;

export interface FetchAndCacheArgs {
  cacheFile: string;
  token: string | null;
  url: string;
  headers: Record<string, string>;
  normalize?: (raw: unknown) => UsageLimits;
  now?: number;
  timeoutMs?: number;
  defaultBackoffMs?: number;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ResolveUsageArgs {
  cacheFile: string;
  now?: number;
  fetchAndCache: () => Promise<void>;
}

export interface ResolvedUsage {
  data: UsageLimits | null;
  showStale: boolean;
  ageMs: number;
}

export function shouldFetchNow(args: {
  staleness: Staleness;
  now: number;
  nextRetryAt: number | null;
}): "skip" | "background" | "sync" {
  if (args.nextRetryAt !== null && args.nextRetryAt > args.now) return "skip";
  if (args.staleness === "fresh") return "skip";
  if (args.staleness === "stale") return "background";
  return "sync";
}

export function parseRetryAfter(header: string | null, now: number, defaultMs: number): number {
  if (!header) return now + defaultMs;
  const trimmed = header.trim();
  if (trimmed === "") return now + defaultMs;
  let candidate: number;
  if (/^[-+]?\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    if (sec < 0) return now + defaultMs;
    candidate = now + sec * 1000;
  } else {
    const dateMs = Date.parse(trimmed);
    if (!isNaN(dateMs)) {
      candidate = Math.max(dateMs, now);
    } else {
      return now + defaultMs;
    }
  }
  return Math.max(candidate, now + 1000);
}

export function parseCache(json: string): CacheRecord | null {
  try {
    const parsed = JSON.parse(json);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("data" in parsed) ||
      !("timestamp" in parsed) ||
      typeof parsed.timestamp !== "number" ||
      !Number.isFinite(parsed.timestamp)
    ) {
      return null;
    }
    const nextRetryAt =
      typeof parsed.nextRetryAt === "number" && Number.isFinite(parsed.nextRetryAt)
        ? parsed.nextRetryAt
        : null;
    return {
      data: parsed.data as UsageLimits | null,
      timestamp: parsed.timestamp,
      nextRetryAt,
    };
  } catch {
    return null;
  }
}

export function computeStaleness(timestamp: number, now: number): Staleness {
  const age = now - timestamp;
  if (age < CACHE_FRESH_MS) return "fresh";
  if (age < CACHE_STALE_MS) return "stale";
  return "expired";
}

export function shouldShowStaleMark(args: {
  staleness: Staleness;
  nextRetryAt: number | null;
  now: number;
}): boolean {
  if (args.staleness === "stale") return true;
  if (args.staleness === "expired" && args.nextRetryAt !== null && args.nextRetryAt > args.now) {
    return true;
  }
  return false;
}

export function compute429Record(
  existing: CacheRecord | null,
  retryAfterHeader: string | null,
  now: number,
  defaultMs: number,
): CacheRecord {
  const nextRetryAt = Math.min(
    parseRetryAfter(retryAfterHeader, now, defaultMs),
    now + MAX_429_BACKOFF_MS,
  );
  if (existing === null) {
    return { data: null, timestamp: 0, nextRetryAt };
  }
  return { data: existing.data, timestamp: existing.timestamp, nextRetryAt };
}

function computeFailureRecord(
  existing: CacheRecord | null,
  now: number,
  defaultMs: number,
  maxBackoffMs: number,
): CacheRecord {
  const nextRetryAt = Math.min(now + defaultMs, now + maxBackoffMs);
  if (existing === null) return { data: null, timestamp: 0, nextRetryAt };
  const staleTimestamp =
    existing.data === null
      ? existing.timestamp
      : Math.min(existing.timestamp, now - CACHE_FRESH_MS);
  return { data: existing.data, timestamp: staleTimestamp, nextRetryAt };
}

export function fableFromLimits(limits: RawScopedLimit[] | null | undefined): LimitEntry | null {
  if (!Array.isArray(limits)) return null;
  const entry = limits.find(
    (l) => l?.kind === "weekly_scoped" && l?.scope?.model?.display_name === "Fable",
  );
  if (!entry || typeof entry.percent !== "number") return null;
  return {
    utilization: Math.max(0, Math.min(100, Math.round(entry.percent))),
    resets_at: typeof entry.resets_at === "string" ? entry.resets_at : null,
  };
}

export function limitFromCodexWindow(
  window: CodexUsageWindow | null | undefined,
): LimitEntry | null {
  if (!window || typeof window.used_percent !== "number") return null;
  const resetMs = window.reset_at > 1_000_000_000_000 ? window.reset_at : window.reset_at * 1000;
  return {
    utilization: Math.max(0, Math.min(100, Math.round(window.used_percent))),
    resets_at: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
  };
}

export function normalizeCodexUsage(data: CodexUsageResponse): UsageLimits {
  const windows = data.rate_limit ?? {};
  return {
    five_hour: limitFromCodexWindow(windows.primary_window),
    seven_day: limitFromCodexWindow(windows.secondary_window),
  };
}

export async function getClaudeToken(args: {
  credentialsFile: string;
  keychainFallback?: KeychainFallback;
}): Promise<string | null> {
  try {
    const creds = JSON.parse(await readFile(args.credentialsFile, "utf8"));
    const token = creds?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length >= 20) return token;
  } catch {
    // Fall back to keychain below.
  }
  return args.keychainFallback ? args.keychainFallback() : null;
}

export async function getCodexToken(args: { authFile: string }): Promise<string | null> {
  try {
    const auth = JSON.parse(await readFile(args.authFile, "utf8"));
    const token = auth?.tokens?.access_token;
    return typeof token === "string" && token.length >= 20 ? token : null;
  } catch {
    return null;
  }
}

export async function keychainToken(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
    const creds = JSON.parse(stdout.trim());
    const token = creds?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length >= 20 ? token : null;
  } catch {
    return null;
  }
}

export async function readCacheFile(
  cacheFile: string,
  now = Date.now(),
): Promise<{
  data: UsageLimits | null;
  staleness: Staleness;
  ageMs: number;
  nextRetryAt: number | null;
}> {
  try {
    const record = parseCache(await readFile(cacheFile, "utf8"));
    if (!record) return { data: null, staleness: "expired", ageMs: Infinity, nextRetryAt: null };
    if (record.timestamp > now) {
      return { data: null, staleness: "expired", ageMs: Infinity, nextRetryAt: null };
    }
    const nextRetryAt =
      record.nextRetryAt !== null && record.nextRetryAt <= now + MAX_429_BACKOFF_MS
        ? record.nextRetryAt
        : null;
    const age = now - record.timestamp;
    const staleness = computeStaleness(record.timestamp, now);
    if (staleness === "expired") {
      const keepData = nextRetryAt !== null && nextRetryAt > now ? record.data : null;
      return { data: keepData, staleness: "expired", ageMs: age, nextRetryAt };
    }
    return { data: record.data, staleness, ageMs: age, nextRetryAt };
  } catch {
    return { data: null, staleness: "expired", ageMs: Infinity, nextRetryAt: null };
  }
}

export async function readRawRecordFile(cacheFile: string): Promise<CacheRecord | null> {
  try {
    return parseCache(await readFile(cacheFile, "utf8"));
  } catch {
    return null;
  }
}

export async function writeCacheRecord(cacheFile: string, record: CacheRecord): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
  await writeFile(cacheFile, JSON.stringify(record));
  await chmod(cacheFile, 0o600);
}

export async function fetchAndCacheUsage(args: FetchAndCacheArgs): Promise<void> {
  const now = args.now ?? Date.now();
  const defaultBackoffMs = args.defaultBackoffMs ?? 60_000;
  const maxBackoffMs = args.maxBackoffMs ?? MAX_429_BACKOFF_MS;

  const recordFailure = async (reason: string): Promise<void> => {
    console.warn(`usage-limits fetch failed: ${reason}`);
    const existing = await readRawRecordFile(args.cacheFile);
    await writeCacheRecord(
      args.cacheFile,
      computeFailureRecord(existing, now, defaultBackoffMs, maxBackoffMs),
    );
  };

  if (!args.token) {
    await recordFailure("missing token");
    return;
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? API_TIMEOUT;

  let res: Response;
  try {
    res = await fetchImpl(args.url, {
      headers: {
        ...args.headers,
        Authorization: `Bearer ${args.token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    await recordFailure(error instanceof Error ? error.message : String(error));
    return;
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const existing = await readRawRecordFile(args.cacheFile);
    const record = compute429Record(existing, retryAfter, now, defaultBackoffMs);
    await writeCacheRecord(args.cacheFile, record);
    return;
  }

  if (!res.ok) {
    await recordFailure(`HTTP ${res.status}`);
    return;
  }
  try {
    const raw = await res.json();
    const data = args.normalize ? args.normalize(raw) : (raw as UsageLimits);
    await writeCacheRecord(args.cacheFile, { data, timestamp: now, nextRetryAt: null });
  } catch (error) {
    await recordFailure(error instanceof Error ? error.message : String(error));
  }
}

export async function resolveUsageData(args: ResolveUsageArgs): Promise<ResolvedUsage> {
  const now = args.now ?? Date.now();
  let cache = await readCacheFile(args.cacheFile, now);
  const decision = shouldFetchNow({
    staleness: cache.staleness,
    now,
    nextRetryAt: cache.nextRetryAt,
  });

  if (decision === "sync") {
    try {
      await args.fetchAndCache();
    } catch {}
    cache = await readCacheFile(args.cacheFile, now);
  } else if (decision === "background") {
    args.fetchAndCache().catch(() => {});
  }

  return {
    data: cache.data,
    showStale: shouldShowStaleMark({
      staleness: cache.staleness,
      nextRetryAt: cache.nextRetryAt,
      now,
    }),
    ageMs: cache.ageMs,
  };
}
