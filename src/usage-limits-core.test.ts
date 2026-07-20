import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchAndCacheUsage,
  parseCache,
  readCacheFile,
  shouldFetchNow,
  type CacheRecord,
  type UsageLimits,
} from "./usage-limits-core";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempCache(record: CacheRecord): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "usage-core-"));
  tempDirs.push(dir);
  const cacheFile = join(dir, "cache.json");
  await writeFile(cacheFile, JSON.stringify(record));
  return cacheFile;
}

function existingRecord(now: number): CacheRecord {
  return {
    data: {
      five_hour: { utilization: 42, resets_at: null },
      seven_day: null,
    },
    timestamp: now - 120_000,
    nextRetryAt: null,
  };
}

async function readRecord(cacheFile: string): Promise<CacheRecord> {
  const record = parseCache(await readFile(cacheFile, "utf8"));
  expect(record).not.toBeNull();
  return record!;
}

describe("fetchAndCacheUsage failure recording", () => {
  const now = 1_000_000;
  const staleData: UsageLimits = {
    five_hour: { utilization: 42, resets_at: null },
    seven_day: null,
  };

  test("token 取得失敗時に既存 cache を stale marker 付きで保持する", async () => {
    const cacheFile = await tempCache(existingRecord(now));

    await fetchAndCacheUsage({
      cacheFile,
      token: null,
      url: "https://example.invalid/usage",
      headers: {},
      now,
    });

    const record = await readRecord(cacheFile);
    expect(record.data).toEqual(staleData);
    expect(record.nextRetryAt).toBe(now + 60_000);
    const cache = await readCacheFile(cacheFile, now);
    expect(cache.data).toEqual(staleData);
    expect(cache.staleness).toBe("stale");
  });

  test("非429エラー時に既存 cache を stale marker 付きで保持する", async () => {
    const cacheFile = await tempCache(existingRecord(now));

    await fetchAndCacheUsage({
      cacheFile,
      token: "x".repeat(20),
      url: "https://example.invalid/usage",
      headers: {},
      now,
      fetchImpl: async () => new Response("server error", { status: 500 }),
    });

    const record = await readRecord(cacheFile);
    expect(record.data).toEqual(staleData);
    expect(record.nextRetryAt).toBe(now + 60_000);
  });

  test("ネットワーク例外時に既存 cache を stale marker 付きで保持する", async () => {
    const cacheFile = await tempCache(existingRecord(now));

    await fetchAndCacheUsage({
      cacheFile,
      token: "x".repeat(20),
      url: "https://example.invalid/usage",
      headers: {},
      now,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    const record = await readRecord(cacheFile);
    expect(record.data).toEqual(staleData);
    expect(record.nextRetryAt).toBe(now + 60_000);
  });

  test("200 + malformed JSON 時に例外を伝播せず stale marker 付き cache を書く", async () => {
    const cacheFile = await tempCache(existingRecord(now));

    await fetchAndCacheUsage({
      cacheFile,
      token: "x".repeat(20),
      url: "https://example.invalid/usage",
      headers: {},
      now,
      fetchImpl: async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const record = await readRecord(cacheFile);
    expect(record.data).toEqual(staleData);
    expect(record.nextRetryAt).toBe(now + 60_000);
  });
});

describe("readCacheFile 読み込み時バリデーション (毒 cache)", () => {
  const now = 1_000_000;
  const poisonedData: UsageLimits = {
    five_hour: { utilization: 42, resets_at: null },
    seven_day: null,
  };
  const YEAR_2033_EPOCH_MS = 2_000_000_000 * 1000;

  test("未来 nextRetryAt (毒 cache) は破棄される (Claude 側経路)", async () => {
    const cacheFile = await tempCache({
      data: poisonedData,
      timestamp: now - 120_000,
      nextRetryAt: YEAR_2033_EPOCH_MS,
    });

    const cache = await readCacheFile(cacheFile, now);

    expect(cache.nextRetryAt).toBeNull();
  });

  test("未来 timestamp (毒 cache) は expired 扱いで record を破棄する (Codex 側経路)", async () => {
    const cacheFile = await tempCache({
      data: poisonedData,
      timestamp: YEAR_2033_EPOCH_MS,
      nextRetryAt: null,
    });

    const cache = await readCacheFile(cacheFile, now);

    expect(cache.staleness).toBe("expired");
    expect(cache.data).toBeNull();
  });

  test("未来 nextRetryAt (毒 cache) でも fetch 判定が永久 skip にならない (Claude 側経路)", async () => {
    const cacheFile = await tempCache({
      data: poisonedData,
      timestamp: now - 6 * 60 * 1000,
      nextRetryAt: YEAR_2033_EPOCH_MS,
    });

    const cache = await readCacheFile(cacheFile, now);
    const decision = shouldFetchNow({
      staleness: cache.staleness,
      now,
      nextRetryAt: cache.nextRetryAt,
    });

    expect(["background", "sync"]).toContain(decision);
  });

  test("未来 timestamp (毒 cache) でも fetch 判定が永久 skip にならない (Codex 側経路)", async () => {
    const cacheFile = await tempCache({
      data: poisonedData,
      timestamp: YEAR_2033_EPOCH_MS,
      nextRetryAt: null,
    });

    const cache = await readCacheFile(cacheFile, now);
    const decision = shouldFetchNow({
      staleness: cache.staleness,
      now,
      nextRetryAt: cache.nextRetryAt,
    });

    expect(["background", "sync"]).toContain(decision);
  });
});
