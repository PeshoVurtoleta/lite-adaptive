# Changelog

All notable changes to `@zakkster/lite-adaptive` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] - 2026-09-23

The first release -- the new package scaffold, the shared time-source + fixed
bucket-pool substrate (ADR 0001), and the reference member.

### Added

- **`ExponentialHistogram`** -- the reference member: sliding-window COUNT / SUM over
  the last W in FIXED memory (Datar-Gionis-Indyk-Motwani, SODA 2002). A preallocated
  pool of `(timestamp, size)` buckets grouped by level; `add` opens a level-0 bucket,
  runs the amortized merge cascade (`k = ceil(1/(2*epsilon)) + 1` buckets per level),
  and expires the window edge -- 0 B/op INCLUDING the reshaping. `count()` / `sum()` /
  `query()` return the windowed estimate within a HARD relative error `<= epsilon`
  (the oldest straddling bucket is half-corrected only when it actually straddles, so
  a not-yet-full window is EXACT). DGIM (the 0/1 count stream) is the `value = 1`
  special case.
- **The time source** -- a caller-supplied MONOTONE `now` (`add(now)` /
  `add(now, value)`); the member never reads the wall clock. A COUNT-MODE convenience
  auto-ticks when `now` is omitted (`add()`). The mode LOCKS at the first add.
- **The fixed bucket-pool substrate** -- a Struct-of-Arrays (Float64 timestamp /
  start / size, Int32 level linkage + free-list) sized to
  `CAP = (k+1) * (ceil(log2(W/(k+1))) + 2) + 2` buckets; no per-op allocation.
- **Fail-closed construction + hot path** -- a bad `W` / `epsilon` / option throws
  `[lite-adaptive]` before allocation; `add` rejects a mode switch, a non-finite /
  decreasing `now`, or a non-positive value (byte-identical no-op); queries never throw.
- **The gate chassis** -- `test/witness.mjs` (windowed error `<= epsilon` across the
  `W x epsilon` sweep + a shifting stream + a rejected broken-EH negative control),
  `test/torture.mjs` (0 B/op incl. merge/expire, gc major 0, retention 0),
  `test/perf/PerfGate.test.mjs` (flat throughput + a must-allocate control), the
  behavioral / fail-closed `node:test` suite, and the ambient type surface.
- ADR 0001 (the time source + bucket pool) and ADR 0002 (ExponentialHistogram).
