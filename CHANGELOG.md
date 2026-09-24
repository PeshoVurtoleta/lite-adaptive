# Changelog

All notable changes to `@zakkster/lite-adaptive` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.5.0] - 2026-09-24

The fourth additive post-1.0 member (`SlidingCountMin`), plus a shared fail-closed ctor guard applied
to both windowed-pane members. Six of the prior classes (`ExponentialHistogram`, `ADWIN`,
`ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`, `DriftDetector`) are BYTE-IDENTICAL; the new class
is appended after `SlidingDDSketch`, which itself changes only by the one-line ctor guard below (no
behavior change on any valid input). MINOR bump (new API + a fail-closed hardening, no break).

### Fixed

- **Subnormal-window fail-closed guard on both windowed-pane members** (`SlidingDDSketch` and the new
  `SlidingCountMin`). At an astronomically small window `W` (subnormal range, e.g. `Number.MIN_VALUE`),
  the derived per-pane width `W / panes` underflows to exactly `0`, which would make the pane-boundary
  arithmetic non-finite -- no pane ever "live", so `add` never throws yet a query silently reads empty
  for a value added on the same tick (a silent violation of the one-sided bound). The constructor now
  guards the derived pane width (`paneW > 0 && Number.isFinite(paneW)`) and throws `[lite-adaptive]` at
  construction, before any allocation -- consistent with the suite's fail-closed law. No valid,
  representable `W` is affected (a tiny `W` such as `1e-6` still constructs and works).

### Added

- **`SlidingCountMin` -- windowed per-label frequency** (Cormode-Muthukrishnan Count-Min Sketch over a
  B+1 pane ring; ADR 0010). Answers "how many times did key `k` occur in the LAST W?" in fixed memory
  -- the recency sibling of lite-sketch's cumulative `CountMinSketch`, for lite-hud's per-label rate
  panels. A ring of **B+1 panes** (default `panes` B = 32, so 33 panes), each a `d x w` `Uint32`
  counter grid aligned to absolute time (`pane = floor(now / (W/B))`). The live panes cover a span in
  `[W, W + W/B]` -- always the full window plus at most one extra pane -- and the partially-expired
  oldest pane is **KEPT, never dropped**, so the estimate stays a **one-sided upper bound**:
  `true(W) <= est <= true(W + W/B) + epsilon * N(W + W/B)`. Dropping it would under-count and silently
  break the Count-Min contract.
  - `new SlidingCountMin(W, { epsilon?, delta?, w?, d?, panes?, seed?, conservative? })` -- `W` a finite
    number `> 0` (a `now`-unit span in explicit mode, or items in count mode; **not capped** -- ms /
    epoch-time spans are fine). `epsilon` (default `0.01`) sizes the width `w`; `delta` (default `0.01`)
    sizes the depth `d`; or pass `w` (int `[1, 65536]`) / `d` (int `[1, 32]`) explicitly. `panes` an
    integer `[2, 1024]` (default 32). `seed` a Uint32 (default `0x9e3779b1`; `seed = 0` valid).
    `conservative` (default `true`) enables per-pane conservative update. Throws `[lite-adaptive]`
    typeof-first on a bad arg BEFORE any allocation.
  - `add(now, key, count = 1) -> this` -- HOT, amortized 0 B/op incl. the pane rotate + clear. EXPLICIT
    mode (finite, non-decreasing `now`) or COUNT mode via `add(undefined, key, count)`; the mode locks
    at the first add (a switch throws). `key` a SAFE INTEGER (a composite `channelIdx * 2^32 + tag`
    works, for lite-hud's ONE-shared-instance-across-channels use); `count` a positive integer,
    **saturating at `2^32-1`** (never wraps). Fail closed: a mode switch, a non-finite / decreasing
    `now`, or a non-safe-integer key / non-positive-integer count is a byte-identical no-op.
  - `addFrom(buf, i) -> this` -- HOT, 0 B/op ZERO-BOX entry: reads a packed stride-3 `[now, key, count]`
    from a `Float64Array` UNBOXED (EXPLICIT-time only). Same validation + body as `add`.
  - `advance(now) -> this` + `advanceFrom(buf, i) -> this` -- built in from the start (R11 idle-slide):
    move the reference time forward with NO increment, rotating out stale panes (bounded to B+1 clears),
    so an idle key's `estimate` slides to 0 instead of freezing. HOT, amortized 0 B/op, EXPLICIT-only,
    monotone.
  - `estimate(key, w?) -> number` -- COLD, `O(d * (B+1))`; sums the key's cell across the live panes per
    row THEN takes the min over rows (sum-then-min). Returns a **double** (a window sum can exceed
    `2^32`). **Never throws** -- returns 0 for an unseen / out-of-domain key or an empty window (parity
    with lite-sketch, so it can be swapped in). `w` an optional sub-window in `(0, W]`.
  - `clear() -> this`; getters `d` / `w` / `panes` / `W` / `seed` / `conservative` / `saturated` /
    `epsilon` / `delta` / `lastNow` / `mode` / `bytes`. `saturated` (the count of saturated increments)
    is the honesty flag, like `SlidingHyperLogLog`'s `degraded`.
  - DESIGN PARITY with lite-sketch `CountMinSketch` (inlined, never a dependency): the same two-lane
    seeded hash + row derivation, seed handling, `epsilon` / `delta` sizing, `2^32-1` saturation, and
    the `conservative` option. Counters are `Uint32Array` per pane; memory `(B+1) * d * w * 4 B`, fixed.
    Absolute pane alignment means two same-`(W, panes)` instances align cell-for-cell (forward-compat
    for a future `merge`).
  - WITNESSED (the honesty anchor, ADR 0010): the one-sided bound `true(W) <= est <= true(W + W/B) +
    epsilon * N` on 100% of the sweep + a churny key stream, plus an idle-slide-empties check. Negative
    controls REJECTED by the same gate: a DROP-OLDEST-PANE variant (under-counts, breaks the lower
    bound) and a MIN-THEN-SUM variant (mis-estimates). ADR 0010 records the B+1 / keep-oldest one-sided
    rationale and rejects the per-cell EH ("ECM-sketch", Papapetrou et al. VLDB 2012, ~6 MB) alternative.
- **`VERSION`** is now `'1.5.0'`.

## [1.4.0] - 2026-09-24

The R11 "idle streams must still slide" sweep. **NOT a pure append**: this ADDS methods to three
EXISTING classes. Every existing method + hot body of `ExponentialHistogram`, `SlidingHyperLogLog`,
and `SlidingDDSketch` (ctor, `add`, `addFrom`, `count` / `sum` / `query` / `quantile` /
`quantileInto`, `clear`, all getters) is BYTE-IDENTICAL; the only additions are the two new methods
per class (+ their cold throwers). The four other classes (`ADWIN`, `ForwardDecay`, `HeavyKeeper`,
`DriftDetector`) are BYTE-IDENTICAL. MINOR bump (new API, no break).

### Added

- **`advance(now)` + `advanceFrom(buf, i)` on the three TIME-windowed members** (ADR 0009). A windowed
  query anchored to the last applied time FREEZES while a stream is idle -- `count()` still shows the
  last burst an hour later. `advance(now)` moves the window's reference time forward to `now` WITHOUT
  adding a value, applying the same expiry / rotation `add` would, so a subsequent query reflects the
  window ending at `now` (an idle channel's readout empties instead of lying). Both are HOT, **0 B/op**;
  EXPLICIT-time only (a count-locked instance throws; the first `advance` locks EXPLICIT); monotone (a
  `now` below the last applied time throws `[lite-adaptive]` as a byte-identical no-op); chainable
  (return `this`). `advanceFrom(buf, i)` is the zero-box sibling (reads `now = buf[i]` unboxed for a
  fractional / epoch-ms `now`). Per member:
  - **`ExponentialHistogram.advance(now)`** -- expires buckets older than `now - W` (the expiry half of
    `add`, no bucket opened).
  - **`SlidingHyperLogLog.advance(now)`** -- clock-only (moves the reference time); `count(w?)` already
    lazily expires `stamp <= now - W` relative to it, so the ring is untouched and `overflows` /
    `degraded` are unaffected. O(1).
  - **`SlidingDDSketch.advance(now)`** -- rotates + clears panes as `now` passes their boundaries
    (bounded to `panes` clears), so the quantile / count reflects the window ending at `now`.
- **Excluded, by design (ADR 0009):** `ADWIN` and `DriftDetector` are ITEM-INDEXED (no clock), so
  `advance(now)` is meaningless; `ForwardDecay` already satisfies R11 the other sanctioned way -- its
  `count(now?)` / `sum(now?)` / `mean(now?)` / `rate(now?)` queries take an optional query time and
  stay pure, so no mutating `advance` is added.
- WITNESSED (the honesty anchor, ADR 0009): after a burst then an idle gap, `advance(lastNow + 2*W)`
  empties the window for all three members (`ExponentialHistogram` / `SlidingHyperLogLog` `count()` -> 0,
  `SlidingDDSketch` `count()` -> 0 and `quantile()` -> `NaN`), matching an oracle advanced the same way;
  and `advance(t)` then `add(t, v)` is state-equivalent to `add(t, v)` directly (per SoA column), with
  `advance` idempotent. A negative control -- an `advance` that moves the clock but SKIPS the expiry /
  rotation -- leaves the window frozen and is REJECTED by the same gate.
- **`VERSION`** is now `'1.4.0'`.

## [1.3.0] - 2026-09-24

The third additive post-1.0 member. **PURE APPEND**: the six prior classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`,
`DriftDetector`) are BYTE-IDENTICAL; only the file header and the `VERSION` const change above the
append point. MINOR bump (new API, no break).

### Added

- **`SlidingDDSketch` -- windowed relative-error quantiles** (Masson-Rim-Lee, "DDSketch", VLDB 2019,
  over a fixed-B pane ring; ADR 0008). Answers p50 / p99 / any quantile over the LAST W in fixed
  memory at DDSketch accuracy -- the recency sibling of lite-sketch's cumulative `DDSketch`, for
  lite-hud's M2 windowed percentiles. Window model A (fixed-B pane ring): `panes` preallocated
  DDSketch panes (default 32), each covering `W / panes` of the window; `add` writes the current
  pane, and crossing a pane boundary rotates to the next pane and clears it (a `fill(0)`, 0-alloc; a
  `now` jump of k pane-widths clears `min(k, panes)` panes, never loops unbounded). `quantile` /
  `quantileInto` / `count` merge the live panes into an INSTANCE-OWNED preallocated scratch (cold,
  0-alloc -- never allocated per query). The edge error is disclosed: the window is soft to within
  one pane width `W / panes` (~3% at the default 32), the price of a fixed-memory sliding window
  over an exact O(W) sort.
  - DESIGN PARITY with lite-sketch `DDSketch` (inlined, never a dependency -- the
    `SlidingHyperLogLog` precedent): the SAME mapping `gamma = (1 + alpha) / (1 - alpha)`,
    `key = ceil(log_gamma(v))`, the collapsing-lowest-bins default + a `strict` opt-in, and the
    getters `alpha` / `strict` / `minIndexable` / `maxIndexable` / `collapsed` -- so a consumer
    (lite-hud M2) pre-checks a value's indexable range EXACTLY as it does against lite-sketch. `alpha`
    defaults to `0.01` (1% relative error); `maxBins` per pane is 2048 (`SLD_MAX_BINS`, matching
    lite-sketch's `DD_MAX_BINS_DEFAULT`). Per-pane bin counts are `Uint32Array`, SATURATING at
    `2^32-1` (never wrap); the merge scratch sums panes in `Float64` so a merged window count stays
    exact past `2^32`.
  - `new SlidingDDSketch(W, { alpha?, strict?, panes? })` -- `W` a finite number `> 0` (a `now`-span
    in explicit mode, items in count mode) is the required positional (the `SlidingHyperLogLog`
    `(W, options)` convention; `alpha` is an option here, not the positional it is on lite-sketch
    `DDSketch`); `panes` an integer `>= 2` (default 32). Throws `[lite-adaptive]` typeof-first on a
    bad `W` / `alpha` / `strict` / `panes` / unknown option BEFORE any allocation.
  - `add(now, value) -> this` -- HOT, 0 B/op incl. the pane rotate + clear. EXPLICIT mode (a finite,
    non-decreasing `now`) or COUNT mode via `add(undefined, value)` (auto-tick); the mode LOCKS at
    the first add (a switch throws). Value domain + zero / `-0` / negative policy stated in the SAME
    words as lite-sketch `DDSketch`. Fail closed: a mode switch, a non-finite / decreasing `now`, an
    out-of-policy value, or a value whose bin key would exceed `SLD_KEY_MAX` (`1 << 30`) is a
    byte-identical no-op / throw.
  - `addFrom(buf, i) -> this` -- HOT, 0 B/op ZERO-BOX entry: `now = buf[i]`, `value = buf[i+1]` read
    UNBOXED from a packed `Float64Array` (EXPLICIT-time only). Same validation + body as `add`.
  - `quantile(q, w?) -> number` -- COLD; the windowed quantile for `q` in `[0, 1]` (outside throws),
    over the full `W` or an optional sub-window `w` in `(0, W]` (outside throws). Returns `NaN` on an
    empty window (never 0). `quantileInto(qs, out) -> number` packs several quantiles into a caller
    array, 0-alloc (the render path). `count(w?) -> number` is the windowed population (0 on empty).
  - `clear() -> this` -- 0-alloc reset (reuse the arrays; unlock the mode). Getters:
    `W` / `panes` / `alpha` / `strict` / `minIndexable` / `maxIndexable` / `collapsed` / `mode` /
    `lastNow` / `bytes`.
  - WITNESSED (the honesty anchor, ADR 0008): windowed quantile relative error `<= alpha` vs an
    EXACT windowed-sorted-array oracle on 100% of `>= 2000` queries across a `W` x `alpha` sweep, a
    distribution shift, and a post-burst edge; the edge error bounded by one pane width `W / panes`;
    empty = `NaN` with `count() === 0`. Negative controls REJECTED by the same gate: a NO-EXPIRY
    variant (counts stale out-of-window values) and a `panes = 1` variant (breaks the edge bound).
    ADR 0008 records the fixed-B pane-ring choice and the rejected alternatives -- an EH / DGIM of
    DDSketches (merge-on-add allocates, not 0 B/op) and Arasu-Manku true windowed quantiles
    (unbounded per-item state, not zero-GC) -- plus the pane-boundary collapse subtlety (each pane
    collapses its lowest bins independently, so the merged min-key can differ from a single sketch's;
    the edge bound is witnessed, not assumed).
- **`VERSION`** is now `'1.3.0'`.

## [1.2.0] - 2026-09-24

The second additive post-1.0 member. **PURE APPEND**: the five prior classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`) are
BYTE-IDENTICAL; only the file header and the `VERSION` const change above the append point.
MINOR bump (new API, no break).

### Added

- **`DriftDetector` -- scalar, O(1)-state streaming drift detection** (Page, "Continuous
  Inspection Schemes", Biometrika 1954; Mouss-Mouss-Linkens-Sellami, 2004; ADR 0007). A single
  class over a real-valued signal, selected by a mode const whose REFERENCE is load-bearing --
  `DRIFT_PH` (Page-Hinkley: cumulative deviation of x from the ONLINE running mean, two-sided;
  adaptive) or `DRIFT_CUSUM` (two-sided CUSUM: two accumulators `gP` / `gN`, each floored at 0,
  deviating from a FIXED `target` mu0; classic SPC). The distinct references are deliberate: under
  a shared running-mean reference the two rules collapse to the identical reflected-random-walk
  statistic (CUSUM's `max(0, cumsum)` IS `cumsum` minus its running min, which is what PH computes),
  so PH self-references the online mean while CUSUM references a fixed mu0 -- they genuinely diverge
  (e.g. on a slow ramp PH stays quiet while CUSUM fires continuously). `add(x) -> boolean` updates a
  running mean (Welford), runs the one mode branch, and returns `true` EXACTLY on the detecting item,
  RESETTING the accumulators + running mean so the NEXT shift is caught -- **0 B/op**. It is the
  item-based, scalar, fixed-scalar-state complement to `ADWIN`'s adaptive window: no pool (pure
  scalars, like `ForwardDecay`), no window. Constructor
  `new DriftDetector(mode, { delta?, threshold?, target? })` -- `delta` the magnitude allowance (PH)
  / slack (CUSUM), a finite number in `[0, 1e150]` (default `0.005`; `delta = 0` is a valid setting,
  guarded as `undefined`, not falsy); `threshold` the decision level (PH lambda / CUSUM decision
  interval), a finite number `> 0` (default `50`, tune to the signal scale); `target` the FIXED
  in-control mean mu0 the CUSUM test deviates from, a finite number of any sign, `|target| <= 1e150`
  (`target = 0` valid) -- **REQUIRED for `DRIFT_CUSUM`, FORBIDDEN for `DRIFT_PH`** (a mismatch throws,
  never a silent ignore). `add(x)` accepts a finite real with `|x| <= 1e150` (`DD_X_MAX`, so the
  accumulators cannot silently overflow to a non-finite value -- the `ADWIN` finite-overflow
  lesson). Getters `mode`, `delta`, `threshold`, `target` (the fixed CUSUM mu0; `undefined` for PH),
  `count` (items seen since the last reset), `mean`, `statistic` (the current test statistic; crosses
  `threshold` exactly when `add` fires); `mean` / `statistic` throw `[lite-adaptive]` fail-closed on
  a non-finite accumulator; getters return `0` on empty. Fail closed typeof-first on a bad `mode` /
  `delta` / `threshold` / `target` / option / `x` (a byte-identical no-op). Proven by the torture
  gate (add PH + add CUSUM + addFrom + clear at 0 B/op) and the change-response witness (latency per
  shift magnitude both modes + bounded stationary false-alarm + transient reset discipline + a
  PH-vs-CUSUM mode-divergence gate, plus huge-threshold and no-reset negative controls rejected).
- **`DriftDetector.addFrom(buf, i)`** -- the zero-box hot entry: `x = buf[i]` read UNBOXED from a
  caller-owned `Float64Array` (a fractional `x` boxes as a plain argument at a non-inlined call
  boundary; `addFrom` avoids it -- torture-gated 0 B/op on a fractional drifting stream).
- **`DRIFT_PH` / `DRIFT_CUSUM`** -- the two mode consts (numeric named exports, `0` / `1`).
- **`DriftDetector.target`** -- the getter for the fixed CUSUM in-control mean mu0 (`undefined`
  for PH).

### Note

- **DDM / EDDM are deliberately deferred.** They consume a Bernoulli ERROR-BIT stream (a
  classifier's 0/1 correctness) and emit a TRI-STATE (stable / warning / drift) output -- a
  different contract from a real-valued `add(x) -> boolean`. They belong in a separate future
  member, not in `DriftDetector` (ADR 0007 records the reasoning).

### Changed

- `VERSION` -> `1.2.0` (package.json / `Adaptive.js` / llms.txt trinity); the file header documents
  the six-member roster.

## [1.1.0] - 2026-09-24

The first additive post-1.0 member. **PURE APPEND**: the four frozen core classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`) are BYTE-IDENTICAL; only the
file header and the `VERSION` const change above the append point. MINOR bump (new API, no break).

### Added

- **`SlidingHyperLogLog` -- windowed DISTINCT-count** (Chabchoub-Hebrail, 2010; ADR 0006). How
  many DISTINCT keys arrived in the LAST W, in FIXED preallocated space at HyperLogLog accuracy --
  the RECENCY sibling of lite-sketch's cumulative HyperLogLog. An `m = 2^p` register bank where
  each register keeps a small FIXED LFPM ring (List of Future Possible Maxima) of
  `(timestamp, rho)` entries -- a per-register monotonic deque. `add(now, key)` / the zero-box
  `addFrom(buf, i)` derive register + rho from an inline two-lane hash, drop dominated tail
  entries, and append (0 B/op incl. the windowed eviction); a full ring drops its oldest entry and
  bumps `overflows` (`degraded` -- the honest degradation signal). `count(w?)` lazily expires
  `stamp <= now - W`, takes each register's live-max rho, and runs Ertl's improved estimator
  (design-parity with lite-sketch, inline); standard error `1.04 / sqrt(m)`, guaranteed while not
  degraded; `w` is an optional sub-window in `(0, W]`. Constructor `new SlidingHyperLogLog(W,
  { p?, ringCap?, seed? })`; a caller-supplied monotone `now` or count mode; getters `W`, `p`, `m`,
  `ringCap`, `seed`, `standardError`, `lastNow`, `mode`, `overflows`, `degraded`, `bytes`. Fail
  closed typeof-first on every bad ctor arg / key / now / sub-window (a byte-identical no-op).
  Fully deterministic (no PRNG). Proven by the torture gate (add + addFrom + clear at 0 B/op) and
  the windowed-distinct witness (3-sigma vs an exact Set oracle, `degraded === false`, plus
  no-expiry and no-dominated-drop negative controls rejected).

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
