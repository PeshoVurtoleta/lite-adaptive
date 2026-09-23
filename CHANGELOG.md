# Changelog

All notable changes to `@zakkster/lite-adaptive` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.0.0] - 2026-09-24

The **API-FREEZE** milestone. The four-member core -- `ExponentialHistogram`, `ADWIN`,
`ForwardDecay`, `HeavyKeeper` -- is declared STABLE: signatures, options, and valid-input
behavior are frozen under 1.x. API frozen: four-member core stable (additive post-1.0
members remain possible; the core does not break). No new member and no hot-path byte change;
this release only tightens three previously-invalid-input paths to fail closed (all cold,
0 B/op) and corrects a doc contract. Prior VALID calls are byte-for-byte behaviorally identical.

### Changed

- **API declared stable at 1.0.0.** The four-member core is frozen; the package follows
  semantic versioning from here.

### Fixed

- **`ForwardDecay` fail-closed empty query.** `count(now)` / `sum(now)` / `mean(now)` /
  `rate(now)` now validate the query-time argument (finite number `>= the last add time`)
  BEFORE the empty-summary early exit, so an invalid `now` (negative, `NaN`, `Infinity`,
  non-number) on an EMPTY summary throws `[lite-adaptive]` instead of silently returning `0`.
  Valid use is unchanged: `count()` (no arg) and `count(<valid finite now>)` on an empty
  summary still return `0`. Cold path, 0 B/op.
- **`HeavyKeeper.estimate(key)` fail-closed key.** A non-safe-integer key now throws
  `[lite-adaptive]` (the same guard `add` applies) instead of silently returning `0`. An
  unseen but VALID key still reads `0`. Cold path.
- **`HeavyKeeper.topKInto(buf)` buffer guard.** `buf` must be a `Float64Array` of length
  `>= 2*k`; a too-small or non-`Float64Array` buffer now throws `[lite-adaptive]` instead of
  silently truncating the top-k. Cold throw before any write, 0 B/op on the success path.

### Documentation

- **`topKInto` contract corrected.** `topKInto(buf)` packs the current top-k as
  `[key, estimate]` PAIRS (2 `Float64` slots per entry) and returns the ENTRY COUNT; `buf`
  must be a `Float64Array` of length `>= 2*k` (a `Float64Array` is required -- estimates and
  large u32 keys need it). Fixed in `llms.txt`, `Adaptive.d.ts`, and `README.md` (the earlier
  "top-k keys / Uint32Array" wording was wrong).

## [0.4.0] - 2026-09-23

The fourth and FINAL member -- **HeavyKeeper** (Gong et al., USENIX ATC 2018): decayed /
windowed heavy hitters (the top-k keys dominating the stream RIGHT NOW). Completes the
four-member roster; 1.0.0 (the API freeze) is next. Pure append: `ExponentialHistogram` and
`ForwardDecay` are byte-identical, and `ADWIN`'s `add(x)` hot body is unchanged (it gains an
additive `addFrom`); only the file header and `VERSION` change otherwise.

### Added

- **`HeavyKeeper`** -- a decayed top-k over a `d x w` table of `(fingerprint, count)` cells
  (SoA `Uint32Array` columns) plus an intrusive top-k min-forest (design-parity with lite-o1
  `FreqO1`, never a dependency). `add(key, weight = 1)` hashes the key to `d` cells via an
  inline two-lane hash; a matching fingerprint adds the weight, a colliding one is decayed
  with probability `b^(-count)` (a seeded xorshift32 draw) and evicted at count 0 -- so cold
  keys erode and the live top-k tracks the CURRENT concept. Amortized O(1), **0 B/op including
  the decay draw and the forest sift**. `estimate(key)` is the max matching cell (0, never
  throws, for an unseen key); `forEach(fn)` iterates the current top-k allocation-free (the
  render path); `topKInto(buf)` fills a caller buffer 0-alloc; `topK()` is a COLD convenience
  that may allocate. Weight is a positive integer (rank by count, or by total time / bytes /
  any additive weight). Far lower error than Space-Saving on skewed, evolving streams.
- **`HeavyKeeper.addFrom(buf, i)`** -- the zero-box hot entry: `key = buf[i]`,
  `weight = buf[i+1]` read UNBOXED from a caller-owned `Float64Array`. A large `u32` tag id
  (>= 2^31) passed as a plain argument boxes into a ~16 B HeapNumber at a non-inlined call
  boundary; `addFrom` avoids it (torture-gated 0 B/op on keys near 2^31 / 2^32 - 1).
- **`ADWIN.addFrom(buf, i)`** -- a zero-box sibling of `ADWIN.add(x)` (reads `x = buf[i]`
  unboxed, returns the same boolean drift flag). ADWIN 0.2.0 had only `add(x)`, which boxes a
  fractional `x` at the peer boundary; this lands before the 1.0.0 freeze so the drift member's
  surface is complete. `ADWIN.add(x)` is byte-identical.
- **The top-k witness** (`test/witness.mjs`) -- the honesty anchor for HeavyKeeper: 100% recall
  of the true current top-k above `N/k` vs an exact `Map` oracle (weighted and unit streams),
  a bounded overestimate (each reported total in `[true - ~N/w, true]`, never over the truth),
  and the marquee claim -- measured mean rel-error over the true top-k of **0.001% vs a faithful
  Space-Saving baseline's 36.75%** (Metwally et al. Stream-Summary, hand-rolled inline and cited,
  not a strawman) on a Zipfian (`s = 1.1`) + DRIFTING stream. Negative controls the same gate
  rejects: a frozen-forest variant (recall 0%) and a decay-disabled variant (`b` huge; recall
  40% on drift).

### Changed

- `VERSION` -> `0.4.0` (package.json / `Adaptive.js` / llms.txt trinity); the file header
  documents the complete four-member roster.

## [0.3.0] - 2026-09-23

The third member -- **ForwardDecay** (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009):
the TIME-DECAY axis (recent weighs more), the complement to the EH hard window and the
ADWIN adaptive window. The `ADWIN` class is byte-identical; `ExponentialHistogram` gains
an additive zero-box `addFrom(buf, i)` entry (its `add()` hot body is unchanged); only
the file header and `VERSION` change otherwise.

### Added

- **`ForwardDecay`** -- a zero-GC, O(1)-space time-decayed COUNT / SUM / MEAN / RATE.
  It weights each item at time `t` by `g(t - L)` measured FORWARD from a landmark `L`
  (exponential decay `g(x) = exp(lambda * x)`, `lambda = ln2 / halfLife`), maintaining
  two scalar accumulators -- `C` (decayed weights) and `Sv` (decayed weighted values) --
  incrementally. `add(now, value)` is amortized O(1), **0 B/op including the landmark
  rebase**: when the forward weight's exponent would exceed `FD_EXP_CAP = 40`, the
  landmark is advanced by rescaling `C` and `Sv` by a single constant factor (EXACT
  modulo floating point), which keeps the accumulator finite for any physically reachable
  stream (overflow would require ~7.6e290 weighted terms since a rebase). For the
  pathological tail -- a single value within a factor of `exp(40)` of `Double.MAX` --
  the cold query guard fails **closed**: the queries throw `[lite-adaptive]` on a
  non-finite accumulator rather than returning `Infinity`. `count(now?)` / `sum(now?)` /
  `mean(now?)` / `rate(now?)` are cold, O(1), evaluated at an optional query time
  `now >= lastAddNow` (decayed values keep changing as time passes); `mean` is
  landmark-invariant and EXACT.
  Mirrors EH's time model (explicit monotone `now` + a count-mode auto-tick, mode locks
  at the first add). Unlike EH it accepts ANY finite real value (signed included) -- `C`
  and `Sv` are separate, so a signed value gives a proper decayed weighted mean without
  corrupting the decayed count. Fail closed: a bad `halfLife` / option throws before
  allocation, a mode switch / non-finite or decreasing `now` / non-finite value throws
  `[lite-adaptive]` (byte-identical no-op), a query `now` before the last add throws;
  queries never throw on an empty detector (return 0). `rate() = count * lambda` is
  documented as a DEFINITION (decayed events per unit time), not a statistical bound.
  See [`decisions/0004`](./decisions/0004-forward-decay.md).
- **`addFrom(buf, i)`** -- a zero-box hot entry on **`ExponentialHistogram`** and
  **`ForwardDecay`** that reads `now = buf[i]` and `value = buf[i+1]` UNBOXED from a
  caller-owned PACKED `[now, value]` `Float64Array` (a batch steps `i` by 2), then runs the
  IDENTICAL accumulate (merge cascade / expire for EH, the landmark rebase for FD) as
  `add(now, value)`. It unblocks a caller whose `now` AND `value` are both FRACTIONAL doubles
  (e.g. lite-hud's time-window sum/mean/rate, where `now` is a fractional record time the
  caller computes itself): `add(now, value)` boxes each argument into a ~16 B HeapNumber at a
  non-inlined peer call boundary, whereas `addFrom` stays **0 B/op** (torture-gated on both
  members with fractional inputs). EXPLICIT-time only (it always carries a `now`): a
  count-locked instance throws, and the first `addFrom` locks EXPLICIT mode (setting FD's
  landmark). Same fail-closed validation, throws, and byte-identical-no-op-on-reject as
  `add`; a non-`Float64Array` `buf` or a non-integer / out-of-range `i` (needs
  `i + 1 < buf.length`) throws `[lite-adaptive]` typeof-first. EH's `add()` hot body is
  unchanged (the accumulate body is duplicated into `addFrom`, not shared, to avoid a boxing
  call boundary). Same idiom as lite-sketch's `DDSketch.addFrom(buf, i)` (N7).
- **The exact-aggregate witness** (`test/witness.mjs`) -- the honesty anchor unique to
  the decay member: a brute-force oracle stores every `(t, value)` and recomputes the
  decayed aggregate directly at each query, and the gate asserts the incrementally
  maintained result matches it to `<= 1e-9` relative error on every query across a
  `halfLife x stream-shape` sweep (worst observed `6.35e-14` over 5382 queries) -- with
  negative controls (a rebase that omits the `C, Sv` rescale; a detector that never
  rebases and overflows to `Infinity`) that the same gate rejects.

### Changed

- `VERSION` -> `0.3.0` (package.json / `Adaptive.js` / llms.txt trinity); the file
  header documents the three-member roster.

### Fixed

- **llms.txt** now documents all three members: the `ADWIN` export bullet and its API
  detail block were absent at 0.2.0 (the shipped Exports section listed only
  `ExponentialHistogram` + `VERSION`); both are added, alongside the new `ForwardDecay`
  export bullet and API section.

## [0.2.0] - 2026-09-23

The second member -- the marquee one: **ADWIN** (Bifet-Gavalda, SDM 2007), concept-drift
detection with a data-driven adaptive window. Pure append: the `ExponentialHistogram`
class and the M1 substrate are byte-identical; only the file header and `VERSION` change.

### Added

- **`ADWIN`** -- an item-indexed drift detector over its own variance-carrying
  `(sum, sumSq, count)` bucket columns (design-parity with the EH pool, a separate fixed
  pool). `add(x) -> boolean` appends a value, compresses buckets (at most 5 per level),
  scans every bucket-boundary split for a statistically significant mean difference with
  the **ADWIN2 variance-aware bound** at confidence `delta`, and on a detected cut DROPS
  the older sub-window (the adaptive shrink) -- returning `true` on the detecting item.
  Amortized O(1), **0 B/op including the cut-scan and the shrink**. The window GROWS while
  the stream is stable and SHRINKS to the new concept on a change; `mean` / `variance` /
  `width` getters report the current adaptive window. Accepts any finite real; the bound's
  range tracks the running observed `[min, max]`. Fail closed: a bad `delta` throws before
  allocation, a non-finite `x` is a byte-identical no-op, queries never throw. See
  [`decisions/0003`](./decisions/0003-adwin.md).
- **The change-response witness** (`test/witness.mjs`) -- the honesty anchor unique to the
  drift members: against an injected changepoint it gates the stationary false-alarm rate
  `<= delta`, a detection latency that scales with shift magnitude, ~0 missed detections on
  a large shift, and adapted-window correctness -- with negative controls (a bound-disabled
  detector must false-alarm; a no-shrink detector must fail to adapt) that are rejected by
  the same gate.

### Changed

- `VERSION` -> `0.2.0` (package.json / `Adaptive.js` / llms.txt trinity); the file header
  documents the two-member roster.

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
