# usage-limits-core

Shared Claude Code / Codex usage-limit fetching, normalization, cache, and backoff logic for the usage-limits plugin family.

This package is intended to be consumed from sibling repositories with a pinned GitHub dependency, for example:

```json
{
  "dependencies": {
    "usage-limits-core": "github:sekka/usage-limits-core#v1.0.0"
  }
}
```

## Role

`usage-limits-core` owns the provider-facing and cache-facing behavior that should stay identical across tmux, herdr, and statusline integrations:

- Claude Code and Codex token discovery helpers
- Claude/Codex usage response normalization
- cache read/write helpers with `0600` file permissions
- 429 and transient failure backoff records
- stale/expired cache decisions
- expired-fetch stampede protection

Display formatting, terminal integration, daemon lifecycle, and plugin entrypoints stay in each consumer repository.

## Runtime Requirements

This package intentionally exports TypeScript source and is designed for Bun-based consumers. Use Bun `>= 1.3.0`, or a consumer build step that can load the exported `.ts` files from the Git dependency.

## API

Import public functions and types from the package root:

```ts
import {
  fetchAndCacheUsage,
  getClaudeToken,
  getCodexToken,
  normalizeCodexUsage,
  readCacheFile,
  resolveUsageData,
  type UsageLimits,
} from "usage-limits-core";
```

The main orchestration path is `resolveUsageData`:

```ts
const usage = await resolveUsageData({
  cacheFile,
  lockFile: `${cacheFile}.lock`,
  fetchAndCache: () =>
    fetchAndCacheUsage({
      cacheFile,
      token,
      url,
      headers,
    }),
});
```

`resolveUsageData` returns cached data, whether the rendered value should carry a stale marker, and the cache age in milliseconds.

## Poison Cache Policy

The package uses the tmux-family discard policy for out-of-range future values:

- `timestamp > now` is treated as an expired invalid record and returns `data: null`.
- `nextRetryAt > now + MAX_429_BACKOFF_MS` is discarded during read.
- `MAX_429_BACKOFF_MS` is 10 minutes.

This makes old poisoned cache records self-recover instead of keeping fetches skipped for days or years.

## Stampede Lock

Expired cache reads can trigger synchronous fetches. When multiple consumers observe the same expired cache at once, pass a shared `lockFile` to `resolveUsageData` to serialize fetch start:

- lock acquisition uses exclusive file creation
- the lock only guards fetch start and execution; cache writes already use the existing record path
- fresh locks make other consumers skip starting another sync fetch
- stale locks are recovered by mtime timeout
- default `lockTimeoutMs` is 30 seconds
- set `lockTimeoutMs` longer than the worst expected fetch duration for the consumer, otherwise a slow in-flight fetch can be mistaken for a stale lock

If `lockFile` is omitted, `resolveUsageData` preserves the historical no-lock behavior.

## Development

Run the tests:

```sh
bun test
```

Releases are automated by release-please. Land Conventional Commits on `master`; release-please maintains the release PR, changelog, tag, and GitHub Release.

## License

[MIT](LICENSE) (c) sekka
