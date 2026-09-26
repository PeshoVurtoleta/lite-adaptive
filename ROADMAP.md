# lite-adaptive -- roster roadmap (to 1.0.0: ExponentialHistogram -> ADWIN -> ForwardDecay -> HeavyKeeper)

Blueprint: `../LiteSketch/ROADMAP.md` (milestone table, shared law, gate spec, per-member
briefs) and the `../LiteFilter` / `../LiteSketch` cadence (reference member + one per release,
complete at 1.0.0). See `RESEARCH.md` for the identity, the two witnesses (recency error +
change response), the roster rationale (incl. the verdict on the inherited backlog), and the
open questions. ASCII-only (`->`, `<=`, `x`, "epsilon", "alpha", "delta").

> **NEXT (2026-09-24): H1 hardening -- v1.7.0, MINOR, hardening only** (section 7; audit record in
> RESEARCH.md section 13; reproduction + session plan in 7.1 / 7.2). Then 1.8.0 = additive API (S1, S2).
> The 1.6.0 final sweep found 4 High findings the shipped gates pass:
> - `ExponentialHistogram` goes to `count() = NaN` on a dense explicit stream.
> - `SlidingDDSketch` strict mode throws on in-range values.
> - `HeavyKeeper.addFrom` boxes large keys.
> - The perf gate's `maxScavenges: 16` cannot see a 16 B/op box.
> lite-hud M4 (EH) and the HeavyKeeper drop-in wait for this release.

Status (historical; the roster SHIPPED through 1.6.0): PRE-CODE / PROPOSED (2026-09-23). Two calls to SETTLE before M1: the scope/theme (is
this the sliding-window + decay + drift package, with Exponential Histogram as reference?) and
the TIME SOURCE + bucket-pool substrate (ADR 0001). Each milestone is then a full pipeline
session (planner -> settle -> coder -> reviewer -> qa); the maintainer commits/publishes;
/release gate + catalog card sync after, exactly as lite-sketch.

## Milestones

| # | Member | Version | Headline (space, error, recency model) | Status |
|---|--------|---------|----------------------------------------|--------|
| **M0** | Package scaffold + the TIME SOURCE + the fixed bucket-pool substrate + the two-witness chassis | 0.1.0 (with M1) | caller-supplied monotone `now`; preallocated bucket pool; windowed + change-response witnesses | SHIPPED 0.1.0 (ADR 0001) |
| **M1** | **ExponentialHistogram** (sliding-window count / sum) | 0.1.0 | `O((1/epsilon) log W)` buckets -> `<= epsilon` windowed error; HARD last-W window | SHIPPED 0.1.0 (reference member, ADR 0002) |
| **M2** | **ADWIN** (drift detection + adaptive window) | 0.2.0 | EH-bucket list -> false-alarm `<= delta`; ADAPTIVE data-driven window | SHIPPED 0.2.0 (the marquee member, ADR 0003) |
| **M3** | **ForwardDecay** (time-decayed count / sum / mean / rate) | 0.3.0 | landmark + O(1) accumulators -> EXACT decayed aggregate; DECAY half-life model | SHIPPED 0.3.0 (ADR 0004) |
| **M4** | **HeavyKeeper** (decayed / windowed heavy hitters, top-k) | 0.4.0 | d x w table + top-k forest -> bounded overestimate, strong on skew; DECAY model | SHIPPED 0.4.0 (ADR 0005) |
| -- | **1.0.0** -- API declared STABLE at four members | 1.0.0 | reference + 3, the lite-sketch cadence | SHIPPED 1.0.0 (API freeze) |
| M5+ | SlidingHyperLogLog (1.1.0), DriftDetector (Page-Hinkley/CUSUM, 1.2.0), SlidingDDSketch (windowed quantiles, 1.3.0), advance()/idle-slide (1.4.0), SlidingCountMin (windowed Count-Min, 1.5.0), DecayedReservoir (1.6.0) | post-1.0 | SHIPPED, one per release (RESEARCH.md Tier 2); DDM/EDDM still deferred | SHIPPED through 1.6.0 |

Re-routed OUT of this package (see RESEARCH.md 4.0): KMV/MinHash + CountSketch -> lite-sketch
post-1.0 (cumulative, no recency). Exact windowed monoid folds -> lite-o1 (already shipped).

## 0. Preflight -- new-package scaffold (do once, with M0/M1)

A NEW package, so M1 stands up what lite-sketch already has:
- `package.json` (`@zakkster/lite-adaptive`, `type: module`, `sideEffects: false`, `files:
  [Adaptive.js, Adaptive.d.ts, llms.txt, CHANGELOG.md, README.md]`, node >= 18, MIT (c) Zahary
  Shinikchiev <shinikchiev@yahoo.com> -- NEVER "Karadjov"), zero deps.
- Single PascalCase main file `Adaptive.js` (each member a class appended -- the byte-identical
  append discipline) + `Adaptive.d.ts` + `llms.txt` + `README.md` (modeled on
  `../LiteSepforge/README.md`, the suite standard) + `CHANGELOG.md`.
- `test/` (node:test only), `test/witness.mjs` (BOTH the windowed-accuracy witness AND the
  change-response witness), `test/torture.mjs` (lite-leak + lite-gc-profiler 0-B/op gate,
  including the bucket merge/expire paths), `test/perf/PerfGate.test.mjs`, `benchmark/`.
- The TIME SOURCE + the fixed bucket-pool substrate land in M0 (part of the M1 session), gated
  before any member.
- `VERSION` const in `Adaptive.js`, kept in sync with package.json + llms.txt (the three-site rule).

## 1. Shared law (every member)

- Zero runtime deps. `node:test` only. ASCII-only source (U+00D7 and U+00B5 excepted).
- Single PascalCase main file, pure APPEND per member (prior members byte-identical; only the
  header + VERSION change). `sideEffects: false`, tree-shakeable.
- Zero allocation on every hot path (`add` / `update` / `tick` / `query`) INCLUDING the amortized
  reshaping (bucket merge, bucket expire, window shrink). Flat TypedArray pools + a free-list,
  no per-op objects/closures. The reshaping is the family's amortized-honesty spike -- the
  witness must show it is 0 B/op AND amortized O(1).
- Fail closed on every unverified state: a bad W/epsilon/delta/half-life at construction throws
  `[lite-adaptive]` typeof-first, BEFORE allocation; a non-monotone `now` throws; queries never
  throw; null is not zero.
- The headline is a TRIPLE (space, error, recency model). Hard-window vs decay vs adaptive is
  stated. Drift is a disclosed trade (false-alarm rate + latency + min detectable shift), never magic.
- The time source is caller-supplied and monotone; the member NEVER reads the wall clock itself.
- DESIGN-PARITY, never a dep: reuse lite-o1 / lite-sketch idioms by copying the technique.
- ZERO-BOX ENTRY POINT (added 2026-09-23; lesson from lite-hud M2 + lite-sketch 1.1.0). Timestamps
  and values here are FRACTIONAL doubles (`performance.now()`, latencies). V8 boxes a fractional
  double passed as an ARGUMENT to a call it does not inline (~16 B HeapNumber per call), and a
  cross-module, polymorphic consumer never gets inlining. measureAllocs cannot see it (transient),
  and integer test inputs hide it (Smi). Measured on DDSketch.add: a consumer-computed value went
  from 24 to 43 scaling scavenges. Every member with a double-taking hot method ships an
  `addFrom(buf, i)` sibling from day one (it reads `buf[i]` from a caller-owned Float64Array: same
  validation, same throws), as DDSketch did in lite-sketch 1.1.0 -- do not retrofit it later.
- CONFIG + STATE GETTERS (lesson from the lite-sketch N1 / lite-filter N2-N3 audits). Every
  construction knob (W, epsilon, delta, half-life, pool size, any strict/bounded mode) and the live
  state a consumer must pre-check (bucket count, pool headroom/saturation, last `now`, the monotone
  floor a new `now` must meet) is a public O(1), 0-alloc getter. A consumer must NEVER learn
  configuration by catching an error and sniffing its class, and never needs a "size vs capacity"
  heuristic for headroom.

## 2. Design calls to settle FIRST (from RESEARCH.md section 8 + 11)

- **ADR 0001 -- the TIME SOURCE + bucket-pool substrate** (blocks everything): a caller-supplied
  monotone `now` (logical tick or ms; count-based convenience for "last N items"); a preallocated
  fixed bucket pool sized to the theoretical bucket bound with a free-list; NO internal clock read.
- **Per-member**: EH bucket-merge rule + epsilon; ADWIN's delta + the cut test on the EH buckets;
  ForwardDecay's decay function (exponential half-life default) + landmark rebasing; HeavyKeeper's
  decay base + d x w sizing + the top-k min-forest (design-parity with lite-o1 FreqO1).
- Distinct classes (not one uniform surface) -- members answer different questions and carry
  different recency models (RESEARCH.md Q3).

## 3. Gates -- what "proven" means (shared spec)

### 3.1 The windowed-accuracy witness (`test/witness.mjs`)
Drive the member on an evolving stream with an exact windowed/decayed oracle; measure error; GATE
vs the theoretical bound:
- EH: windowed count/sum relative error `<= epsilon` on EVERY query (hard). Foil: the exact ring
  of the last W, memory O(W) vs EH's O((1/epsilon) log W).
- SlidingHLL: windowed cardinality within ~3 sigma of `1.04/sqrt(m)`.
- ForwardDecay: decayed aggregate matches the exact decayed accumulator within FP tolerance.
Print MEASURED vs THEORETICAL + the accuracy/space curve + the space-vs-oracle bar.

### 3.2 The change-response witness (`test/witness.mjs`, the drift members)
Inject a KNOWN changepoint; measure detection latency, false-alarm rate, missed-detection rate,
and adapted-window correctness. GATE: false-alarm rate `<= delta` on a stationary run; detection
latency below a shift-magnitude-scaled bound; big shifts never missed. Print a true-vs-detected
changepoint timeline.

### 3.3 The torture gate (`test/torture.mjs`)
`node --expose-gc test/torture.mjs` (lite-leak + lite-gc-profiler): 0 B/op on `add`/`update`/`tick`
INCLUDING the bucket merge/expire and window-shrink paths; retained-growth 0; gc major 0 over the
measured window. "ok" or it is not done.

### 3.4 The perf gate (`test/perf/PerfGate.test.mjs`)
`add`/`tick` throughput flat (the amortized-O(1) claim, incl. reshaping) + a MUST-allocate control
the gate catches.

### 3.5 The benchmark matrix (`benchmark/`)
Recency-error-vs-space, error-vs-W, change-response (latency + false-alarm vs shift), error-vs-skew
+ drift, throughput, space-vs-oracle. MEASURED vs THEORETICAL reported together.

### 3.5b The fractional-input scaling lane (added 2026-09-23; applies to 3.3 + 3.4)
The torture measureAllocs lane alone is not proof: it cannot see transient allocation. For every
hot method, run a zgcSuite scaling lane (`--max-semi-space-size=4`, lo vs hi N) driven by
FRACTIONAL timestamps and values from a `performance.now()`-like source, through BOTH the
`addFrom(buf, i)` path and the plain `add(t, v)` path, next to a no-op baseline:
- `addFrom` scaling == baseline scaling (delta 0). This is the zero-GC claim for real inputs.
- `add(t, v)` with a consumer-computed fractional value MUST show the box. This is the control
  that proves the lane has teeth.
- Integer inputs still read 0.
- `maxScavenges` is a TRUE 0 on the gated lanes (lite-filter's standard). A tolerated floor (like
  lite-sketch's 64) needs a measured, written, per-lane reason.

### 3.6 The control (fail-path)
A bad construction param throws before allocation; a `now` going backwards throws; a degenerate /
stationary stream produces no false drift beyond `delta`.

## 4. Session order

ADR 0001 (time source + bucket substrate) -> M1 ExponentialHistogram (+ scaffold + both witnesses +
torture/bench chassis) -> M2 ADWIN (drift, on the M1 buckets) -> M3 ForwardDecay (decay axis)
-> M4 HeavyKeeper (decayed top-k) -> 1.0.0 (declare API stable) -> post-1.0 backlog one per release.
M1 is the heaviest (it builds the package + the substrate); M2-M4 are appends onto a proven chassis
(M2 especially reuses M1's buckets).

## 5. The briefs

### M1 -- ExponentialHistogram (v0.1.0) -- the reference member
- PURPOSE: count / sum over the last W (sliding window) in fixed memory. A preallocated pool of
  (timestamp, size) buckets grouped by level; bucket count bounded by O((1/epsilon) log(epsilon W)).
- HOT PATH: `add(now)` / `add(now, value)` = open a size-1 bucket; merge the two oldest at a level
  when more than `k = ceil(1/(2 epsilon)) + 1` share it (bounded cascade, amortized O(1), 0 B/op);
  expire buckets older than `now - W`.
- COLD: `query()` = sum live bucket sizes minus half the straddling oldest (O(buckets), disclosed
  co-headline, NOT per-add). `clear()`, getters `windowSize` / `epsilon` / `bucketCount`.
- FAIL CLOSED: bad W/epsilon throws `[lite-adaptive]` before alloc; `add` rejects a non-monotone
  `now`; `query` never throws.
- WITNESS: windowed count error `<= epsilon` vs the exact-ring oracle over a W-sweep + a shifting
  stream; error shrinks as epsilon tightens. Torture: `add` + the merge/expire cascade 0 B/op.
- NON-GOALS: no unbounded per-op memory (the pool is fixed); DGIM (0/1 stream) is the `value=1`
  special case, noted in the ADR, not a separate member.
- DONE WHEN: EH + scaffold + BOTH witness modes + torture "ok" (0 B/op incl. reshaping) + bench +
  README + ADR 0001 (time source + substrate) + ADR 0002 (EH) + /release 0.1.0 clean.

### M2 -- ADWIN (v0.2.0) -- the marquee member
- PURPOSE: detect distribution drift with NO fixed window size, and expose the current stable
  window's mean. Maintains an EH-style bucket list (reuse the M1 substrate) of recent values.
- HOT: `add(x)` -> boolean (drift detected?) -- append to the buckets, then test every bucket
  boundary split for a statistically significant mean difference (Hoeffding-style bound at
  confidence `delta`); on a detected cut, DROP the older sub-window (the adaptive shrink).
  Amortized O(1) (bounded bucket count), 0 B/op.
- COLD/getters: `mean` / `width` (current window size) / `variance`; `clear()`.
- WITNESS: the change-response witness -- false-alarm `<= delta` on stationary streams; detection
  latency scales with shift magnitude; the adapted window reflects the new concept only.
- NON-GOALS: no fixed-threshold detection (that is the scalar `DriftDetector`, Tier 2); ADWIN's
  whole point is the data-driven window.

### M3 -- ForwardDecay (v0.3.0)
- PURPOSE: time-decayed count / sum / mean / rate, recent weighs more, WITHOUT the numeric drift
  of backward decay (Cormode et al. forward-decay: weight by `g(t - L)` from a landmark L).
- HOT: `add(now, value)` = accumulate `value * g(now - L)` and the decayed count -- O(1), 0 B/op.
- COLD: `count()` / `sum()` / `mean()` / `rate()` evaluated at a query time; landmark REBASE when
  the decayed weights grow large (a bounded, disclosed O(1)-amortized renormalize -- the honesty
  spike). Exponential decay (half-life) default; polynomial noted.
- WITNESS: the decayed estimate matches an exact decayed accumulator within FP tolerance (EXACT
  aggregate mode -- a different, honest witness than EH's approximate bound).
- NON-GOALS: no per-key decay here (that is HeavyKeeper); this is the scalar decayed aggregate + the
  base others reuse.

### M4 -- HeavyKeeper (v0.4.0)
- PURPOSE: decayed / windowed heavy hitters (top-k right now), far lower error than Space-Saving on
  skewed / evolving streams. A d x w table of (fingerprint, count) with PROBABILISTIC exponential
  decay of a counter on a fingerprint miss, plus a top-k min-forest (design-parity with lite-o1
  FreqO1 -- never a dep).
- HOT: `add(key)` = hash to d cells, decay-or-increment per the HeavyKeeper rule, maintain the
  top-k forest -- amortized O(1), 0 B/op. `topK()` (O(k)), `estimate(key)`.
- WITNESS: recall of the true current top-k above the threshold; bounded overestimate; measured
  lower error than a Space-Saving baseline on a Zipfian + drifting stream.
- NON-GOALS: no exact top-k (impossible in sublinear space); no cumulative-only mode (that is
  lite-sketch Space-Saving).
- CONSUMER REQUIREMENTS (lite-hud M3 drop-in, settled with the maintainer 2026-09-23):
  1. WEIGHTED add: `add(key, weight = 1)`, where weight is a positive integer (lite-hud passes
     integer MICROSECONDS so it can rank by total time; weight 1 is classic HeavyKeeper). The decay
     rule for a weighted miss must be written down in the ADR (e.g. decay applied per weight unit,
     or once with probability b^-count). The witness covers both weighted and unit streams.
  2. ZERO-BOX entry from day one: `addFrom(buf, i)` reads key = buf[i] and weight = buf[i+1]. A u32
     tag id >= 2^31, or a key read from a Float64Array, can box as a plain argument (LiteLru
     RESEARCH 9 measured an integer below -2^30 boxing). The scaling lane drives keys near 2^31 and
     2^32-1, plus large weights.
  3. ALLOC-FREE read: `forEach(fn)` over the top-k set (or `topKInto(buf)`). `topK()` may allocate
     (COLD), but the HUD render never calls it.
  4. SEEDED internal PRNG for the probabilistic decay (a Uint32 xorshift state, `seed` option +
     getter), never Math.random. This gives a reproducible witness and a deterministic demo.
  5. Documented key domain (safe integer) + fail-closed throws, so a consumer can pre-check without
     try/catch. Getters: d, w, k, decay base b, seed, and a memory figure. `estimate(key)` never
     throws. `clear()` is 0-alloc. `merge` is optional (lite-hud does not rotate HeavyKeeper).
- lite-hud M3 ships on lite-sketch SpaceSaving first and injects HeavyKeeper later as a duck-typed
  drop-in. HeavyKeeper does NOT block M3.
- BEFORE 1.0.0 (the API freeze): add `ADWIN.addFrom(buf, i)`. ADWIN 0.2.0 has only `add(x)` with a
  fractional x, which boxes. lite-hud M6 drift markers feed it HUD-computed durations. It is
  additive, but it belongs in the frozen surface.
- After M4: declare 1.0.0, API stable; post-1.0 backlog (SlidingHLL, scalar DriftDetector, decayed
  Reservoir, windowed Count-Min / quantiles), one per release.
- POST-1.0: every member is bound by section 6 (shared requirements R1-R10 + a per-member
  checklist). Read it before the member's planner session.

---

## 6. Post-1.0 members -- requirements + warnings (added 2026-09-23)

Source: the 2026-09-23 audits of lite-hud M2, lite-sketch, lite-filter and lite-lru (the evidence is
in RESEARCH.md section 12). The first consumer is lite-hud, which waits for these members before
its later sessions. Each member's planner copies R1-R10 into its brief as gates.

### 6.1 Shared requirements (every post-1.0 member)

- **R1 Zero-box entry.** `addFrom(buf, i)` with a FIXED, documented layout (now, then key or value,
  then count where one applies). It is the same validation and the same throws as `add`. The plain
  `add(...)` stays, and it is the lane's CONTROL: it must show the box on fractional inputs.
- **R2 Realistic magnitudes in the scaling lane** (3.5b, extended):
  - `now` at both performance.now() scale (~1e3-1e7, fractional) and epoch-ms scale (~1.7e12,
    fractional);
  - keys near 2^30, 2^31, 2^32-1, -2^31 and 2^53-1, and keys read back from a Float64Array;
  - counts near 2^30.
  Small-integer-only lanes are not evidence. lite-lru 1.18.0 passed every gate and still boxed on
  TTL `put` with an epoch clock.
- **R3 Polymorphic warm-up.** Run each ON lane in a process where a differently-configured instance
  of the same class (and a sibling member) ran first. V8 inlines a helper only while its call site is
  monomorphic. Never RETURN a computed double from a hot-path helper: compute it inline, or write it
  to a typed-array slot (lite-lru A1).
- **R4 Monotone-time contract a consumer can pre-check.** `lastNow` is a getter. A decreasing `now`
  throws (the existing law). The ADR states what a consumer does when its clock jumps back: lite-scope
  `setClockOffset` and OP_EPOCH do exactly that, and lite-hud calls `clear()` on an epoch. Also
  settle whether `now - W` stays exact at epoch-ms magnitude with microsecond detail (2^53 ~ 9.0e15).
- **R5 NaN fails closed by construction.** Write comparisons so NaN lands on the rejecting side
  (`!(x < bound)`, not `x >= bound`). Validate every computed stamp or threshold, not only inputs
  (lite-lru A6: a NaN clock meant "never expires").
- **R6 Every door is the same door.** Static factories (`withError`, `withAccuracy`, ...) and any
  wrapper that rebuilds an options object run the SAME unknown-option check, with its did-you-mean
  hint (lite-lru A4: a DirectLru typo silently disabled TTL). A `restore`/`fromJSON`, if one ever
  ships, validates like the constructor: unique keys, typed stamps, and `null` rejected (lite-lru
  A3/A5).
- **R7 Allocation-free readers.** Any result a consumer reads at 10-15 Hz has a `forEach(fn)` or an
  `xxxInto(buf)` form. The array-returning form may exist but is COLD and documented as allocating.
  A query that EXPIRES state is a mutation: say so in the docs (lite-lru A11: "has/peek cannot
  mutate" was false under TTL).
- **R8 Getters for every knob and all pre-checkable state:** window, epsilon or alpha, pool/ring
  capacity, saturation/overflow counters, seed, `lastNow`, and a memory figure. A consumer never
  learns configuration by catching an error.
- **R9 Seeded randomness.** Any randomized member (HeavyKeeper, the reservoir) uses an internal
  Uint32 PRNG with a `seed` option and getter, never Math.random. The witness and the demo must be
  reproducible.
- **R11 Idle streams must still slide.** A windowed query that expires relative to `lastNow`
  FREEZES while the stream is idle: SlidingHLL.count() still shows the last burst an hour later.
  Every windowed member (SlidingHLL, Windowed Count-Min, sliding quantiles, EH) needs a way to move
  time without an item: either `advance(now)` (0-alloc, the same monotone check, also has an
  `advanceFrom(buf, i)`) or an optional `now` on the cold query. Lean: `advance(now)`. It keeps
  queries pure (R7) and is additive to the shipped members. lite-hud calls it at render with the
  latest record time, so an idle channel's readout decays to empty instead of lying.
- **R10 The space triple in the README memory table:** bytes at the default AND at a
  consumer-realistic size (lite-hud: per channel x ~10-50 channels). A member whose default costs
  more than ~64 KB per instance says so in its headline.

### 6.2 Per-member checklist

**SlidingHyperLogLog** (Chabchoub-Hebrail; fixed per-register ring)
- `addFrom(buf, i)`: now = buf[i], key = buf[i+1] (safe integer). Use the SAME key domain, hash and
  default seed as lite-sketch `HyperLogLog`, so a consumer can cross-check windowed against
  cumulative.
- The ring bound is the zero-GC trade. A ring overflow must be COUNTED (an `overflows` getter) and
  the estimate flagged as degraded. Never drop silently (null is not zero).
- MEMORY WARNING: m x ringCap x (8 B stamp + 1 B rho). p=12 with ring 8 is ~288 KB per instance.
  Disclose it and pick a consumer-friendly default (p=10 with ring 8 is ~72 KB). If stamps are
  stored relative to a landmark in a narrower type, prove the precision at epoch-ms scale (R4).
- `count(w?)` answers any w <= W (cold, never throws, 0 on empty). Say whether the query expires
  registers (R7).
- Witness: within 3 x (1.04/sqrt(m)) of an exact windowed Set, including right at the window
  edge and just after a burst of expiries.

**DriftDetector** (scalar Page-Hinkley / CUSUM, REAL-valued x). lite-hud M6 uses it.
- The input is a finite real x. DDM/EDDM (the Bernoulli error-rate stream) are split out into their
  own contract, below.
- `addFrom(buf, i)` returns a boolean (drift), matching ADWIN. Getters: `lastDriftIndex` and the
  warm-up count.
- State the post-alarm semantics (auto-reset vs sticky until `clear()`). Page-Hinkley keeps
  alarming if it is not reset, and a HUD marker must fire ONCE per regime change.
- State the direction: one-sided up by default (the HUD watches latency regressions), with a
  two-sided option.
- Item-indexed, no clock. The docs say that a consumer with irregular cadence gets item-latency,
  not time-latency.
- Witness (3.2): the stationary false-alarm rate and the step-change detection delay as NUMBERS,
  beside ADWIN on the same streams.

**Decayed Reservoir** (SHIPPED as `DecayedReservoir`, 1.6.0) and **DDM/EDDM error-rate detector** (still deferred; NO lite-hud demand)
- Neither is a lite-hud requirement. The HUD never samples: its panels are aggregates. Its only 0/1
  stream (budget verdicts) is served by ADWIN.
- If either ships, the shared rules R1-R10 still apply, plus:
  - Reservoir: a Float64Array of samples plus an optional id column, and NEVER caller objects
    (retention). R9 seeded PRNG. `size` vs `capacity` getters, with empty reading as size 0.
    `forEach`/`copyInto` readers.
  - DDM/EDDM: a tri-state result (none / warning / drift) through a `state` getter. The input is
    strictly 0/1: a 0.5 throws, never a silent round.

**Windowed Count-Min** (SHIPPED as `SlidingCountMin`, 1.5.0; design suggestions from the lite-hud side)
- REJECT an EH per cell. That is the "ECM-sketch" (Papapetrou et al., VLDB 2012), and it costs
  d x w x EH_CAP x 16 B: ~6 MB at d=4, w=1024, eps 0.1, W 1e4. Record it in the ADR as the
  rejected alternative, as ADR 0006 did for panes.
- PANES, with B+1 of them. Pane width is W/B. The query covers the live panes, so the covered span
  is in [W, W + W/B]: it ALWAYS covers the full W, with at most one extra pane. INCLUDE the
  partially-expired oldest pane, never drop it. Then the estimate stays a ONE-SIDED upper bound,
  the Count-Min property:
      true(W) <= est <= true(W + W/B) + epsilon * N(W + W/B)   (with prob >= 1 - delta)
  Dropping the oldest pane would under-count, which silently breaks the one-sided contract.
- Query = for each row, SUM the key's cell across the live panes, then MIN over rows (sum-then-min,
  not min-then-sum). O(d x (B+1)), COLD.
- ABSOLUTE pane alignment: pane = floor(now / paneWidth). Two instances with the same W/B then
  align, so `merge` is an element-wise saturating add. Compute the pane index INLINE in add (R3:
  never return the double from a helper).
- BOUNDED ROTATION (a real trap). When `now` jumps k panes ahead, clear min(k, B+1) panes, never
  loop k times. An epoch-ms jump or an idle hour must cost O(B x d x w) at most. A single rotation
  is an O(d x w) `fill(0)` spike inside add: disclose it as amortized, and give a timing gate for a
  1e12 jump.
- Counters: Uint32 per pane, SATURATING at 2^32-1, exactly like lite-sketch CountMinSketch. A window
  sum can pass 2^32, so return it as a double. A `saturated` getter (count of saturated
  increments) is the honesty flag, like SlidingHLL's `degraded`.
- Conservative update is PER PANE: min over the CURRENT pane's d cells. A sum of per-pane
  overestimates is still an overestimate, and it stays O(d). Do not run CU over window sums
  (O(d x B) per add). This is an option matching lite-sketch (`conservative`).
- Hash + seed + row derivation IDENTICAL to lite-sketch CountMinSketch. That gives the witness a
  DIFFERENTIAL gate with teeth: with every add inside one window (or W = Infinity in count mode),
  `estimate` must EQUAL lite-sketch's CMS on the same stream, key for key (lite-sketch as a
  devDep). It also makes the two swappable for a consumer.
- Surface, following SlidingHLL:
  - `addFrom(buf, i)`: now = buf[i], key = buf[i+1], count = buf[i+2], matching SlidingHLL's
    (now, key) with the count appended.
  - `add(now, key, count = 1)`.
  - EXPLICIT and COUNT modes, locked at the first add.
  - `estimate(key, w?)`: w is rounded UP to whole panes (disclose this); never throws; 0 when not
    seen.
  - `total(w?)`: the exact windowed N from a Float64 total per pane. The consumer needs it for the
    epsilon x N bound.
  - `merge(other)`: same d / w / seed / W / B, else throw.
  - `clear()`.
  - Static `withAccuracy(epsilon, delta, W, options?)` through the same option door (R6).
  - Getters: W, B, paneWidth, d, w, epsilon, delta, seed, conservative, lastNow, mode, saturated,
    bytes.
- Memory: (B+1) x d x w x 4 B + (B+1) x 8 B. The default is B=8, d=4, w=1024, about 147 KB. Show a
  row for a smaller consumer size too (R10).
- Witness:
  - Against an EXACT windowed Map oracle: est >= true(W) on 100% of queries. est <= true(W + W/B)
    + eps x N on >= (1 - delta) of queries.
  - The differential gate against lite-sketch.
  - Negative controls, each rejected: an EXCLUDE-oldest-pane variant (undercounts, fails the
    one-sided gate), a NO-ROTATION variant (stale counts), and an UNBOUNDED-jump variant (fails
    the timing gate).
  - R2 scaling lane: epoch-ms now, keys near 2^53, counts near 2^30.
- NON-GOAL: heavy hitters or top-k from the CMS (it keeps no key identities; that is HeavyKeeper).

**Sliding-window quantiles** (pane-based DDSketch; Arasu-Manku only if zero-GC is proven)
- The SAME mapping and accuracy contract as lite-sketch DDSketch: alpha, gamma, the collapsing lowest
  bins, and the getters `alpha`, `strict`, `minIndexable`, `maxIndexable`, `collapsed`. A consumer
  pre-checks exactly as lite-hud M2 does. Any divergence in the accepted band is a breaking surprise.
- `addFrom(buf, i)`: now = buf[i], value = buf[i+1]. State the policy for zero, -0 and negatives
  in the same words as DDSketch.
- An empty window reads NaN with n = 0, never 0. `quantileInto(qs, out)` or a single-q `quantile`
  answers at render without allocating.
- The pane merge is O(B x bins) at query (cold, disclosed). Memory B x maxBins x 8 B (+ a scratch).
- lite-hud replaces its M2 A/B only if this member offers more: a pane granularity finer than
  W/2 and a stated edge error.

**HeavyKeeper** (0.4.0): see the M4 brief. Weighted `add(key, weight)`, `addFrom`, `forEach`, a
seeded PRNG, getters, a 0-alloc `clear`, and `merge` optional. **ADWIN.addFrom** lands before
1.0.0.

---

## 7. H1 hardening -- v1.7.0 (final-sweep audit of 1.6.0, 2026-09-24)  [IN PROGRESS -- 1.7.0]

Baseline at audit (d37b271): `npm test` 368/368, `test:perf` 28/28, torture `ok` (exit 0), and
every torture lane prints 0 B/op. Two parallel read-only audits covered (a) allocation + gate
honesty and (b) fail-closed + correctness + doc truth. The evidence is in RESEARCH.md section 13.
H1, H2, M1 and A1 were re-run independently and reproduced.

**Fixes (F)**

| id | finding | task | falsifiable gate |
| --- | --- | --- | --- |
| F1 | H1 (H) EH explicit mode: the merge cascade writes past the last level (`Adaptive.js:255`, `:443`, `:565`; typed-array OOB writes are silently ignored). Buckets are orphaned, and `count()` / `sum()` return NaN from ~6-7 events per time unit, e.g. `EH(10, .1)` NaN at add 43. The README quick-start `EH(60000, .01)` at 8 kHz hits it. The "overflow throw" described in ADR 0001 fires only later, as "this is a bug". | Check `nl >= levels` BEFORE any state change and throw a tagged error (a byte-identical no-op). Size levels for the full range (settle S3: 53 levels) or add a `maxCount` option. | `EH(1000, .01)` at 10 kHz for 70 s: `count()` never NaN. Each count is within eps of a deque oracle, OR a tagged throw with the state snapshot unchanged. |
| F2 | H2 (H) SlidingDDSketch `strict`: the first value sits at the TOP bin (`:3798`, `:3830`), so any larger in-range value throws "would collapse" (`add(0,1); add(1,1.05)` throws). The meaning also differs from lite-sketch DDSketch, where strict = a declared range. | Anchor so that a throw happens only when mass would really be lost. Align the meaning with lite-sketch DDSketch (declared range + `strict` / `minIndexable` / `maxIndexable` getters with the same accepted band). | Strict with values 1, 1.05, ... up to 1e3 (within the bin budget) accepts every add. One value that forces a real collapse throws. A cross-check shows the getters' band equals lite-sketch DDSketch's for the same alpha. |
| F3 | A1 (H) `HeavyKeeper.addFrom` boxes: key >= 2^31 or 2^53-1 gives 12 scavenges at 8N (16 B/op), key <= -2^31 gives 25, weight near 2^30 gives 15. Fresh and warm. The key passes through non-inlined `hkHash` (`:1761`), `_promote` (`:2007`/`:2066`) and `_mapFind`/`_mapSet`/`_mapDel` (`:2168-2280`), and `hkMapHash` returns `>>> 0` (`:1785-1795`). Re-measured independently: small keys 1->2, keys >= 2^31 5->27. | Pass the key and estimate through Float64Array slots (a module `HK_KIN[0]`, `this._kslot`), and have `hkMapHash` return `\| 0`. The audit's scratch patch measured 0/0 with the plain-add control still at 12 and identical `topK`. | The N3 matrix row for HK equals baseline for all 6 key classes and weights near 2^30, fresh and warmed. |
| F4 | A2 + A3 (H) the perf gate's `maxScavenges: 16` (`PerfGate.test.mjs:775`) passes a known 16 B/op lane (12). The fractional drivers box in the HARNESS (`t += 1.5` in a local), which is why a floor was needed. At 0, FD addFrom (6), HK addFrom (12) and DR add (1) fail. | Keep driver clocks and keys in a Float64Array slot, then set `maxScavenges: 0`. Any remaining floor is per lane, measured, and reasoned in writing (ROADMAP 3.5b). | N1 (below) fails at 0. Every shipped lane passes at 0 after F3/F5. |
| F5 | A5 (M) SlidingDDSketch queries allocate: `_merge(this._now - effW)` passes a computed double (`:3961`/`:3982`) and `out[j] = this._walk(q)` returns a computed double (`:3983`). `quantileInto` (3 qs) is ~64 B/call and `quantile` ~32 B/call. The docs say 0-alloc. | Write the cut into a slot and add `_walkInto(qs, out, j)` returning void. The scratch patch measured `quantileInto` 24 -> 0 with byte-identical output. `quantile()` keeps its one boxed return (16 B/call): document it and point to `quantileInto`. | The N4 query lane shows `quantileInto` at 0, fresh and warmed. |
| F6 | A6 (L) returned doubles box: EH `sum()`, SCM `estimate` >= 2^31, HK `estimate` after warm-up, each 16 B/call. llms.txt:686 claims 0-alloc. | Document them as "one boxed return per call", or add `Into` forms (R7). | The docs state it, or an `Into` lane is at 0. |
| F7 | M1 (M) SlidingDDSketch keeps B panes and DROPS up to one pane EARLY (under-coverage). The README (275), ADR 0008 (30-31) and the class comment (`:3343`) say the straddling pane is "counted in full". Against a true `(now-W, now]` oracle, 172 of 1053 quantile queries are beyond alpha (worst 50x), and `add(10,5); advance(105)` with W=100, B=2 reads count 0. The witness oracle `sldDrive` is pane-aligned, so it has the same bug. | Use B+1 panes as SlidingCountMin does, so the covered span is [W, W+W/B]. Switch the witness oracle to the TRUE window. | Against the true-window oracle, `count() >= true` on 100% of queries and quantiles are within alpha of the covered span. A B-pane control variant fails. |
| F8 | M2 (M) `SlidingHyperLogLog.count()` destructively expires ring entries (`:2788-2789`, `:2661`), so `overflows` / `degraded` depend on query frequency (2694 vs 162 on the same stream). llms.txt:789 and ADR 0009 say queries are PURE. | In the add push, drop expired heads first (`stamp <= t - W`) and count an overflow only for an in-window drop. Make `count()` non-destructive. | Two instances, one queried and one not, have equal `overflows`. A ring snapshot is unchanged across `count()`. |
| F9 | M3 (M) ADWIN false alarms at large offsets: variance is computed as E[x^2] - mean^2 (`:975-981`, `:1171`). Stationary N(0,1): 0 alarms at offset 0, 18 at 1e9, 66 at 1.7e12 (variance reads 0). | Per-bucket variance with the Chan/Welford merge (the ADWIN reference), or centred sums. | False alarms and step-detection delay at offsets 1e9 and 1.7e12 are within +-2 items of offset 0. |
| F10 | M4 (M) HeavyKeeper stores the weight unclamped into a Uint32 cell (`:1987`, `:2002`, `:2047`, `:2061`): `add(7, 2^32)` estimates 0. | Reject `weight > 2^32-1` (SCM parity) or clamp at store. | `estimate` equals the top-k entry for weights 2^32 and 2^33, or they throw tagged. |
| F11 | M5 (M) doors that abort the PROCESS: `new HeavyKeeper(64, 2**30, 1)` and `new ExponentialHistogram(10, 1e-12)` hit an uncatchable V8 fatal. DR `k` is uncapped too. | Add a cells cap (like `SCM_CELLS_CAP`) to HK / EH / DR and throw a tagged RangeError before allocation. | Each case throws tagged in a subprocess, with no abort. |
| F12 | M6 (M) three contracts for a bad query argument: SDD `quantile(2)` throws (lite-sketch returns NaN), SCM `estimate(k, badW)` returns 0 (fail-open for an upper-bound sketch), and SHLL/SDD `count(badW)` throws. | One contract. Lean: NaN, never throw, matching lite-sketch. | A table test across SDD / SHLL / SCM. |
| F13 | M7 (M) the option-key lists for HK, SHLL, DD, SDD, SCM and DR are plain object literals, so `{constructor: 1}` / `{toString: 1}` are accepted. Arrays are accepted as the bag. The promised did-you-mean hint does not exist (R6). EH / ADWIN / FD use `Object.create(null)` correctly. | Use `Object.create(null)` lists (or `Object.keys` + an own-check), reject arrays, and add a did-you-mean hint on all doors, including `withAccuracy`. | `{toString:1}` and `[]` throw on all 11 doors. `{sede:1}` suggests `seed`. |
| F14 | L1 (L) a subnormal `halfLife` gives `lambda = Infinity`, then NaN. DR fails open (priorities NaN, the sample freezes). FD fails only at query time. | Reject when `!(Math.LN2 / halfLife < Infinity)`. | `DR(2, 1e-320)` and `FD(1e-320)` throw tagged. |
| F15 | L2, L6, L7 (L) EH `sum()` has no finiteness guard (`add(0,1e308)` twice gives Infinity). The DR idle-gap comment (`:4994`) and the CHANGELOG 1.6.0 disagree (keys do reach -Infinity; harmless ordering). The HK overestimate range is written backwards (`:1805-1806`). | Guard or document `sum()`, and correct the two texts. | Grep the corrected texts. `sum()` is finite or documented. |
| F16 | L3, L4, L5 (L) the lockfile `version` is 0.1.0. The README Testing section has no test count (368). ROADMAP statuses are stale (M0-M4 "planned", SCM "IN DEVELOPMENT", Reservoir "unscheduled"). | Fix all three. | `npm i --package-lock-only` produces no diff. The README states the count. |

**New gates (N)**

| id | gate | must fail today |
| --- | --- | --- |
| N1 | mustFail: a scenario that boxes exactly one 16 B HeapNumber per op (12 scavenges at 8N). It must FAIL at `maxScavenges: 0`. It replaces the `new Array(64)` control, which is ~30x the signal. | passes today at 16 |
| N2 | A plain-add fractional control per member, required to reach >= 10 scavenges. For FD, DD and `advance`, call through ONE call site shared by >= 5 classes, so inlining cannot hide the box. | FD / DD read 0 today |
| N3 | The key x clock matrix: each member's `addFrom` x {performance.now, epoch-ms} x keys {2^30, 2^31, 2^32-1, -2^31, 2^53-1} x counts {1, 2^30} x {fresh, warmed by other configs + sibling members}, equal to baseline. | HK: 12-27 |
| N4 | Query scaling lanes (the ones a consumer calls at 10-15 Hz): `quantileInto`, `count`, `estimate`, `sum`, `forEach`, `sampleInto`. | `quantileInto`: 24 |
| N5 | A +1e12 timing gate for SlidingCountMin (< 1 ms at the default size), with a per-skipped-pane loop subclass that must FAIL it. Add FD and DR huge-jump timing. | no SCM lane today |
| N6 | The same key-class lanes in a 31-bit-Smi runtime (headless Chrome). On this Node build 2^31-1 is still a Smi; in Chrome 152 `%IsSmi(2**30)` is false. Every Node "0" is from the 32-bit-Smi build. Keep hot-path int32 hashes in an Int32Array slot or hand-inline them (F3-style). | not measured yet (PLAUSIBLE) |

**Settle calls (maintainer)**, lean in brackets:
- S1 CUSUM re-fires on a sustained shift (850 alarms in 5000 items after a +10 step; disclosed in
  ADR 0007). Section 6.2's one-alarm-per-regime, direction and `lastDriftIndex` did not ship.
  [Add `lastDirection` (+-1) and `lastDriftIndex` getters plus an optional latch. lite-hud uses PH.]
- S2 SlidingCountMin has no `total(w?)`. ADR 0010 rejected it by reasoning about CU cells, but 6.2
  asked for a separate exact Float64 total per pane. [Ship it: 8 B/pane, exact. A consumer needs N
  for the epsilon x N bound.]
- S3 EH level sizing for F1. [53 levels by default, with the memory figure stated.]
- S4 SCM `seed` is coerced with `\| 0` (2^32+1 == 1), while HK / SHLL / DR reject a non-uint32.
  [Keep it for lite-sketch CMS parity (the differential gate relies on it); document it.]
- S5 `lastNow` reads 0 before the first add (SHLL / SDD / SCM), and the ADWIN / DD empty `mean`
  is 0. [NaN: null is not zero. Or document "check `mode`".]

**Checked clean (no task):**
- d.ts vs runtime reflection: no gaps.
- `add` / `addFrom` validation is identical.
- 13+ rejection classes per member leave byte-identical state.
- SHLL equals lite-sketch HLL (0 mismatches / 50k keys to +-2^53) and is within 0.76 sigma at
  epoch-ms incl. after `advance`.
- SCM one-sided on 0 of 94,350 queries under the true count, equals lite-sketch CMS key for key,
  saturation and sums > 2^32 are correct, and a +1e12 jump is bounded (36 us default, 2.1 ms at
  269 MB).
- FD is exact to ~1e-15 at epoch-ms across rebases.
- R11 `advance` empties EH / SHLL / SCM / SDD.
- HK weighted recall@10 = 1.0.
- DR is seeded-reproducible, empty = size 0, numbers only.
- Every other `addFrom` / `advanceFrom` lane is 0 fresh and warmed at both clock scales.
- Steady-state reshaping p99.9 <= 2.4 us, and every rotation loop is capped at B+1 panes.
- ASCII / MIT / `files[]` / VERSION are clean.

**Exit:** F1-F16 and N1-N5 green, and N1 and the N2 controls FAIL when the fixes are reverted.
N6 is measured, or recorded as an open item with a browser lane plan.

### 7.1 Independent reproduction (2026-09-24, read-only, Adaptive.js at d37b271)

Baseline re-run: `npm test` 368/368, `test:perf` 28/28, `test:types` clean, `demo:check` 65 pass /
0 fail, torture `ok` with every lane at 0 B/op (incl. `quantileInto` and HK `addFrom large-u32`),
witness `ok`. The gates are green on code that has every finding below.

| id | result | measured |
| --- | --- | --- |
| F1 | REPRODUCED | `EH(10,.1)` one `now`: NaN at add 43. `EH(1000,.01)` t=i/10: NaN at add 6478. NEW: the README quick-start `EH(60000,.01)` at 8 kHz goes NaN at add 417,742 (t = 52.2 s). |
| F2 | REPRODUCED | strict `add(0,1); add(1,1.05)` throws. CORRECTED (planner, 2026-09-25): lite-sketch `minIndexable`/`maxIndexable` are alpha-only in BOTH modes, so SDD's getters already match. The real gap: lite-sketch derives `strict` from a declared `range` (bins fixed at the range, `rangeMin`/`rangeMax` getters), while SDD strict has no range, so its accepted band depends on each pane's first value and cannot be pre-checked. |
| F3 | REPRODUCED | HK `addFrom` 16 B/op for keys 2^31, 2^32-1, 2^53-1 (fresh + warmed, steady state); ~31 B/op for keys <= -2^31. Weight 2^30: fresh only (warmed 0). Small keys and 2^30: 0 (Node has 32-bit Smis). |
| F4 | REPRODUCED | a 16 B/op control through the shipped `runGate` passes at 16, fails at 0. Gate copy at 0 fails 2/28 every run: FD addFrom (6-14) and HK addFrom (12-25). HK at 25 means the lane is flaky even at 16. DR add passed 3/3, so "DR add 1" was noise. FD's count is HARNESS-only: `t += 1.5` locals (PerfGate lines 83, 171, 419, 641, 727) plus the `fd.landmark \| 0` sink (a getter returning a double). |
| F5 | REPRODUCED | SDD `quantileInto` (3 qs) 64 B/call, `quantile` 32 B/call. |
| F6 | NARROWED | SCM `estimate` of a count >= 2^31: 16 B/call, persists. EH `sum()` and HK `estimate` box only in the early JIT tier (steady 0). HK `estimate` of a small count: 0. |
| F7 | REPRODUCED | W=100, panes=2: `add(10,5); advance(105)` count 0. Own stream (W=1000, panes=8, true `(now-W, now]` oracle): p50 beyond alpha on 260/1068 queries, `count() < true` on 1046/1068. `sldDrive` is pane-aligned (`E - W`, witness.mjs:1276-1282). |
| F8 | REPRODUCED | same stream, queried vs unqueried: `overflows` 6556 vs 6562. README line 211 says `count()` "lazily expires"; line 628, ADR 0009 and llms.txt:789 say queries are PURE. |
| F9 | REPRODUCED | ADWIN(.002), 5 seeds x 20k stationary N(0,1): 0 alarms at offsets 0 and 1e6, 98 at 1e9, 144 at 1.7e12. Variance spans [0, 3e10]. +1 step delay 69-112 at 0; 16-338 at 1e9; at 1.7e12, 2 of 5 were not detected within 2000 items. |
| F10 | REPRODUCED | `add(7, 2^32)` and `add(7, 2^33)`: `estimate` 0 while `topK` reports 2^32 and 2^33. |
| F11 | REPRODUCED | `HK(64, 2**30, 1)` and `EH(10, 1e-12)` hit V8_Fatal, exit 133, and try/catch cannot catch them. `DR(2**31, 1)` "constructs" with `bytes` 34 GB (lazy on macOS; uncapped). |
| F12 | REPRODUCED | SDD `quantile(2)` throws (its own `quantileInto` doc says NaN). SCM `estimate(k, -1)` and `estimate(k, 1e9 > W)` return 0. SHLL and SDD `count(-1)` throw. |
| F13 | REPRODUCED | `{toString:1}` is accepted by HK, HK.withAccuracy, SHLL, DD, SDD, SCM, DR. `[]` is accepted by every ctor door (EH/ADWIN/FD too). No door has a did-you-mean. |
| F14 | REPRODUCED | `DR(2,1e-320)`: lambda Infinity, the sample freezes at the first k values. `FD(1e-320)`: `count()` throws the misleading "value near Double.MAX" message. |
| F15 | REPRODUCED | EH `add(0,1e308)` x2: `sum()` Infinity. HK range comment (:1805). CORRECTED in step 5: the audit's "written backwards" was WRONG. HeavyKeeper never overestimates (ADR 0005; the witness gates the worst overestimate at 0), so `[true - err, true]` is right; only the wording was clarified. The "duplicated line :1799/:1800" was a reproduction artifact (overlapping `sed` ranges printed line 1800 twice), and no duplicate exists. The README/llms/witness labels that called it a "bounded overestimate" were fixed. |
| F16 | REPRODUCED | lockfile `version` 0.1.0; README Testing has no count; the ROADMAP statuses are stale. NEW: the README SDD example `q.quantileInto([0.5, 0.99], out)` (line 266) THROWS (the d.ts requires Float64Array). NEW: the README allocation table covers EH only. |
| F17 | NEW (H for lite-hud) | EH `sum()` does NOT hold `<= epsilon`. Levels are by POPULATION, so the straddling bucket's VALUE mass is unbounded relative to the window sum. W=1000, eps .1, explicit, 20k items vs an exact oracle: count worst 6.3% on every stream; sum worst 6.5% (uniform), 15.8% (heavy tail), 2504% (a 50-item spike of 1000 among 1s). llms.txt:64 and :259, README line 72 ("count / sum ... `<= epsilon`") and the API table claim the bound. ADR 0002 proves it for count only. The witness sums were near-uniform, so they could not catch it. |
| F18 | NEW (found by QA, 2026-09-25; pre-existing in 1.6.0, missed by the audit) | ADWIN's range term R = max - min is a running min/max over ALL raw x that never shrinks after a cut. After one large level shift, the Bernstein range term stays inflated for the instance's lifetime. Measured, 5 seeds: a later +1 shift is caught in 87-99 items with no earlier jump, 921-988 items after an earlier jump of 100, and NEVER within 20000 items after an earlier jump of 1e4 or 1e6. A straddling mixed bucket also persists (a window variance of ~2.7e8 instead of 1 after a 1e6 jump). It fails open, and lite-hud M6 uses ADWIN. Identical output on 1.6.0. SETTLED (maintainer): fix in 1.7.0 with per-bucket min/max, so R is the live window's range. |
| S1 | REPRODUCED | CUSUM(target 0, delta .5, threshold 8) with a +10 step: 5000 alarms in 5000 items. No `lastDriftIndex` / `lastDirection`. |
| S2/S4/S5 | REPRODUCED | SCM has no `total`. SCM `seed` 2^32+1 reads 1 (HK throws). `lastNow` reads 0 before the first add (SHLL/SDD/SCM). The ADWIN/DD empty `mean` is 0. |
| N6 | OPEN | this Node (arm64) has 32-bit Smis: `%IsSmi(2**31-1)` true. Every Node 0 on a key in [2^30, 2^31) says nothing about Chrome. |

**Method corrections (these change how the N gates are built):**
1. **The scavenge-to-bytes ratio is not fixed.** Under `--max-semi-space-size=4`, 16 B/op reads 24
   scavenges at 8N in a fresh process and 12 after new space has grown. It reads 6 with
   `--min-semi-space-size=4` as well. Gates pin BOTH flags, and N1 is calibrated in the same process
   shape as the lane it guards. A direct B/op probe (the new-space used-size delta across K ops with
   no GC between) reads the controls exactly (16.03 / 8.03 / 0.03) and is the better gate.
2. **JIT tier.** The first 8N window after warm-up often runs in Maglev code, which does not inline,
   and boxes. Later windows run in Turbofan code and read 0 (`--no-maglev` removes the gap). A real
   consumer runs Maglev code too, so settle S6.
3. **Library vs harness.** HK's box is in the library (a standalone replica stays at 16 B/op).
   FD's is only in the harness. F4 fixes the harness; F3 fixes the library.

Probe scripts and raw results were kept in the session scratchpad and are not in the repo. They can
be rebuilt from this table. F1-F15 each need only a few lines.

### 7.2 Next session -- plan (v1.7.0, H1 hardening)

**Settle first (maintainer, before the planner):**
- S3 (the F1 sizing). In the literature the level count is bounded by the
  window POPULATION, not by W. DGIM's window is the last N items, so there are ~log N levels. A
  time-based window holds as many items as the rate allows, so an implementation must either
  declare a maximum population or grow its lists. A fixed pool cannot grow, so the population bound
  has to be DECLARED. Memory at `(k+1) * levels + 2` buckets x 36 B:

  | epsilon | 5 s at 1 kHz (5e3) | 5 s at 100 kHz (5e5) | 2^32 | 2^53 |
  | --- | --- | --- | --- | --- |
  | 0.01 (k 51) | 16.5 KB | 29.3 KB | 53.1 KB | 91.5 KB |
  | 0.05 (k 11) | 4.7 KB | 7.7 KB | 13.1 KB | 22.0 KB |
  | 0.1 (k 6) | 3.0 KB | 4.7 KB | 7.9 KB | 13.1 KB |

  SETTLED (maintainer, 2026-09-25): **an explicit `maxCount` ctor option, default 2^32.** A flat 53
  levels is REJECTED: it charges every instance the physically unreachable worst case (lite-hud:
  50 channels x ~99 KB), breaks R10, and hides the domain assumption instead of stating it.
  Contract for the planner:
  - `maxCount` is the window population the pool is GUARANTEED to hold (a floor; the exact ceiling is
    `k * (2^levels - 1)`, ~3-6x maxCount, verified exact on 5 configs), in EITHER mode: a positive integer <= 2^53-1,
    validated typeof-first before allocation, with a `maxCount` getter (R8). `levels` =
    `max(2, ceil(log2(maxCount / (k+1))) + 2)`. The pool is allocated at the ctor, before the mode
    locks, so count-mode instances ALSO get the 2^32 sizing by default (e.g. `EH(1000, .01)` 13 KB ->
    53 KB). Pass `maxCount: W` in count mode to keep the old size. The CHANGELOG states the new
    `capacity` / `levels` numbers. This is the one additive API in 1.7.0 (maintainer-approved).
  - Overflow: an add whose cascade would pass the top level throws a tagged RangeError. The state is
    BYTE-IDENTICAL: today `add` expires (and advances `_now`) BEFORE inserting (Adaptive.js:385,
    :514), so the pre-check must predict post-expiry counts with a READ-ONLY scan. The cascade reaches
    the top iff `lcount[0..top]` are all at `k`, which is an O(levels) read only on that rare path.
    The `this is a bug` throw at :674 then becomes unreachable, with a test that shows it.
  - Witness: `EH(1000, .01)` at 10 kHz for 70 s with the default `maxCount` never goes NaN and stays
    within eps of a deque oracle. With `maxCount` set just below the window population it throws
    tagged, with a byte-identical snapshot.
- S6 SETTLED (maintainer, 2026-09-25): **gate 0 B/op.** Every gated lane reads 0 B/op at steady
  state (the minimum over >= 4 windows, with both semi-space flags pinned). The first window is printed
  next to it and is never a floor.
- S7 SETTLED (maintainer, 2026-09-25): **MINOR 1.7.0, hardening only** (plus the S3 `maxCount` option). F7 changes SDD `bytes` (B+1
  panes) and the covered span. F12 turns throws and silent 0 into NaN. F13 rejects `[]`. Each is a
  fail-closed or valid-input-preserving change. The CHANGELOG lists every non-byte-identical class,
  as 1.5.0 did. The new public API in 1.7.0 is EH `maxCount` (S3) and SDD `range` (S8).
- S8 SETTLED (maintainer, 2026-09-25): **F2 ships lite-sketch's declared `range: [min, max]`** (strict
  derived from it, plus `rangeMin` / `rangeMax` getters, NaN when undeclared) in 1.7.0. With it,
  1.7.0 adds two APIs: EH `maxCount` and SDD `range`. `strict` WITHOUT a range is span-based: it
  throws only when a pane's occupied key span would exceed maxBins, and otherwise re-anchors the
  pane (both rising AND falling values are accepted). A bottom anchor was rejected because it only
  moves the bug to falling values (`add(0,1); add(1,0.5)`).
- S1, S2 SETTLED (maintainer, 2026-09-25): **DEFERRED to 1.8.0**, the additive API release: CUSUM
  latch + `lastDriftIndex` / `lastDirection`, SCM `total(w?)`, and any F6 `xxxInto` reader (e.g. SCM
  `estimateInto`). S4, S5: decide at the planner, doc-only for 1.7.0.
- 1.8.0 candidate from F17 (for lite-hud M4): an exact-per-pane windowed count / sum / mean / min /
  max (B+1 panes, covered span [W, W+W/B], the SCM/SDD pane substrate, no value-skew error). Or a
  value-weighted EH (DGIM's sum variant, merge by value mass) if a relative sum bound is required.
- All settle calls for 1.7.0 are closed (S3, S6, S7; S1/S2 -> 1.8.0; S4/S5 at the planner).

**Order (each step = planner -> coder -> reviewer -> qa; REJECTED goes back to the coder):**
1. **Gates RED first (test-only, no Adaptive.js change).** N1 (a pinned-semi-space 16 B/op control
   plus a B/op probe), F4 harness fix (driver clocks/keys in Float64Array slots, a non-double sink),
   N2 (shared 5-class call site), N3 (key x clock x count x fresh/warm matrix), N4 (query lanes), N5
   (SCM/FD/DR +1e12 timing). Also the true-window oracle for SDD (F7). Record which lanes FAIL on
   1.6.0: this is the "has teeth" proof the exit criterion needs.
2. **Highs, which unblock lite-hud M4 + the HK drop-in:** F1 (EH bound check + S3 sizing), F17 (EH
   `sum()`: state the true bound, `|err| <= size(oldest straddling bucket) / 2`, which is relative
   `<= epsilon` only for count or near-constant values; add a skewed-value witness lane that gates the
   STATED bound and shows the old claim fails), F3 (HK
   slot-passing, `hkMapHash` returning `| 0`), F2 (SDD strict = declared range, lite-sketch parity getters). The
   N3 HK row and the F1/F2 gates go green.
3. **SDD block (one class, one pass):** F7 (B+1 panes), F5 (cut slot + `_walkInto`), the SDD rows of
   F12. The ADR 0008 amendment is part of this step.
4. **Remaining Mediums:** F9 (ADWIN per-bucket Chan/Welford), F8 (SHLL non-destructive `count`),
   F10, F11 (cells caps on HK/EH/DR, subprocess test), F12 (NaN contract table), F13 (null-proto
   lists, array reject, did-you-mean on all 11 doors).
5. **Lows + docs:** F6 (doc note: SCM `estimate` >= 2^31 is one boxed return per call, EH `sum` /
   HK `estimate` box only in the early JIT tier; the `Into` reader is 1.8.0), F14, F15,
   F16, plus the NEW doc items: the README line-266 example, the strict getter text, and an
   allocation table row per member.
6. **Prove + release:** `npm run verify` plus the full N matrix. Revert-check: undo F3/F4 in a
   scratch copy and confirm N1/N2/N3 FAIL. N6 is recorded as open, with a headless-Chrome lane plan.
   Then `/release 1.7.0` and a catalog card sync.

**Progress (2026-09-25, uncommitted working tree):**
- Step 1 DONE (reviewer APPROVED, QA 9/9). New: test/perf/AllocProbe.mjs (B/op probe, steady = min over
  windows 1..n-1, both semi-space flags pinned and asserted), AllocMatrix.test.mjs (N2/N3/N4),
  JumpTiming.test.mjs (N5), PerfGate at maxScavenges 0 with harness boxing removed, the SDD true-window
  oracle, and scripts `test:perf:matrix` + `gates:red`. `todo: '<F-id>'` lanes plus LITE_GATES_STRICT=1.
- Step 2 DONE: F1 + F17 (EH `maxCount`), F3 (HK slots, bit-identical to 1.6.0), F2 (SDD `range` +
  span-based strict; non-strict hot body byte-identical to 1.6.0). All reviewer-APPROVED (F2 after one
  REJECT: a strict-only field was maintained on the non-strict hot path, now moved to the cold path).
  QA 9/9; npm test 393/393; torture 0 B/op on every lane; test:perf 30/30 strict. `gates:red` fails
  only on F5 (2 lanes), F6 (1, the 1.8.0 `estimateInto`) and F7.
- Step 3 DONE: F7 (SDD B+1 ring, covered span [W, W+W/B]; the true-window witness is HARD:
  count < true(W) on 0/29557, previously 29410; a B-pane control is rejected), F5 (quantileInto
  0 B/call, previously 64; quantile has one boxed return, 16 B/call), and F12 SDD rows (a bad value
  returns NaN; a wrong container type still throws). Reviewer APPROVED. The demo oracle moved to the
  B+1 span. The SDD parity vectors were re-cut to a no-expiry stream; the non-strict rows were
  re-verified against HEAD 1.6.0. npm test 395/395; `gates:red` fails only on F6 (1.8.0).
- Steps 4 and 5 DONE (reviewed; QA 8/8 over steps 3-5; npm test 428/428). F18 was found by QA and
  is being fixed in 1.7.0 (maintainer). Step 4 was split: 4a = F9 (ADWIN centred sums + a re-centre on cut) + F8 (SHLL expiry moves into
  add); 4b = F10 + F11 + F12 (SHLL/SCM/HK estimate -> NaN) + F13 (shared option door with a
  did-you-mean hint).

- F18 DONE (reviewer APPROVED): R is the live window's range excluding the oldest bucket (candidate C;
  A, B and D were measured and rejected in ADR 0003). A later +1 shift after an earlier jump of
  100 / 1e4 / 1e6 is caught in 78-113 items (no-jump baseline 85-115); variance after a 1e6 jump
  is 1.00; 0 stationary false alarms on N(0,1) / uniform / heavy-tailed at delta .1 and .002;
  about +5.6% cost per stationary add.
- Step 6: `verify` now includes test:perf:matrix and exits 0 (npm test 432/432, perf 30/30, matrix 57
  pass + the F6 todo, demo 65/65, torture 0 B/op, witness ok). REVERT-CHECK (1.6.0 Adaptive.js in a
  scratch copy, strict gates): perf fails on HK addFrom (F3); the matrix fails on 9 HK lanes (F3), 2
  SDD query lanes (F5) and F6; the witness fails on F1 (its 1.6.0 overflow throw), F9 (72 / 3104
  false alarms at 1e9 / 1.7e12), F18 (misses), F8 (overflows 17487 vs 29842) and F7 (29410/29557
  undercounts). Every new gate has teeth. Caveat: the SDD quantile half of the witness reads the new
  `_ring` field, so on 1.6.0 it yields no queries; the count half of F7 is implementation-independent.

**Cut line if time runs short:** steps 1-2 alone are a coherent, releasable 1.7.0 (the four Highs
plus honest gates). Steps 3-5 then ship as 1.7.1, still hardening only. 1.8.0 stays the additive
API release (S1, S2, the F6 readers).

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
