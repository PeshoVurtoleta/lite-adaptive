# lite-adaptive -- roster roadmap (to 1.0.0: ExponentialHistogram -> ADWIN -> ForwardDecay -> HeavyKeeper)

Blueprint: `../LiteSketch/ROADMAP.md` (milestone table, shared law, gate spec, per-member
briefs) and the `../LiteFilter` / `../LiteSketch` cadence (reference member + one per release,
complete at 1.0.0). See `RESEARCH.md` for the identity, the two witnesses (recency error +
change response), the roster rationale (incl. the verdict on the inherited backlog), and the
open questions. ASCII-only (`->`, `<=`, `x`, "epsilon", "alpha", "delta").

> **NEXT: v1.11.0 -- zero-alloc readers (section 12; batch 1 launch-ready), then the demo session (section 11).** v1.10.0 H2 hardening released 2026-09-28. v1.9.0 SlidingAggregate released 2026-09-27.
> Previously NEXT: v1.9.0 -- SlidingAggregate ONLY (section 9). 1.8.0 (additive API) released 2026-09-27;
> 1.7.0 H1 hardening shipped 2026-09-26. After 1.9.0: section 10 (v1.10.0, the zero-alloc readers +
> the latched-PH fix, from the 1.8.0 doc-truth findings) and section 11 (the demo session, repo-only,
> no npm release). One feature per minor (maintainer, 2026-09-26).

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

## 7. H1 hardening -- v1.7.0 (final-sweep audit of 1.6.0, 2026-09-24)  [SHIPPED -- 1.7.0, published 2026-09-26]

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
| N6 | CLOSED for every hashed-key member (HK 2026-10-04 demo S11; SHLL + SCM ROADMAP 13) | this Node (arm64) has 32-bit Smis: `%IsSmi(2**31-1)` true. Every Node 0 on a key in [2^30, 2^31) says nothing about Chrome. Measured in headless Chrome 154 (`--enable-precise-memory-info`, self-tested meter, 4 runs x 8 windows of 12.5k ops per member x class, raw): control 12.00 B/op in every clean window; HeavyKeeper / SlidingHyperLogLog / SlidingCountMin `addFrom` print 0.0 B/op (the lane's second-largest clean window) for small, [2^30, 2^31), >= 2^31 and <= -(2^30 + 1) keys in 4/4 runs; raw key windows 0.0013 - 0.0051, a per-window constant (it falls 4x at 4x ops; a box is 12 in every window); 3 of 384 raw key windows were single outliers (0.10 - 0.33), dropped by the aggregate. DEMO.md item 6. |

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

## 8. v1.8.0 (additive API) + the demo for 1.7.0 / 1.8.0  [SHIPPED -- 1.8.0, 2026-09-27; demo P3-P5 -> section 11]

1.7.0 shipped the hardening. 1.8.0 ships the settled additive API, and the demo is brought up to
date so that every 1.7.0 / 1.8.0 capability is VISIBLE and re-derived live (DEMO.md section 0: no
hardcoded number, the demo frame path at 0 B/op). Rules: each step is planner -> coder -> reviewer ->
qa; NO agent runs git commit / push / reset / stash (the maintainer commits); `npm run verify` stays
green after every step.

**Settle first (maintainer):** ALL SETTLED 2026-09-26 -- the maintainer accepted every lean: S9 latch as
below; S10 = (a), ship `SlidingAggregate` as the tenth member (demo scene D9); S11 = measure the
31-bit-Smi browser lane in Chromium via the demo page (D8).
- S9 DriftDetector latch semantics. Lean: a `latch` option (default `false`, so 1.x behavior is
  unchanged). With `latch: true` the detector fires ONCE per regime and re-arms when its statistic
  falls back below `threshold / 2` (hysteresis) or on `clear()`. Plus getters `lastDriftIndex`
  (item index of the last fire, NaN before any) and `lastDirection` (+1 / -1, NaN before any).
  Both modes (PH and CUSUM). ADR 0007 amendment.
- S10 lite-hud's F17 need (a time-window MEAN of skewed latencies). Options: (a) a tenth member,
  `SlidingAggregate`: exact per-pane count / sum / min / max on the SCM / SDD B+1 pane ring,
  covering [W, W + W/B], with no value-skew error; (b) defer, and lite-hud keeps its own pane ring.
  Lean: (a), because it is the smallest correct answer to F17 and it reuses a proven substrate.
- S11 N6 (31-bit-Smi browser lane): a measured headless-Chrome lane now, or record it as open. Lean:
  measure it via the demo page (see D8), because the demo already runs the shipped file in Chromium.

**1.8.0 library steps:**
1. SlidingCountMin `total(w?)` -- an exact windowed N from a Float64 total per pane (+8 B/pane),
   same w semantics as `estimate` (bad w -> NaN); the witness gates `total == exact N over the
   covered span` and uses it for the eps x N bound.
2. SlidingCountMin `estimateInto(keys, out, w?)` -- a batch 0-alloc reader over Float64Arrays (F6);
   the last `gates:red` todo goes GREEN, so `gates:red` must exit 0 (the full exit criterion of 7).
3. DriftDetector `latch` + `lastDriftIndex` + `lastDirection` (S9); the witness: one fire per regime
   on the +10 step (vs 5000 today), direction correct on up / down steps, the default path
   byte-identical (parity vectors).
4. MOVED (maintainer, 2026-09-26): `SlidingAggregate` is its own MINOR in a dedicated session --
   v1.9.0, section 9 (one feature per release: easier review, more npm traction).
5. Watch item from 1.7.0: an HK addFrom lane read 16 B/op once in 1 of 3 `gates:red` runs; it did
   not reproduce in 20 isolated runs or 3 later runs. Run `gates:red` 5x in step 6; a repeat is a
   finding.

**Progress (2026-09-26, uncommitted):** library steps DONE and reviewer-APPROVED.
- SCM `total(w?)` + `estimateInto` (REJECTED once: an unset instance with a bad w returned 0, the
  witness upper bound used the implementation's own total, the w argument was never exercised (an
  ignore-w mutant passed 447/447), and the must-box control had been deleted -- all fixed and
  mutant-proven). `gates:red` exits 0 with NO todo: the section-7 exit criterion is met.
- DriftDetector `latch` (REJECTED 3x, each a real fail-open found by mutants or measurement: an
  unconditional clamp that never re-armed on a gradual return; a PH re-arm that wiped the reference
  so reversals were swallowed; a PH reference equal to the mean since clear() so a shift toward it was
  lost). Final: PH resets its reference at a fire and CUSUM at re-arm; the clamp applies only above
  threshold; 5 must-fail controls; parity with latch:false is bit-identical.
- F19 (hash path, found by the watch-item investigation; REJECTED 3x -- toothless parity vectors, an
  unproven --no-turbo-inlining flag, a +59% throughput regression from the Int32Array round-trip, and
  a Proxy re-entrancy clobber in estimateInto): final form uses register int32 locals, no numeric
  argument crosses a call, bit-identical output (378-field state diff vs HEAD), throughput flat
  (in-process A/B guard: HK <= 1.08, SCM / SHLL <= 1.15, RED on the slow copy), and the
  noInlineLargeKey gate is RED on a one-argument mutant.
- Next: QA over the three, then the demo steps D1-D8 + D10.

**Demo steps (all of it re-derived live from the shipped Adaptive.js; DEMO.md is updated first as
the blueprint, then kernels.mjs / index.html / Demo.test.mjs):**
- D1 Scene 01 EH: a `maxCount` control, and a pool gauge showing the live population vs the EXACT
  ceiling `k * (2^levels - 1)` and the capacity / bytes. A "dense 10 kHz" preset with a W-sized pool:
  the tagged overflow throw is caught and shown as a fail-closed banner (1.6.0 showed NaN). An F17
  toggle (skewed / spike values): the `sum()` error cursor inside the STATED bound `straddle / 2`,
  next to the old `<= eps` line visibly failing.
- D2 Scene 02 ADWIN: an absolute-offset slider (0 .. 1.7e12) with identical behavior (F9), and a
  "big jump then +1" preset: the later shift is detected (F18). Draw the live-window range R and a
  ghost of the 1.6.0 global range to show why 1.6.0 went deaf.
- D3 Scene 04 HeavyKeeper: a key-magnitude toggle (small / >= 2^31 / negative) with the Truth Panel
  allocation counter pinned at 0 through `addFrom` (F3), and a weight up to 2^32-1 with the
  saturation shown (F10).
- D4 Scene 05 SlidingHyperLogLog: a query-rate slider (count() every frame vs rarely); two twins show
  identical `overflows` (F8 purity).
- D5 Scene 06 DriftDetector: the 1.8.0 latch toggle -- one marker per regime with `lastDirection`
  arrows, vs the unlatched re-firing.
- D6 Scene 07 SlidingDDSketch: the B+1 pane strip with the covered span [W, W + W/B] vs the true
  window (F7), and the in-tab oracle moved to the TRUE window (count >= true(W) cursor). A strict /
  `range` toggle with a declared band, rejected-value counter and rangeMin / rangeMax (F2). The
  render path uses `quantileInto` at 0 B/call (F5).
- D7 Scene 08 SlidingCountMin: a `total(w)` readout and the eps x N band computed from it; the
  render reads through `estimateInto` (0 alloc).
- D8 Truth Panel: a "contracts" line (a bad sub-window reads NaN; a typo'd option shows the
  did-you-mean) and, for S11, a Chromium-only key-magnitude allocation readout (keys in
  [2^30, 2^31) are HeapNumbers on 31-bit-Smi builds) -- labeled secondary, like the heap readout.
- D9 MOVED to v1.9.0 (section 9): the SlidingAggregate scene ships with the member.
- D10 Demo.test.mjs: faithfulness (every displayed number equals the shipped getter or reader),
  frame path 0 B/op with each new control engaged, the idle-slide proof for the new scene, and the
  reviewer's DEMO AUDIT (no forced reflow, cached DOM lookups, pointer events).

**Demo progress (2026-09-27, uncommitted):** P0 blueprint + golden DONE. P1 (EH D1 + ADWIN D2) and
P2 (HK D3 + SHLL D4) reviewer-APPROVED after 3 rounds each. Every round-1/2 rejection was the same
class: 0-B/op claims gated by `measureAllocs`, which cannot see a transient HeapNumber. Fixed for good
by the shared pinned-semi-space probe `demo/DemoProbe.mjs` (steady = min over windows 1..n-1, must-box
+ noop controls) -- it caught a real 192 B/call HK render box (a >= 2^31 key into `Map.get`) that
measureAllocs read as 0. The other repeats: fail-open demo knobs, oracle-off NaN writes living in the
untested *Tick handler, and forced reflow from *Layout() in rebuild handlers. QA over P1+P2 (22
cases in `demo/Demo.qa.test.mjs`, 8/8 mutants killed) found 2 more: the HK 2^32 banner showed the
demo's guard text, not the library's F10 message (now delegated to the library), and the SHLL
render cost is bimodal (below).

**OPEN library finding -- maintainer decision (found by the demo probe, 2026-09-27):**
`SlidingHyperLogLog.count()` costs 16 B/call STABLE, plus 16 B more when the caller is not
Turbofan-optimized (32 B in ~40% of fresh processes). Scratch bisect (reviewer, pinned probe):
- the stable 16 B is INSIDE count(), in the estimator tail (`Adaptive.js` ~3196-3199: slTau / the
  k-loop / slSigma / Math.round), only on non-degenerate registers; inlining slTau/slSigma, `| 0` on the
  return, or dropping the k-loop each still read 16. The exact boxed value is not isolated.
- the second 16 B is count()'s integer-valued double return materialized at the call boundary
  (`return Math.round(...) | 0` -> 16 B in 8/8 runs).
- this contradicts the library's own comment at `Adaptive.js` ~2891 ("so count() itself allocates
  nothing") and any doc that says SHLL count() is exactly one 16 B boxed return.
Options: (a) doc-only in 1.8.0 -- state "16-32 B per call, tier-dependent" and fix the ~2891 comment;
(b) a `countInto(out, i)` 0-alloc reader in 1.9.0 alongside SlidingAggregate, after isolating the box;
(c) both. The demo documents 16-32 B and gates it at [12, 40].
**DECIDED (maintainer, 2026-09-27): option (c).** 1.8.0 is doc-truth only (the ~2891 comment fixed; the
README F6 table / llms.txt / Adaptive.d.ts state 16-32 B per call; the `q_shll_count` library lane gates
the band [12, 40]); the `countInto` 0-alloc reader lands in 1.9.0 (section 9).

**Exit:** `npm run verify` green, `gates:red` exit 0 (no todo left), `demo` (full, not only
demo:check) green, the reviewer approves the demo audit, `/release 1.8.0`, `/sync-card lite-adaptive`, and a
note to lite-hud: M3 HK drop-in + M4 EH unblocked; latency means arrive with SlidingAggregate in 1.9.0.

## 9. v1.9.0 -- SlidingAggregate (the tenth member), a dedicated session  [SHIPPED -- 1.9.0, 2026-09-27]

Settled S10 (a). Moved out of 1.8.0 by the maintainer (2026-09-26): one feature per minor. The plan
is DONE (planner, 2026-09-26) and is the brief for that session:
- `new SlidingAggregate(W, { panes })` -- a PURE APPEND after DecayedReservoir, ADR 0012, the SIXTH
  additive post-1.0 member. The option door, typeof-first validation before allocation, the
  subnormal-W guard, explicit / count mode locked at the first add.
- A B+1 pane ring (a design-parity COPY of SlidingCountMin's _anchor / _advance / _clearPane, never
  a shared helper). Per pane, stride 5 in one Float64Array: count, sum, Kahan comp, min, max. The
  covered span is [W, W + W/B]: EXACT over it (count / min / max bit-exact; sum within
  2 * 2^-53 * sum|v|, from branch-free Kahan per pane + a cold Neumaier across panes; mean = sum /
  count). Rejected: per-pane offset-centring and plain `+=`.
- HOT, 0 B/op: add / addFrom (stride-2 [now, value]) / advance / advanceFrom, with rotation bounded
  to B+1 clears. COLD: count / sum / mean / min / max (w?) with the NaN query contract, and a 0-alloc
  `into(out, w?)` render reader writing [count, sum, mean, min, max] (a wrong container throws).
- bytes 1592 at defaults (33 x 5 x 8 + 33 x 8 + 8); 50 lite-hud channels = 79,600 B.
- Gates: an exact covered-span oracle AND a true-window lane (count >= true(W)); B-pane and
  no-clear-on-rotate controls REJECTED; a lite-hud lane (lognormal latencies, 50 instances) printed
  next to the EH sum() skew failure (F17); torture incl. rotate-every-add; AllocMatrix N3 / N4;
  JumpTiming +1e12 with a per-pane-loop control; perf gate at maxScavenges 0; QueryContract +
  OptionDoors rows; a mutation test of every reader's `w`.
- Demo: the SlidingAggregate scene (formerly D9) moves to the demo session (section 11).

**Session plan (v1.9.0, SlidingAggregate ONLY -- nothing else ships in this minor):**
1. Planner: re-read the brief above against the 1.8.0 tree (the pane-ring code it copies is
   SlidingCountMin's, which gained `_paneTotal` in 1.8.0 -- confirm the copy, not a shared helper).
   Output ADR 0012 + atomic tasks + falsifiable assertions. Read-only.
2. Coder: Adaptive.js PURE APPEND (the nine prior classes byte-identical -- a sha256 over each class
   body before/after is the proof) + Adaptive.d.ts + test/SlidingAggregate.test.js + QueryContract /
   OptionDoors rows + witness lanes + torture lanes + AllocMatrix lanes.
3. Reviewer (mutation-testing): every reader's `w`, the B-pane and no-clear-on-rotate controls, Kahan
   removed, the Neumaier merge removed -- each must turn a gate RED.
4. QA: boundary suite (empty window -> NaN not 0, one item, W exactly on a pane edge, +1e12 jump,
   count mode vs explicit, subnormal W, 2^53 counts, -0 values, +-Infinity / NaN values rejected).
5. Docs: README (LiteSepforge spine: add the member everywhere the roster is listed), llms.txt,
   CHANGELOG, decisions/0012. Then `/release 1.9.0`, `/sync-card lite-adaptive`, and a lite-hud note:
   M4 latency means unblocked (50 channels = 79,600 B).
**Lessons from 1.8.0, binding for every agent this session:**
- The ONLY allocation meter is the pinned-semi-space steady probe (test/perf/AllocProbe.mjs; min over
  windows 1..n-1, a must-box control that reads >= 12). `measureAllocs` is blind to transient boxes.
  A per-EVENT box (one per rotate / fire) needs an EVENT-HEAVY lane -- an average over quiet adds hid
  the latched-PH fire box (<= 0.5 B/op passed a real 16 B/fire).
- Never gate a lane under a flag the shipped code does not run with (`--no-maglev`) to make it pass,
  and never move a lane out of a sweep to make the sweep green.
- Every doc number is a measured number with the lane that measures it; "0-alloc" without a gate is a
  finding (SHLL count() was advertised 0 B/call and never measured).
- Keep coder briefs small enough to finish in ~60 turns; split, don't resume three times.

### 9.1 Executable plan (planner, 2026-09-27; coordinator-SETTLED the same day)

Design record: `decisions/0012-sliding-aggregate.md`. SETTLED (binding; maintainer delegated the calls):
- bytes = (B+1) x 48 = 1584 at defaults (NOT 1592: the brief's "+ 8" was a copied SCM `_idx` scratch SA
  has no use for); 50 lite-hud channels = 79,200 B.
- Sum bound `|sum - exact| <= (4u + O(N u^2)) * sum|v|`, u = 2^-53 (2u is not provable for this merge).
  Gate at `4u * S1 * (1 + 2^-20)`.
- `_advance()` / `_anchor()` take NO argument (read `this._now`) -- a deliberate divergence from the
  literal SCM copy, for the zero-box law. SCM's own per-rotation `t` argument is logged for 1.10.0.
- `value` REQUIRED in add (no default 1). Empty window: count 0, sum 0, mean / min / max NaN.
- -0: no normalization; `<` / `>` ties keep the first value; the sign of a zero extreme is unspecified.
- Retarget the stale "planned for 1.9.0" doc lines (countInto / latched PH) to 1.10.0 in this release.
- RE-SETTLED after review (2026-09-27): `into` is gated <= 0.5 B/op at a monomorphic / polymorphic site
  (<= 4 receiver shapes). At a MEGAMORPHIC site (5+ SlidingAggregate subclass shapes) the `this._now`
  double-field read boxes (measured 16 B/call into, up to 32 B (measured 16 B in the AllocMatrix lane) for mean) -- a family-wide V8 property (SlidingCountMin
  addFrom reads 32 B/op at 5 maps). Documented, printed as an informational lane, logged for 1.10.0. Not
  fixed by a clock Float64Array in 1.9.0 (it would change the settled bytes and diverge from the family).
- Type checks on new containers use `ArrayBuffer.isView(x) && x instanceof Float64Array` (a Proxy around a
  Float64Array passes instanceof alone) and length checks are written `!(out.length >= 5)` (NaN-safe).
  The same pattern in the older members is logged for 1.10.0.

**API.** Consts `SA_KNOWN_OPTS {panes}`, `SA_DEFAULT_PANES 32`, `SA_PANES_MIN 2`, `SA_PANES_MAX 1024`,
`SA_STRIDE 5`, `SA_X_MAX 1e150`, `SA_MIN_NORMAL 2.2250738585072014e-308` (2^-1022), `SA_CLOCK_SPAN 2^42`
(added 2026-09-27 by the QA190 fix; see section 10.QA190).
- `new SlidingAggregate(W, options?)`, validated in this order BEFORE any allocation: (1) W a number,
  finite, > 0, else RangeError `[lite-adaptive] SlidingAggregate W must be a finite number > 0, got X`;
  (2) `optDoor(options, SA_KNOWN_OPTS, 'SlidingAggregate')`; (3) panes an integer in [2, 1024], else
  RangeError `... panes must be an integer in [2, 1024], got X`; (4) `W / panes` > 0 and finite, else
  RangeError `... W is too small for panes=P (W / panes underflowed to X); use a larger W or fewer panes`;
  (5) `W / panes >= SA_MIN_NORMAL` (a NORMAL double), else RangeError `... W / panes (X) is subnormal; the
  pane grid cannot hold W exactly -- use a larger W or fewer panes`. The ctor precomputes
  `this._nowMax = (W / panes) * 2^42` for the hot-path clock-domain compare.
- `add(now, value) -> this` HOT: value check FIRST (`typeof value !== 'number' ||
  !(value <= SA_X_MAX && value >= -SA_X_MAX)` -> TypeError `... add value must be a finite number with
  |value| <= 1e150, got X`), then mode + time copied from SCM (`_badMode` / `_badNow` / `_badMonotone`,
  same templates), then the clock-domain compare `!(t <= this._nowMax && t >= -this._nowMax)` ->
  `_badNowRange` RangeError (QA190; count-mode checks `this._tick + 1` against `_nowMax` before committing),
  then write: `this._now = t; if (t >= paneEnd[cur]) this._advance();` + 5 slot updates. `_advance` derives
  the grid index `k = round(paneEnd[cur] / pw)` and writes each new pane end as `(k+1) * pw` (multiplication,
  drift-free), not an accumulating `E += pw`.
- `addFrom(buf, i)` stride 2 `[now, value]`, explicit-only, body duplicated (not delegated); bad handle ->
  TypeError `... addFrom(buf, i) needs a Float64Array and an in-bounds integer index with i + 1 <
  buf.length, got ...`.
- `advance(now)` / `advanceFrom(buf, i)`: copy SCM (same templates), bounded to <= B+1 clears.
- `count / sum / mean / min / max (w?) -> number` COLD, never throw: a bad w (non-number / NaN /
  +-Infinity / <= 0 / > W) -> NaN, checked BEFORE the unset return; unset or covered count 0 -> count 0,
  sum 0, mean / min / max NaN.
- `into(out, w?) -> 5` (Smi): out not a Float64Array -> TypeError `... into(out, w?) out must be a
  Float64Array, got X`; `out.length < 5` -> RangeError `... into out.length (N) must be >= 5`; bad w ->
  out[0..4] = NaN; else writes `[count, sum, mean, min, max]`, merged into locals, written at the end.
- `clear() -> this` resets + unlocks the mode, 0 alloc. Getters: `W`, `panes`, `mode`
  ('unset' | 'explicit' | 'count'), `lastNow` (0 before the first add), `bytes`.

**Tasks (one coder at a time, in order; each ~15 turns):**
- T0 golden + parity gate BEFORE any edit: `test/differential/classes-1.8.0.sha256.json` (sha256 per
  class body, `export class X` through its column-0 `}`, cut from `git show HEAD:Adaptive.js`) +
  `test/differential/AppendParity.test.mjs` (recompute on the working tree; the diff regions are
  exactly {header, optDoor docblock, append after DecayedReservoir}; an in-memory one-byte-flip control
  must go RED).
- T1 append part 1: banner + SA_* consts, ctor, `_initState` (fill(0) then the +Inf / -Inf sentinel
  loop), getters, `_anchor()` / `_advance()` / `_clearPane(p)` (copied, no argument), all throwers.
  Gate: `test/SlidingAggregate.test.js` (ctor, doors, subnormal W 5e-324 and 1e-320 @ panes 1024,
  bytes 1584 at defaults and 144 at panes 2).
- T2 add / addFrom / advance / advanceFrom. Gate: every reject is a byte-identical no-op (snapshot
  diff); mode lock both ways; monotone now; a +1e12 advance leaves count 0 and mean NaN.
- T3 count / sum / mean / min / max / into. Gate: unit tests vs an in-test BigInt oracle + a
  QueryContract 'F12 SlidingAggregate' row (bad w -> NaN and pure on all 5; unset + bad w -> NaN; into
  wrong container / short -> throws and pure; into bad w -> 5 NaN slots).
- T4 header paragraph + optDoor docblock "all 10 ctors" (NOT VERSION); Adaptive.d.ts; OptionDoors rows
  (12 doors; `{pnaes: 1}` -> did-you-mean "panes"; valid + adversarial rows). Gate: T0 green, npm test.
- T5 witness SA section: A1-A3 below, per-reader sub-window lanes at W/4 and W/2, controls (BPaneSA,
  NoClearSA, drop-oldest merge, plain-+= replica, plain-merge replica, ZeroClearSA), the lite-hud lane.
  Gate: `WITNESS SlidingAggregate ok`, every control REJECTED.
- T6 torture: track 'slidingaggregate'; lanes add (Smi), addFrom (epoch, fractional), rotate-every-add
  (Smi, pw=1) + rotate-every-add addFrom (epoch), advance, advanceFrom, big-jump 1e12, into, clear,
  retention; SA steps in the 4M HOT loop; reuseSa in the arrayBuffers loop; PerfGate saAddStream /
  saAddFromStream / saMustFailAlloc. Gate: torture GATE ok.
- T7 AllocProbe lanes + AllocMatrix rows (allocation plan below); JumpTiming SA lane + PerPaneLoopSA
  (CTRL_JUMP calibrated so the control's p99 >= 5 ms). Gate: test:perf:matrix green with teeth.
- T8 docs: README spine (TOC, What you get, `## SlidingAggregate` after DecayedReservoir, API + SA
  constants table, Composability, Zero-GC row, Design decisions, Testing count, What this is not,
  Ecosystem), llms.txt, CHANGELOG [Unreleased], ADR 0009 amendment line; retarget "planned for 1.9.0"
  -> 1.10.0 (README ~648/~650, Adaptive.d.ts ~492-493/~554, llms.txt ~133/~184). Gate: ASCII + stray-tag
  grep, `npm run verify`.

**Assertions (oracle = the witness's own (t, v) list; grid pane end `pe = (floor(t/pw)+1) * pw`, live
iff `pe > now - w`; sum = BigInt(v * 2^20), fail closed if not an integer; pw dyadic, e.g. W=1000 B=32):**
- A1 covered span, >= 2000 queries x 4 (W, B) x {lognormal, signed, count mode}, 100%: count / min / max
  `===` oracle; `|sum - exact| <= 4 * 2^-53 * S1 * (1 + 2^-20)`; `into` === each scalar reader. RED on:
  no clear on rotate; Kahan removed (lane K: one pane `[2^53, 1000 x 1.0, -2^53]`); Neumaier removed
  (lane N: pw=1, B=32, `+2^53` pane 0, `+1` panes 1..30, `-2^53` pane 31); empty-pane poisoning (a gap
  > pw inside the window: all-positive -> min 0, all-negative -> max 0).
- A2 true window, pw NOT dyadic (W=1000, B=30): count >= true(W), min <= trueMin, max >= trueMax on
  100%. RED on: B-pane ring; straddling pane dropped.
- A3 w by value, each reader incl. into, at W/4 and W/2 vs the sub-window oracle; the stream plants a max
  spike and a min dip in [now-W, now-W/2). An ignore-w mutant on ANY single reader goes RED.
- A4 contracts: mode lock both ways (snapshot unchanged); `new SlidingAggregate(5e-324)` throws
  /underflowed/; an empty window reads mean / min / max NaN, count 0, sum 0.
- A5 GC / retention: torture `{maxMajor: 0, maxPauseMs: 4}`; every SA measureAllocs lane 0 B/op;
  tracker size back to 0; bytes 1584 and covered results identical over 10 clear/refill cycles;
  arrayBuffers delta <= 0 over 500 reuse cycles; PerfGate maxScavenges 0 with saMustFailAlloc RED.
- A6 JumpTiming: SA advance(+1e12)+add p99 < 1.0 ms; PerPaneLoopSA p99 >= 1.0 ms or the row prints NO TEETH.

**Allocation plan (pinned semi-space probe, steady = min over windows 1..n-1):** add with Smi args 0;
add with fractional args at a non-inlined caller 16-32 B (the documented N2 story; addFrom is the fix);
addFrom <= 0.5 over clk {now, epoch} x value {small int, fraction, -1e149, 1e150}, fresh + warmed;
advance / advanceFrom / clear 0; `into` <= 0.5 fresh + warmed AND through a megamorphic `callInto` site
(5 empty SA subclasses). Scalar readers q_sa_count / sum / mean / min / max gated in the band [0, 16.5]
(docs: "up to 16 B/call; use into()"). EVENT-HEAVY lanes <= 0.5: `sa_af_epoch_rot` (SA(32, {panes: 32})
-> pw = 1; clk from 1.75e12 stepping +1.5 per addFrom, so EVERY add rotates with a non-Smi now) and
`sa_adv_epoch_rot` (same via advanceFrom). Must-box controls >= 12: `q_sa_mean_mega` (callMean over 5
subclass maps) and `sa_add_mega_rot` (fractional now + value through a megamorphic callAdd on the
rotate-every-add shape); N1 stays the probe self-test.

**lite-hud lane (witness, after the SA section):** 50 x `new SlidingAggregate(1000, {panes: 32})`, ms
clock; channel ch gets `v = exp(ln 4 + 0.05 ch + z)` ms (mulberry32 + Box-Muller), quantized to 2^-20;
inter-arrival `(1000/120) * (0.5 + r)` quantized to 2^-10; 30 s simulated (~3600 events / channel); a
query every 16 ms through `into(OUT)`. HARD: count / min / max === oracle; sum within the A1 bound; mean
within `(4u * S1 / n + u|mean|) * (1 + 2^-20)`; >= 2000 queries; sum of `sa.bytes` === 79,200. PRINTED in
one block next to the EH F17 line: SA covered-span mean worstRel (assert <= 4.5e-16), SA vs true(W) mean
worstRel (edge, informational), and ExponentialHistogram(1000, 0.01) fed the same streams: sum()/count()
worstRel vs true(W) (the F17 failure) + EH memory.

## 10. v1.10.0 -- H2 HARDENING (fail-open + allocation findings in shipped classes)  [SHIPPED -- 1.10.0, 2026-09-28]

One theme: every reader a render path needs is 0 B/call, and the latch path is 0 B/op under every tier.
- NEW (review, 2026-09-27): family-wide megamorphic-site boxing. A double FIELD read (`this._now`) at a
  call site that sees 5+ receiver shapes boxes (SA into 16 B, SA mean 32 B, SCM addFrom 32 B/op at 5 maps).
  Measure every member at 5 maps; if worth fixing, move the clock into a Float64Array slot family-wide.
- NEW (review, 2026-09-27): container checks across the family accept a Proxy around a Float64Array
  (`instanceof` alone) and a NaN `length`; harden to `ArrayBuffer.isView` + `!(len >= n)`.
- NEW (QA190, 2026-09-27): SlidingCountMin has the same pane-grid precision fail-open (QA190 F1/F2 repro:
  `new SlidingCountMin(1e-3)`, `3x add(1.75e12, 7)` -> `estimate` 1); apply the SlidingAggregate domain
  guard (reject `|now| > pw * 2^42` and a subnormal `W / panes` fail-closed, grid-index pane ends). Left
  untouched in 1.9.0 per the PURE-APPEND scope; logged here for 1.10.0.
- NEW (planner, 2026-09-27): SlidingCountMin passes the clock as an ARGUMENT to `_advance(t)` /
  `_anchor(t)` (Adaptive.js ~5276 / ~5284 / ~5289 / ~5698). With an epoch-ms `t` a non-inlined call can
  box once per ROTATION; the existing epoch lanes rotate ~every 83 adds, so a 16 B box averages ~0.19
  B/op and passes the 0.5 gate. Add an event-heavy rotate-every-add epoch lane FIRST (measure), then fix
  it the SlidingAggregate way (argument-free helpers reading `this._now`) if it boxes -- bit-identical.

- `SlidingHyperLogLog.countInto(out, i?)` -- a 0-alloc reader that writes the windowed distinct
  estimate into a caller-owned `Float64Array` slot instead of returning a boxed double (finding A;
  section 8 decided option (c)). Keep the plain `count()` as the lane's must-box control (16-32 B/op);
  the `q_shll_count` band [12, 40] proves the probe sees the box today.
- The latched-PH fire box (finding B): a behavior-change fix -- BOUND or RESET the running extremes
  (`gP` / `mMin`) AT the fire so the accumulator no longer produces a fractional/large double that
  boxes in the Maglev tier, WITH regenerated DDParity vectors (the fix changes the latched fire path,
  so latch:false parity stays bit-identical but the latched vectors are re-pinned). Removes the
  `dd_frame` / `dd_frame_nolatch` demo `todo` and the `q_shll_count`-adjacent `dd_latch_ph_fireheavy`
  ceiling, gating latch:true PH at 0 B/op.
- The never-re-arming PH accumulator DRIFT: in a fire-heavy never-re-arming stream the latched PH
  accumulators (monotone `gP` / `mMin`) grow without bound and would eventually reach Infinity and trip
  the `_guardFinite` throw. The bound/reset-at-fire fix above also caps the drift; add a torture lane
  that drives millions of never-re-arming fires and asserts finite accumulators + no throw.
- A `DriftDetector` `statisticInto(out)` / `meanInto(out)` 0-alloc reader: the demo render boxes ~48 B/tick
  because six `_guardFinite` getters in one render function exceed V8's cumulative inlining budget and
  three of them box their fractional returns. The `Into` siblings land the values in caller slots so the
  render path is 0 B/tick (mirrors SDD `quantileInto` / SCM `estimateInto`).
- SETTLED (coordinator, 2026-09-27): the latched-PH fix is chosen by the PRE-DECLARED rule in 10.1
  section 3 -- no maintainer call needed. latch:false stays bit-identical (hard gate).
- MOVED to 1.11.0 (one feature per minor): SHLL `countInto`, DD `statisticInto` / `meanInto` (brief in
  10.1 section 8). 1.10.0 is hardening only.
- Exit: verify + gates:red green (no todo), `/release 1.10.0`, `/sync-card`.

### 10.1 Executable plan (planner, 2026-09-27; coordinator-SETTLED the same day)

Read-only plan; every CONFIRM below is from code reading -- batch 1 executes and records every repro.
Line numbers are the 1.9.0 working tree (`Adaptive.js:N`); re-locate by symbol if they drift.

**SETTLED (coordinator; maintainer confirms or overrides on the ping):** MINOR 1.10.0, a hardening
release like 1.7.0. R2 default below (count-mode bound, SA parity, remedy `clear()`). H2-5 is
measure-and-document only. The DD option is chosen by the pre-declared rule (section 3).

#### 1. Findings (confirm / refute)
- H2-1 SCM pane-grid precision fail-open -- CONFIRMED. ctor guard only `>0 && finite` (~5154);
  `_anchor(now)` ~5475; `_advance(t)` with `E += pw` ~5498; no clock bound in add / addFrom / advance /
  advanceFrom. Repros: F1 `new SlidingCountMin(1e-3)`, 3x `add(1.75e12, 7)` -> `estimate(7) === 1`;
  F2 `SCM(736, {panes:32})` at a 1e17 clock under-counts `total(W)`; F3 `SCM(1500*2**-1074,
  {panes:1024})` builds today.
- H2-1 SDD -- CONFIRMED (same code): ctor ~4140, `_anchor(now)` ~4406, `_advance(t)` ~4420, `E += pw`
  ~4428. Same three repros via `count()`.
- H2-1 EH / SHLL -- REFUTED (no pane grid; cutoff `fl(t - W)` matches a double-clock oracle; no drift).
  FD / DR / ADWIN / HK have no grid. Doc note only.
- H2-2 SCM / SDD pass `t` as an ARGUMENT to `_advance(t)` / `_anchor(t)` (SCM ~5296/5304/5309/5411/
  5718/5752; SDD ~4306/4314/4319/4379/4383/4871/4874/4905/4908) -- a non-inlined call tags an epoch
  double (~16 B per ROTATION); existing lanes rotate ~every 83 adds (~0.19 B/op, hidden). MEASURE first.
- H2-3 DD latched PH -- CONFIRMED latent: latched `_fired` (~3823-3875) resets `_n/_mean` at the fire but
  never re-centres gP / gN / mMin / mMax; `_clampGap(dir, ph, th)` (~3881) passes a double `th` as an
  argument (zero-box law). On the fire-heavy wave (0x32 / 10x32, delta .005, th 5) mMax / mMin drift
  ~0.078 per item (~7.8e6 at 1e8 items); Infinity unreachable (DD_X_MAX) but gap precision degrades.
- H2-4 container gates -- CONFIRMED, 17 sites: `instanceof Float64Array` alone accepts a Proxy;
  `x.length < n` lets NaN through. Replace with `ArrayBuffer.isView(x) && x instanceof Float64Array`,
  `!(i+k < buf.length)`, `!(x.length >= n)`. Sites: EH addFrom ~687 / advanceFrom ~1013; ADWIN addFrom
  ~1366; FD addFrom ~1832; HK addFrom ~2415 + topKInto ~2512; SHLL addFrom ~3096 / advanceFrom ~3323; DD
  addFrom ~3726; SDD addFrom ~4351 / quantileInto ~4726 (both containers + `out.length < qs.length`) /
  advanceFrom ~4888; SCM addFrom ~5383 (`i+2`) / estimateInto ~5628-5637 / advanceFrom ~5732; DR addFrom
  ~6101 / sampleInto ~6214. SA already hardened, untouched.
- H2-4b NEW -- every now / value check on a buffer read written `x !== x || x === Infinity || ...`
  ACCEPTS `undefined` (a length-lying Float64Array subclass makes `buf[i]` undefined): DD / ADWIN end
  with `_mean` NaN; EH / FD / DR / SHLL / SCM / SDD end with `_lastNow = undefined` (monotone guard off,
  field turns Tagged). Replace with positive forms: now `!(now > -Infinity && now < Infinity)` (~701,
  710, 1021, 1026, 1846, 1851, 3107, 3112, 3331, 3336, 4370, 4375, 4896, 4901, 5398, 5403, 5740, 5745,
  6115, 6120); EH ~693 `!(v > 0 && v < Infinity)`; ADWIN ~1371 `!(x <= MAX && x >= -MAX)`; FD ~1838 /
  SDD ~4356 / DR ~6107 `!(v > -Infinity && v < Infinity)`; DD ~3730 `!(x <= DD_X_MAX && x >= -DD_X_MAX)`.
  Every number is accepted / rejected exactly as before; only `undefined` changes.
- H2-5 megamorphic double-field boxing -- CONFIRMED (V8 property; only with 5+ subclass shapes at one
  site). DECISION: measure and document (INFO lanes per class). The fix (a per-instance Float64Array
  "state slab") changes `bytes` and rewrites every hot body -- logged for a later minor, out of scope.
- H2-6 NEW family-wide fail-open in throw-message building -- CONFIRMED. ~120 sites build reject text as
  `'...got ' + String(userArg)`; on a Proxy / toString / valueOf / Symbol.toPrimitive arg `String()` RUNS
  caller code AFTER the guard rejected, and a re-entrant trap mutates the same instance -- `SCM.estimateInto`
  / `SA.into` / `DD.addFrom` throw the tagged error AND leave `total` / `count` at 3 not 1. FIX: one cold
  `describeArg(x)` helper (typeof + `ArrayBuffer.isView`, never a trap; `String` only on a primitive)
  replaces every `String(userArg)`; number messages stay byte-identical, objects named inertly. Cover:
  test/TrapFreeReject.test.js (all 10 classes, ctors + withAccuracy); touches SlidingAggregate too, so
  AppendParity keeps no frozen anchor and the one-byte-flip control moves onto the extractor itself.

- SETTLED (coordinator, 2026-09-28) -- container-length threat model after 4c-i measured a 0.47-0.61x
  hot-path regression for full subclass protection: HOT entry points (addFrom / advanceFrom, per item)
  keep `ArrayBuffer.isView(x) && x instanceof Float64Array` + ONE `x.length` read into a local (a
  caller-defined subclass `length` getter may run once per call -- the caller's own code; documented).
  COLD render readers (into / estimateInto / quantileInto / topKInto / sampleInto) read length through
  the intrinsic %TypedArray%.prototype.length getter (TA_LEN, captured at module init): a lying or
  re-entrant `length` is ignored and never runs, benign subclasses stay accepted. Rationale: the
  fail-closed law guards unverified STATE; a subclass getter is caller code the caller chose to run,
  and the zero-GC hot path is the product.

#### 2. Numeric domain (time-grid classes SCM, SDD; SA already guarded)
- Per-class consts (design-parity copy, module-private, no new API): `SCM_CLOCK_SPAN` / `SLD_CLOCK_SPAN`
  = 2^42; `SCM_MIN_NORMAL` / `SLD_MIN_NORMAL` = 2^-1022.
- `nowMax = pw * 2^42` (pw = W / panes): at the bound ulp(now) <= pw * 2^-10, so `round(E/pw)` recovers
  the grid index exactly and `(k+1)*pw` contains the true window. Min legal W for clock magnitude C:
  `W >= panes * C / 2^42`. Count mode checks `tick + 1 <= nowMax` before committing. Subnormal rule:
  `W / panes >= 2^-1022`. No new magnitude cap (pw > 4.09e295 -> nowMax Infinity -> existing finiteness).
- Typical configs (32 panes): epoch-ms 1.75e12 with W=1000 (bound 1.374e14, legal ~to year 6300),
  W=60000 (8.25e15), W=100 (1.374e13), W=1000 @ 1024 panes (4.295e12, to ~2106), W=16 (2.199e12, legal
  until ~2039-09 -- disclose), W < 12.7 REJECTED today; epoch-us 1.75e15 with W=1e6 (1.374e17) and
  W=1e5 legal, W=1e4 REJECTED (min 12,733 us); performance.now ms with W=16 (2.2e12, ~70 yr uptime),
  W=1 (1.374e11, ~4.35 yr); count mode W=1000 (1.374e14 ticks), W=32 (4.398e12 ticks, ~5 days at 1e7
  adds/s; remedy `clear()`).

#### 3. Behavior changes (MINOR 1.10.0) and the DD rule
1. SCM / SDD ctor: subnormal `W / panes` throws RangeError /subnormal/.
2. SCM / SDD add / addFrom / advance / advanceFrom: `|now| > pw * 2^42` throws `_badNowRange` as a
   byte-identical no-op (these inputs silently returned wrong answers before).
3. SCM / SDD count mode throws once the tick passes `pw * 2^42` (R2 default: SA parity; `clear()`).
4. SCM / SDD pane ends move from accumulated `E += pw` to the exact grid `(k+1)*pw`: bit-identical for a
   dyadic pw; for a non-dyadic pw a boundary moves by at most the accumulated drift and now matches the
   exact grid oracle.
5. All 17 container gates: a Proxy / NaN-length subclass now throws. 6. addFrom / advanceFrom: an
   `undefined` read now throws instead of corrupting state. 7. DD latch:true PH: accumulators re-centred
   or bounded per the rule; latch:false and CUSUM (both latch modes) BIT-IDENTICAL; dd-1.7.0 vectors
   unchanged (hard gate). 8. New error templates.
- DD options (PH-only, inside latched `_fired`; latch:false cannot reach them): V0 argument-free
  `_clampGap(dir)` (bit-identical; re-measure); V1 re-centre at the end of every latched entry (`gP -=
  mMin; mMin = 0; gN -= mMax; mMax = 0`); V2 = V1 on fire items only; V3 = V1 only when max(|mMin|,
  |mMax|) > th * 2^20 (bit-identical until it trips); V4 reset to canonical values at a fire.
- PRE-DECLARED RULE. Gates: (a) dd-1.7.0 (8 replays) + cuLatch bit-identical; (b)
  `dd_latch_ph_fireheavy` <= 0.5 B/op fresh + warmed, 3 runs, default flags; (c) diff = count of
  differing (index, direction) fire events over phLatch / phSquare / phStep1 / phStep2 / phDemo vs 1.9.0;
  (d) test/DriftDetector.test.js green incl. PH(.005, 50) on 0/+10/-10 firing exactly [2005+, 4003-] and
  0/+10/-30 firing 4002-; (e) the drift lane (1e8 items) stays within the option's bound (V1/V2/V4:
  2*th + 2*A = 30; V3: th*2^20 + 30) -- HEAD reads ~7.8e6, so it fails on the old code; (f) latched-PH
  throughput >= 0.95 x HEAD. Apply: if V0 passes (b) ship V0 PLUS the option passing (a)+(d)+(e)+(f)
  with the smallest (c), ties to V3; else ship the option passing (a)-(f) with the smallest (c); if none
  passes (b), ship the (a)+(d)+(e)+(f) option with the smallest (c) as a drift-only fix, keep the <= 4
  ceiling + the known limitation, and move the box to 1.11.0; if nothing passes (a)+(d)+(e), docs only.

#### 4. Batches (one coder per batch, in order; each ~45 turns; report by turn ~45)

**BATCH 1 -- baselines, measurement, red-first tests. Launch VERBATIM on the maintainer's ping.**
Rules: read-only git only (status / diff / log / show) -- never commit / add / stash / checkout / reset /
push; no `npm version` / `npm publish`; never touch package.json `version` or VERSION. Adaptive.js,
Adaptive.d.ts and all docs stay BYTE-IDENTICAL in this batch (record `shasum -a 256 Adaptive.js` at step 0,
re-check at the end). ASCII only (grep new files for non-ASCII and stray tool-call tags). node:test only,
no new deps. Generators in the session scratchpad, never /tmp. Probe lanes keep clocks / values in
Float64Array slots; every setup throws if its precondition does not hold.
- Step 0 baseline: `git show HEAD:package.json | grep version`. If HEAD is 1.8.0 (1.9.0 uncommitted):
  run `node --test test/differential/AppendParity.test.mjs` on the pristine tree (must pass -- proves the
  nine 1.8.0 bodies equal 1.9.0), cut the nine goldens from `git show HEAD:Adaptive.js` into
  `$SCRATCH/head/Adaptive.js` (+ a package.json `{"type":"module"}`), SlidingAggregate's from a pristine
  working-tree copy. If HEAD is 1.9.0, cut all from HEAD. Write the baseline source + sha into every JSON
  header.
- T0 goldens: (a) `test/differential/classes-1.9.0.sha256.json` (sha256 of all 10 class bodies, the
  AppendParity extractor: `export class X` through its column-0 `}`). (b) rewrite
  `test/differential/AppendParity.test.mjs` as the 1.10.0 class-parity gate: SlidingAggregate body ===
  its 1.9.0 sha; the nine others listed in `CHANGED_BY_DESIGN_1_10`, each mapped to the differential test
  that covers it; keep the one-byte-flip control (must go RED); keep classes-1.8.0.sha256.json as
  history. (c) `test/differential/grid-1.9.0-vectors.json` + `GridParity.test.mjs`:
  `SCM(W, {panes:32, w:128, d:4, seed:7})` and `SDD(W, {alpha:.01, panes:32})`; configs D (dyadic) W in
  {32, 1000, 60000} and N (non-dyadic) W=1000 @ 30 panes, W=1e4/3 @ 7 panes; stream now0 = 1.75e12, step
  1.5 + 0.25*(j mod 7); SCM key (j*733 mod 97)+1; SDD value ((j*40503) mod 9973) + 0.5; 20000 adds; plus
  one count-mode stream per class at W=1000. Record per add: SCM estimate of 4 probe keys, total(W),
  total(W/2); SDD count(), count(W/2), quantile(.5), quantile(.99). Encode doubles as 16-hex IEEE bits.
  D + count-mode = LIVE bit-identical gates; N = a printed diff report (not asserted). (d)
  `test/differential/dd-1.9.0-latch-vectors.json` + a NEW describe block in DDParity.test.mjs (1.7.0
  blocks untouched): per item fired, statistic, mean, count, lastDriftIndex, lastDirection; streams
  cuLatch / phLatch (existing seeds + latch:true), phSquare (0x32 / 10x32, delta .005, th 5, 20k items),
  phStep1 (0/+10/-10 x2000, delta .005, th 50), phStep2 (0/+10/-30 x2000), phDemo (the demo DD generator
  if importable as a pure function, else 'skipped' with the reason). All LIVE. (e)
  `test/differential/addfrom-1.9.0-vectors.json` + `AddFromParity.test.mjs`: EH(1000,.01), ADWIN(.1),
  FD(1e9), HK(4,512,16,{seed:4}), SHLL(1000,{p:10,ringCap:8,seed:3}), DR(32,1e5,{seed:7}), DD PH + CUSUM;
  5000 addFrom + 1000 advanceFrom where present; cheap readers every 50 ops. LIVE. Gate: `node --test
  test/differential/` green on the pristine tree; each new file has a one-hex-digit-flip control that
  goes RED.
- T1 measurement lanes (`test/perf/AllocProbe.mjs` lane = `{setup() -> state, hot(s, n)}` in `LANES`;
  `test/perf/AllocMatrix.test.mjs` row = `{lane, mode: 'fresh'|'warmed', label, expected, check}`):
  `scm_af_epoch_rot` (SCM(32, {panes:32, w:128, d:4, seed:7}) -> pw 1; clock CLK_EPOCH +1.5; setup
  asserts every op rotates), `scm_adv_epoch_rot` (via advanceFrom), `sdd_af_epoch_rot` /
  `sdd_adv_epoch_rot` (SDD(32, {alpha:.01, panes:32}), value FRAC[i&15]+1), `scm_add_mega_rot` (MUST-BOX
  >= 12, a copy of saAddMegaRot on the pw=1 SCM), `mega5_<cls>_af` for all 10 classes (4 empty subclasses
  each + a dedicated megamorphized `callAFM(o, buf, i)`). Rows: event-heavy lane live at `<=0.5` if HEAD
  reads <= 0.5, else `todo: 'H2-2 batch 2 (HEAD N B/op)'`; mega5 rows INFO band [m-4, m+4] around HEAD
  value m. Run `npm run test:perf:matrix` 3x. Record `dd_latch_ph_fireheavy` over 5 runs (no gate).
- T2 red-first tests: `test/Hardening110.test.js`; every fix-dependent case `{todo: 'H2-x batch N'}` and
  must print `not ok ... # TODO` on the pristine tree (paste the TAP lines). H2-1 (SCM + SDD each): F1
  must throw /\[lite-adaptive\]/ with the JSON snapshot unchanged (record the HEAD estimate / count); F2
  (clock from 1e17, step 16*(1 + j mod 3)) must throw -- record the HEAD under-count over 500 queries vs
  a double oracle (adds with t > now - W); F3 must throw /subnormal/. Legal positives (LIVE): every legal
  row of section 2 (build, 3 adds, exact readout) + now = 0.999 * pw * 2^42 accepted. H2-4 / H2-4b, one
  row per site: `new Proxy(new Float64Array(8), {})`, a NaNLen subclass and a LongLen subclass each throw
  with the snapshot unchanged, and `dd.mean` stays finite after the attempt; rows already green on HEAD
  stay LIVE. H2-3 (todo): phSquare, assert max |_gP|, |_gN|, |_mMin|, |_mMax| <= 30; record the HEAD
  drift rate per item at 1e6 and 1e7 items.
- Batch 1 gate: `npm test` green (todos allowed); `npm run test:perf:matrix` green; `node --expose-gc
  test/torture.mjs` GATE ok; the Adaptive.js sha equals step 0; ASCII grep clean. REPORT every recorded
  HEAD number -- they are the inputs of batches 2 and 4.

**BATCH 2 -- SCM + SDD domain.** T3 SCM (SlidingCountMin only): consts; ctor MIN_NORMAL check + `this._nowMax
= paneW * SCM_CLOCK_SPAN`; add / addFrom / advance / advanceFrom: count branch `t = this._tick + 1; if
(!(t <= nowMax)) throw; this._tick = t`, explicit / unset branches `!(now <= nowMax && now >= -nowMax)`
before any write; unset branches `this._now = t; this._anchor();`, rotate call `this._advance()`; replace
`_anchor` / `_advance` with SA's argument-free grid-index body (keep SCM's `_clearPane`); `_badNowRange`
copied from SA. T4 SDD: the same with the SLD_ prefix. Gates: H2-1 todos -> live green; GridParity D +
count-mode bit-identical; GridParity N: every diff must be an add within n_rot * ulp(E) of a grid line AND
equal the in-test `(floor(t/pw)+1)*pw` oracle, else STOP and report -- then re-pin N only to grid-1.10.0;
SCMParity / SDDParity / F19 green; event-heavy rows todo -> live `<=0.5` (reverting to `_advance(t)` on a
scratch copy goes RED if HEAD boxed); torture tracks `scm_rot_epoch` / `sdd_rot_epoch` 0 B/op; JumpTiming
p99 < 1 ms; scratch A/B vs HEAD add / addFrom throughput >= 0.97 (median of 7); mega5 SCM / SDD bands
re-cut at most once (disclose the delta).

**BATCH 3 -- containers + value forms.** T5 the 17 container sites; T6 the H2-4b value forms. Gates:
Hardening110 H2-4 rows live; AddFromParity + every differential test bit-identical; AllocMatrix N3 lanes
<= 0.5; torture ok; scratch A/B per touched hot entry >= 0.97 (if short, try `instanceof && isView`
order first; ship anyway with the measured ratio disclosed -- fail closed is law); reverting any one site
on a scratch copy turns exactly its row RED.

**BATCH 4 -- DriftDetector.** T7 build V0-V4 on scratch copies, run (a)-(f), write the decision table,
apply the rule. T8 implement the chosen option in latched `_fired` / `_clampGap` only; re-pin the PH latch
vectors to dd-1.10.0-latch-ph-vectors.json (keep the 1.9.0 file for the diff report); fireheavy row
`<= 0.5` if (b) passed, else keep `<= 4`; torture lane `dd_latch_ph_drift`; the drift todo goes live with
the option's bound.

**QA pass (read-only boundary suite), BEFORE docs.** Domain edge (+-pw*2^42 and +-1 ulp), negative
clocks, now = +-1.7e308 with W = 1e308; count mode at the tick bound + `clear()` reopens; subnormal at
exactly panes*2^-1022; Proxy / NaN-length / LongLen on every site; latched PH reversal after a 1e7-item
drift; the section 2 legal table.

**BATCH 5 -- docs, then the revert-check.** T9: README (SCM + SDD precision-domain paragraphs, constants
rows, container note, DD latch paragraph, test count), llms.txt, Adaptive.d.ts (JSDoc throws only), ADR
amendments (SCM + SDD ADRs with a "Precision domain" section; 0007 with the chosen DD option; 0012 one line
on family parity), CHANGELOG [Unreleased] Fixed / Changed / Known limitations (resolve the 1.8.0 DD entry
per the rule), ROADMAP section 10 status; ALSO the 1.9.0 doc-truth leftovers in llms.txt (SlidingAggregate
"EXACT ... over the LAST W" at ~260 / ~976 -> the covered span [w, w+W/B]; "a +-0 tie keeps the first value
seen" -> the sign of a zero extreme is unspecified). Never touch VERSION. T10: on scratch copies revert each fix and
confirm its gate goes RED; record the list. Then `/release 1.10.0`, `/sync-card lite-adaptive`.

#### 5. Assertions (oracle / the mutant that turns it RED)
- A1 `SCM(1e-3).add(1.75e12, 7)` throws, snapshot unchanged; `SCM(1000)` 3x `add(1.75e12, 7)` ->
  estimate 3 (exact count / drop the `_nowMax` check).
- A2 `SCM(736, {panes:32})` with now in [0.99, 1) * 23 * 2^42: total(W) >= true(W) on 500/500 (double
  true-window count / restore `E += pw`; if it stays green extend to 2^11 rotations near the edge).
- A3 GridParity D bit-identical to the HEAD hex golden over 20000 adds x 5 configs (`k` for `k+1`).
- A4 `scm_af_epoch_rot` / `sdd_af_epoch_rot` <= 0.5 B/op fresh + warmed; `scm_add_mega_rot` >= 12
  (pinned probe, N1 >= 12 / `_advance(t)` if HEAD boxed).
- A5 17 site rows throw with the snapshot unchanged; `dd.mean` finite after LongLen; AddFromParity
  bit-identical (revert any one site to `instanceof` alone).
- A6 torture `{maxMajor:0, maxPauseMs:4}` 0 B/op incl. new lanes; tracker back to 0 after 10 construct /
  fill-10k / clear / drop cycles for SCM, SDD, DD; PerfGate maxScavenges 0 (a per-rotation
  `new Float64Array(1)` in `_advance`).
- A7 DD 1.7.0 vectors + cuLatch bit-identical; the drift lane under the option bound, HEAD ~7.8e6 at 1e8
  (remove the re-centre, or apply it on latch:false).

#### 6. Allocation plan
New lanes: scm / sdd `_af` / `_adv_epoch_rot` (HEAD 16 if `_advance` not inlined, else 0 -> <= 0.5);
`scm_add_mega_rot` must-box (~32, >= 12); `mega5_*_af` INFO ([m-4, m+4]; SCM ~32, may reach ~48 after
`_nowMax`, disclosed); `dd_latch_ph_fireheavy` (<= 4 today -> <= 0.5 target per the rule). Controls: N1,
sharedCallAdd (N2), q_scm_estimate_big (16), sa_add_mega_rot. Every existing lane unchanged.

#### 7. Risks (none blocks; each has a default)
R1 HEAD may still be 1.8.0 -> batch 1 step 0 bridges it (commit 1.9.0 first). R2 count-mode bound ->
SA parity, `clear()`, disclosed. R3 small epoch-ms windows (W <= 16 legal only to ~2039, W < 12.7
rejected) -> ship with a disclosure table. R4 non-dyadic pane-end diffs -> the batch 2 rule. R5
throughput -> the batch 3 rule. R6 the DD box may survive every option -> the section 3 drift-only rule.

#### 8. v1.11.0 readers brief (one feature per minor)
`SlidingHyperLogLog.countInto(out, i = 0) -> 1` (Smi; writes the rounded windowed estimate).
`DriftDetector.statisticInto(out, i = 0) -> 1` / `meanInto(out, i = 0) -> 1` (run `_guardFinite` first,
fail closed, then write). Settle first: a DD `into(out) -> 5` writing [statistic, mean, count,
lastDriftIndex, lastDirection] mirroring SA `into`, instead of / alongside. Container gate
`ArrayBuffer.isView(out) && out instanceof Float64Array`, `!(i < out.length)`, `i` a non-negative integer;
wrong input throws as a byte-identical no-op. Parity: slot `Object.is` the scalar reader on 10k queries
incl. empty / NaN. Lanes `q_shll_countInto` / `q_dd_statisticInto` / `q_dd_meanInto` <= 0.5 fresh +
warmed; plain `count()` stays the [12, 40] must-box control. The demo `dd_frame` todos become <= 0.5
gates once the render reads the Into slots. QueryContract rows; mega5 INFO rows. Docs: d.ts, README,
llms.txt, SHLL ADR + 0007 amendments, CHANGELOG. Readers only, no other behavior change.

### 10.2 What shipped vs the plan (2026-09-28)

- **H2-2 REFUTED.** SlidingCountMin's per-rotation epoch box (passing `t` to `_advance(t)` / `_anchor(t)`)
  was measured on a rotate-every-add epoch lane first; batch 2 adopted SlidingAggregate's argument-free
  `_advance()` / `_anchor()` reading `this._now` anyway (it fell out of the grid-index rewrite), so the
  concern is moot -- SCM / SDD rotate at 0 B/op.
- **H2-6 FOUND and FIXED.** A family-wide fail-open that was NOT in the original H2 list: ~125 throw sites
  built the reject message with `String(userArg)`, which runs a Proxy / `toString` trap AFTER the guard
  rejected, so a re-entrant trap could mutate the same instance (SCM / SA / DD advanced `total` / `count`
  on a "rejected" call). Fixed with one cold `describeArg(x)` helper; number messages stay byte-identical.
- **Container-length HOT / COLD decision (SETTLED 2026-09-28).** Full subclass protection cost a
  0.47-0.61x hot-path regression, so HOT entry points (`addFrom` / `advanceFrom`) keep `isView &&
  instanceof` + ONE `x.length` read (a subclass getter may run once per call, documented), while COLD
  render readers read the intrinsic `%TypedArray%.prototype.length` (TA_LEN). The fail-closed law guards
  unverified STATE; a subclass getter is caller code the caller chose to run.
- **DD latch fix: V0 + V3 chosen** by the pre-declared rule -- V0 (argument-free `_clampGap(dir)`) removes
  the fire box with bit-identical output; V3 (gated re-centre past `threshold * 2^20`) bounds the
  accumulators while staying bit-identical until the trip. `latch: false` / CUSUM bit-identical; latched-PH
  throughput 0.98x HEAD.
- **The EH 0.95x residue.** ExponentialHistogram's hot `addFrom` measures ~0.95x of 1.9.0 -- the cost of
  the H2-4b stricter positive-form `now` check (`!(now > -Infinity && now < Infinity)`, which also rejects
  an `undefined` buffer read). Accepted: fail-closed is law, and every other member is 0.98-1.01x.
- Gates at CODE COMPLETE: `npm test` 817/817; `test:types` clean; torture 0 B/op; GridParity dyadic
  bit-identical (non-dyadic drift corrected; HEAD drifted up to 450 ulp). H2-5 megamorphic box is
  measure-and-document only (mega5 INFO: SCM 49, SDD 70.5). SHLL `countInto` + DD `statisticInto` /
  `meanInto` moved to 1.11.0.

## 12. v1.11.0 -- zero-alloc READERS (one feature)  [SHIPPED -- 1.11.0, committed 0728d80]

Planned 2026-09-28 by the coordinator (no planner spawn -- the brief was 10.1 section 8; facts checked in
code). One feature per minor: two new 0-alloc render readers, no other behavior change.

### 12.1 SETTLED (coordinator; maintainer may override on the ping)
- S1 API shape -- mirror `SlidingAggregate.into(out, w?)`, one container per call:
  - `SlidingHyperLogLog.countInto(out, w?) -> 1` writes `count(w)` into `out[0]` (the SAME value,
    `Object.is`-identical). Bad `w` -> `out[0] = NaN` and returns 1 (NaN contract, never a throw);
    unset -> 0.
  - `DriftDetector.into(out) -> 5` writes `[statistic, mean, count, lastDriftIndex, lastDirection]` into
    `out[0..4]` (each `Object.is` its getter; a never-fed or cleared detector -> `[0, 0, 0, NaN, NaN]`;
    after a reset-on-fire, count is 0 but slots 3-4 keep the last fire, exactly as the getters). A non-finite accumulator
    throws the SAME `_guardFinite` RangeError BEFORE any slot is written (out untouched -- fail closed,
    never a partial write).
  - Rejected: `statisticInto` / `meanInto` (two calls, two container checks, and the demo render still
    needs count / lastDriftIndex / lastDirection). Multi-channel packing: the caller passes one
    `subarray` view per channel, created once at setup (subarray views are valid containers, QA 1.10.0 C8).
- S2 Containers -- the 1.10.0 COLD-reader model: `ArrayBuffer.isView(out) && out instanceof Float64Array`,
  length via the intrinsic `TA_LEN.call(out)` read ONCE, `!(n >= 1)` / `!(n >= 5)` -> RangeError; a wrong
  type -> TypeError; messages via `describeArg`. A lying / re-entrant `length` is ignored and never runs.
- S2 RE-SETTLED (coordinator, 2026-09-28, after review + QA111-R1/R2): COLD readers (SHLL countInto, DD
  into, and the 1.10.0 cold readers SA into / SCM estimateInto / SDD quantileInto / HK topKInto / DR
  sampleInto) check the INTRINSIC type tag -- `TA_TAG.call(x) === 'Float64Array'` with TA_TAG the
  %TypedArray%.prototype[@@toStringTag] getter captured at module init (reads the internal slot, returns
  undefined for a non-typed-array, never runs user code) -- instead of `isView && instanceof`. A
  prototype-swapped Uint8Array / DataView used to be ACCEPTED (silent byte truncation) or hit a native
  TypeError. HOT entry points keep `isView && instanceof` (a prototype swap is caller code, like a
  subclass getter; documented), per the 1.10.0 hot/cold model.
- S3 The SHLL estimator box. `count()` costs a STABLE 16 B inside the estimator tail (`slTau` / the k-loop /
  `slSigma` / `Math.round`, ~Adaptive.js 3240-3265) on non-degenerate registers -- not only its return
  (1.8.0 finding A). `countInto` is pointless unless that box goes. PRE-DECLARED RULE:
  (a) a bit-identical estimator change that makes `countInto` <= 0.5 B/call steady -> ship it (count()
  benefits too); (b) else a change whose `count()` output is identical on every SHLLParity / F19Boundary
  vector + a 1e6-query random sweep (the result is `Math.round`-ed, so a reordered-but-equivalent float
  expression usually rounds identically) -> ship it, disclose "estimator reordered, outputs identical on
  N queries"; (c) else STOP and report -- do not ship a `countInto` that boxes.
- S4 Numeric domain: the Ertl estimate can exceed 2^53 only for astronomically saturated banks (degraded
  flag) -- it is stored into a Float64 slot, so no Smi / box concern; `lastDriftIndex` <= 2^53-1 by
  construction; DD values are finite (guarded) or NaN (before any fire).

### 12.2 Batches (ONE job per coder; coordinator runs the FULL npm test after every batch)
**BATCH 1 -- measure + red-first (NO Adaptive.js edit).** Launch verbatim.
Rules: read-only git only (never commit / add / stash / checkout / reset / push); no VERSION bump;
Adaptive.js byte-identical (record `shasum -a 256 Adaptive.js` at start and end); ASCII only; node:test
only; scratch = the session scratchpad. Tasks:
- T1 isolate the SHLL estimator box on scratch copies with the pinned probe (test/perf/AllocProbe.mjs
  style: `--expose-gc --min-semi-space-size=4 --max-semi-space-size=4`, steady = min over windows
  1..n-1): a lane storing `count()` into a Float64Array slot at a monomorphic site on a NON-degenerate
  sketch (thousands of distinct keys); bisect the estimator tail expression by expression (inline
  `slTau` / `slSigma`, hoist `Math.round`, split the k-loop accumulator, `z` as a local vs a field, the
  `C` scratch reads) until the 16 B is located. Deliver: the exact boxing expression, a candidate fix,
  its B/op, and whether `count()` stays bit-identical (SHLLParity + F19Boundary + a 1e6 random-query
  sweep vs HEAD) -- i.e. which S3 branch (a / b / c) applies.
- T2 red-first `test/Readers111.test.js` (every case `todo: 'readers batch 2|3'`, printing `not ok ...
  # TODO`): slot values `Object.is` the scalar readers over 10k queries incl. unset / empty / bad w / NaN
  states; return values (1 / 5); DD non-finite accumulator -> throws and `out` untouched; container
  rejects per S2 (Proxy, non-F64, short, NaN-length subclass over a valid backing ACCEPTED, re-entrant
  length getter never runs); subarray-view packing of 50 channels.
- T3 lanes in AllocProbe + AllocMatrix rows (todo until B2/B3): `q_shll_countInto` and `q_dd_into` <= 0.5
  fresh + warmed at a monomorphic and a 4-shape site; `mega5_*` INFO rows; must-box controls stay:
  `q_shll_count` [12, 40] and a DD six-getter render lane (~48 B).
Gate: npm test green (todos allowed); Adaptive.js sha unchanged. Report the T1 verdict first.

**BATCH 2 -- `SlidingHyperLogLog.countInto` + the estimator fix per the S3 branch.** SHLL only. Gates:
Readers111 SHLL rows live; SHLLParity / F19Boundary bit-identical (or S3-b disclosure); `q_shll_countInto`
<= 0.5; `q_shll_count` band re-cut if `count()` dropped (disclose); torture lane "SlidingHyperLogLog
countInto" 0 B/op; QueryContract F12 row; mutants: ignore `w` in countInto, write before the w check,
revert the estimator fix -> each RED.

**BATCH 3 -- `DriftDetector.into(out)`.** DD only. Gates: Readers111 DD rows live; DDParity untouched;
`q_dd_into` <= 0.5 (mono + poly4); torture lane 0 B/op; mutants: write before `_guardFinite`, swap two
slots, drop the TA_LEN read -> each RED.

**Review** (reviewer, the diff only, report by turn 25) -> **QA** boundary pass (before docs) ->
**BATCH 4 docs** (README readers table + Zero-GC rows + DD / SHLL sections, llms.txt, d.ts, ADR 0006 +
0007 amendments, CHANGELOG [Unreleased]: Added + resolve the SHLL count() known limitation per S3) ->
coordinator `npm run verify` + `gates:red` -> `/release 1.11.0` -> `/sync-card`.
After 1.11.0: the demo session (section 11) -- the DD scene reads `dd.into`, its `dd_frame` todos become
<= 0.5 gates.

### 12.3 What shipped vs the plan (2026-09-28)

- **S3-a landed in batch 1.** The batch-1 probe located the estimator-tail box in `slSigma` / `slTau` /
  `Math.round` RETURNING computed doubles, and a VOID-helper-into-slot rewrite (SHLL-only module scratch
  `SL_EST` / `SL_SIG_S` / `SL_TAU_S` / `SL_CUT`, like HeavyKeeper's `HK_KIN`) makes `count()` 0-box with
  BIT-IDENTICAL output -- S3 branch (a). So `count()` benefits, `countInto` ships, and the `q_shll_count`
  band is re-cut to the new 0-box steady state.
- **The argument box was caught by review under `--no-turbo-inlining`.** A candidate that handed the
  sub-window cutoff to the estimator body as a fractional-double ARGUMENT still boxed at a non-inlined call
  site; review's `--no-turbo-inlining` lane made it deterministic, and the cutoff was moved into the
  `SL_CUT[0]` slot.
- **S2 was re-settled to `TA_TAG` across the 7 cold readers.** Review + QA111-R1/R2 found the shipped
  `isView && instanceof` cold guard ACCEPTED a prototype-swapped `Uint8Array` / `DataView` (silent byte
  truncation). The fix switched all seven cold readers (SHLL `countInto`, DD `into`, SA `into`, SCM
  `estimateInto`, SDD `quantileInto`, HK `topKInto`, DR `sampleInto`) to the intrinsic
  `%TypedArray%.prototype[@@toStringTag]` type tag captured at init -- a behavior change on invalid input
  only. HOT entry points keep `isView && instanceof`.
- **A coordinator spec error on the DD empty state was caught by the batch-3 coder.** The original S1 text
  implied a never-fed detector writes a hardcoded `[0,0,0,NaN,NaN]`; the coder noted the `lastDriftIndex` /
  `lastDirection` getters ALWAYS return `_s[1]` / `_s[2]` (a fire log surviving a reset-on-fire), so a
  hardcoded NaN would DIVERGE from the getters after a reset. `into` now reads slots 3-4 from `_s`, and the
  S1 wording was corrected (12.1).

## 11. The demo session (repo-only; no npm release)  [SHIPPED -- 2026-10-04, working tree; see 11.2]

Finish demo/ for 1.7.0 -- 1.10.0. The tree already holds P0-P2 (APPROVED + QA'd) and P3 (the DD / SDD
blockers fixed, NOT yet re-reviewed). Run after 1.11.0 (the readers), so the DD scene reads the new `Into`
readers (render 0 B/tick) and the `dd_frame` `todo` becomes a real <= 0.5 gate.
- P3: re-review the DD / SDD pass (it was rejected once; every blocker is fixed in the tree).
- P4: SCM D7 (`total(w)` readout + the eps x N band from the ORACLE N; the render reads through
  `estimateInto`) + D8 (the contracts line).
- P5: the S11 Chromium-only key-magnitude lane (a meter self-test; "n/a", never 0) + the static DEMO
  AUDIT test over index.html with an injected-violation control per rule.
- The SlidingAggregate scene (formerly D9): a lite-hud-shaped latency panel vs the exact oracle, next to
  the EH sum() skew failure.
- The same demo law as 1.8.0: every allocation claim on demo/DemoProbe.mjs; oracle-off NaN writes in
  renderXPrep (tested); NaN renders "n/a" neutral; no layout call in a rebuild; reviewers run BOTH
  demo test files.
- Exit: full `npm run demo` green, reviewer approves the DEMO AUDIT, a repo-only CHANGELOG note.

**Static audit findings (coordinator + maintainer, 2026-10-04, demo/index.html at 0728d80).** Baseline:
`npm run demo:check` 151 pass / 0 fail / 13 skipped / 1 todo (`dd_frame`). Fold these into P5 (each one
becomes a DEMO AUDIT rule with an injected-violation control):
- BUG: duplicate ids `eh-eps` (slider + the relerr-eps readout) and `dr-hl` (slider + the
  "half-life / lambda" readout). `$()` returns the first match, so `ehDom.eps` / `drDom.hl` write
  textContent INTO THE `<input>` and both readouts stay at their placeholder. Rename the readout spans.
- Per-frame closures: `adDraw` (`const y = (v) => ...`) and `fdDraw` (`const mapV = (v) => ...`) build a
  closure every frame. Hoist them to module-level functions.
- Layout thrash in `sizeCanvas`: read rect -> write `width` / `height` -> the next canvas reads again, so a
  scene layout forces one synchronous reflow per canvas (4-6). Not per frame (resize / tab switch only).
  Read all rects first, then write.
- 15 `$('...')` lookups inside input handlers (the `*-v` slider labels and rebuild paths). Cache them at init.
- `toFixed`: 75 sites, all in the `(frameN & 7) === 0` ticks (~7.5 Hz), rebuilds or input handlers --
  compliant with the demo law. Upgrade: write-on-change (quantize to an integer key, skip the format AND the
  DOM write when the key is unchanged). Do NOT use `((v * 100) | 0) / 100`: it truncates (0.29 -> 0.28,
  1.13 -> 1.12), rounds negatives toward zero, wraps past 2^31 / 100, drops trailing zeros (width jitter),
  and still allocates the string.
- Not yet adopted: the DD scene does not read `dd.into` and the SHLL scene does not read `shll.countInto`
  (1.11.0); the `dd_frame` todo stays until it does.

### 11.1 Executable plan (coordinator, 2026-10-04; SETTLED -- maintainer may override on the ping)

Measured 2026-10-04 at 0728d80 (facts, not plan):
- **The full `npm run demo` is RED.** The QA `shll_render` lane is still classified `box` and the QA x10
  test still demands the 1.8.0 band [12, 40]; 1.11.0 made `count()` 0-box, so it reads 0 ("the display box
  must stay visible (>= 12 B/op), got 0"). The 1.11.0 cycle re-cut only `Demo.test.mjs`. `demo:check`
  (FAST) skips this lane, which is why the release missed it.
- **`dd_frame` / `dd_frame_nolatch` already read 0 B/op** (readings 0,0,0,0,0,0): 1.10.0 fixed the latched-PH
  box. The two `todo` markers are stale (a passing todo never fails the run).
- `dd_render` reads 48 B/op (the documented [44, 52] band: six getters, three box). `dd.into` removes it.
- The library is DONE for this session: `Adaptive.js` must stay byte-identical (`git diff --quiet
  Adaptive.js` is an exit gate). A demo finding in the library goes to the ledger, not into the code.

SETTLED:
- D-S1 Readers: `renderDdPrep` reads each detector through `dd.into(out)` into ONE module-scope
  `Float64Array(5)` (reused across the 4 detectors); `renderShllPrep`'s display twin reads `countInto`.
  `dd_render` becomes a `zero` lane (<= 0.5); add a MUST-BOX control `dd_getter_box` (sinks the six scalar
  getters, >= 12) so the 0 has teeth. Every displayed slot `Object.is` its getter (faithfulness test).
- D-S2 `shll_render` is a `zero` lane; the QA x10 test becomes "every one of 10 fresh pinned children reads
  <= 0.5" (tier independence), teeth from the existing `mustbox` lane. DEMO.md D4 text: 0 B/tick since 1.11.0.
- D-S3 Duplicate ids: the READOUT spans are renamed `eh-eps-r` / `dr-hl-r` (the sliders keep their ids, so
  no handler changes).
- D-S4 `toFixed` (RE-SETTLED 2026-10-04 during B4): write-on-change helpers in index.html. Numeric
  readouts go through `putFixed(el, slot, f, idx, scale, digits, suffix)` / `putInt` / `putNum` / `putExp`
  / `putSmi`: the key is the value quantized to the shown digits (or the int32 / raw value), kept in a
  module `Float64Array` (+ a `Uint8Array` seen flag); an unchanged key = no format, no string, no DOM write.
  The string is built FROM the key (`(q / 10^digits).toFixed(digits)`), so a skipped write cannot leave a
  stale number; NaN renders "n/a". The helpers take `(f, idx)` and read the slot INSIDE, so no fractional
  double crosses a call (the 1.11.0 lesson). Composite strings ("a / b", "x vs y") use `setText` /
  `setClass` (string compare, write only on change) -- per-site multi-input keys were rejected as a
  stale-display risk. The `|0` truncation trick is REJECTED (0.29 -> 0.28, negatives toward zero, wraps
  past 2^31/100, still allocates the string). Index.html allocation is not probe-measurable in node, so
  no B/op claim is made for it.
- D-S5 `sizeCanvas` becomes two-phase: each `*Layout` reads every canvas rect first (into a module
  `Float64Array`), then writes every `width` / `height`. One reflow per layout, not one per canvas.
- D-S6 The DEMO AUDIT is its own file `demo/DemoAudit.test.mjs` (added to both `demo` scripts), reading
  index.html as text. Rules = DEMO.md section 5-6 law PLUS: unique ids; every `$('x')` id exists; no
  `$(` / `getElementById` / `querySelector` inside any function body (init only); no arrow / `function`
  literal inside a `*Draw` / `*Step` / `loop` body; no layout READ after a layout WRITE in one function
  body; no raw `.textContent =` / `.className =` in a `*Tick` (every write goes through put* / `setText` /
  `setClass`), and `toFixed` in a `*Tick` only inside a `setText` composite ("a / b"). Each rule has an
  injected-violation control (mutate a copy of the text, assert the rule fires). The write-on-change LAW
  itself (no stale display, NaN <-> number, 0 first key) is already gated behaviorally by the B4-fix test
  in Demo.test.mjs (review B5 MAJOR 5); D-S6 adds the static rules, incl. unique ids (B5 M3).
- D-S7 SlidingAggregate scene (Scene 10, formerly D9). Numeric domain: a sim clock in ms from 0, dt = 1000/60,
  W = 1000, B = 32 -> pw = 31.25 (normal), nowMax = pw * 2^42 = 1.37e14 (a session never nears it); values
  lognormal latencies (mu = 3, sigma = 1) plus a 1% spike x50 toggle, all far under SA_X_MAX. Oracle = exact
  covered-span sum over a typed ring (count / min / max exact, sum within the ADR 0012 bound). The EH `sum()`
  on the same stream is drawn beside it (the F17 failure). Render through `sa.into(out)` at 0 B/tick. Pause
  toggle uses `advance(now)` (idle-slide to empty -> mean / min / max "n/a", count 0, sum 0).
- D-S8 The maintainer's own audit findings (in progress) are pasted on the ping; index.html items join B3,
  kernel items join B2. They do not re-open this plan.

Batches (ONE job per coder; coordinator runs the FULL `npm run demo` + `npm test` after every batch; every
coder gets the standard no-history-git rule and must not touch Adaptive.js):
- **B1 (coder; Demo.qa.test.mjs + Demo.test.mjs + DEMO.md only) -- re-baseline to 1.11.0.** D-S2; un-todo
  `dd_frame` / `dd_frame_nolatch` (class `zero`, delete LANE_TODO + the `todo` option). Revert check: on a
  scratch copy of the demo pointed at `git show dba0116:Adaptive.js`, the new `shll_render` gate is RED.
  Gate: full `npm run demo` green, 0 todo.
- **B2 (coder; kernels.mjs + DemoProbe.mjs + both demo tests) -- readers.** D-S1. Revert check: render
  through the getters again on a scratch copy -> `dd_render` gate RED.
- **B3 (coder; index.html only) -- static fixes.** D-S3, D-S5, hoist the `adDraw` / `fdDraw` closures to
  module functions, cache the 15 handler lookups at init.
- **B4 (coder; index.html only) -- D-S4** putFixed / putInt over every `*Tick` readout.
- **B5 (reviewer)** -- P3 re-review (DD / SDD) + the B1-B4 diff. DIFF + mutant list, "report by turn 25".
  Rework cap 2 rounds; fix rounds re-run by the coordinator.
- **B6 (coder) -- P4:** SCM D7 (render through `estimateInto`; `total(w)` beside the ORACLE N; the band from
  the oracle N; heavy-count mode) + D8 (the Truth Panel contracts line: bad sub-window -> NaN, typo'd option
  -> did-you-mean, both live from the library).
- **B7a (coder; DEMO.md + kernels.mjs + tests) -- the SA scene engine** (D-S7): createSaWorld / stepSa /
  stepSaOracle / renderSaPrep; gates: faithfulness, frame 0 B/op, render 0 B/op + a must-box scalar
  `sa.mean()` control, idle-slide to empty, oracle-off NaN writes.
- **B7b (coder; index.html only) -- the SA scene UI** (tab, canvas, readouts through putFixed, pause).
- **B8 (coder) -- P5:** D-S6 DemoAudit.test.mjs (every rule RED on its injected control, GREEN on the tree)
  + the S11 Chromium-only key-magnitude readout (a meter self-test; "n/a" off-Chromium, never 0).
- **B9 (reviewer)** -- B6-B8 diff + approve the DEMO AUDIT. **B10 (qa)** -- boundary pass over the scenes.
  **B11 (coordinator)** -- repo-only CHANGELOG `[Unreleased]` demo note, this section -> SHIPPED.

Exit: full `npm run demo` green with 0 todo; `DemoAudit.test.mjs` green with every control RED; `npm test`
860/860; `git diff --quiet Adaptive.js`; reviewer approves the DEMO AUDIT; no npm release.

### 11.2 What shipped vs the plan (2026-10-04)

Exit met: `npm run demo` (Demo.test + Demo.qa.test + DemoAudit.test + DemoSession.qa.test) green, 0 todo;
`demo:check` green; `npm test` 860/860; `Adaptive.js` byte-identical to 1.11.0. Review: B5 REJECTED (3
blockers + 2 majors, all fixed and re-verified by the coordinator), B9 REJECTED (5 blockers + 1 major, all
fixed; the reviewer's own harnesses re-run GREEN), QA B10: 26 boundary cases, 8 findings (QA-1..8) fixed and
turned into gates. The rework cap (2 review rounds) was reached, so the final DEMO AUDIT sign-off is the
COORDINATOR's, not a reviewer's: its rules now catch the B9 reviewer's own mutants (handler / toggle-callback
lookups, the D-S5 revert) and QA-5..8, each kept as a control or gate. A fresh reviewer may re-audit.
- Coordinator ran B1-B8 directly (no coder spawned): each batch was small and the full-suite run after it
  was the gate. Subagents: 2 reviewers + 1 QA.
- Found by the new readouts, not planned: the SCM demo oracle expired the oldest LIVE pane (`<=`), so its N
  and every tracked true(W) ran one pane short -- the bound gate was weaker than claimed (DEMO.md D7).
- Found by measurement: a `cond ? x / y : NaN` ternary boxes its phi (16 B), and a returned double > 2^31
  boxes at the call boundary (renderScmPrep) -- both fixed; recorded as suite-wide patterns.
- D-S4 RE-SETTLED during B4 (composites via setText / setClass; the numeric helpers take (f, idx)).
- D-S7 refined: whole-ms latencies (exact-equality gate) and an EH `maxCount` of 8192.
- S11 hardened after B9: no clamping, scavenged windows dropped, same window size for every lane, second-
  largest clean window, fail-closed on a throwing / infinite / zero-ops meter. N6 CLOSED for HK addFrom
  (raw: control 12.00 B/op, keys in [2^30, 2^31) 0.00 in 32/32 windows, headless Chrome, precise info).

Ledger (open, for a later session):
- ~~N6 for the other key-hashing members~~ -- CLOSED in section 13 (every member x key class 0.0 in Chrome).
- `activate()` keeps ONE intentional forced reflow per tab switch (a hidden scene has no geometry to
  pre-measure), documented in index.html; not a per-frame cost.
- Still open from 1.10.0: H2-5 megamorphic-site boxing (state slab), the EH addFrom 0.95x residue.
- FIXED 2026-10-04 (demo flake, 1 in 5 full `npm run demo` runs): `P4 SCM heavy-count probe` read
  `scm_render_heavy` 16,16,16,16,16 B/op -- a stable TurboFan state where renderScmPrep did NOT inline
  `scm.total()`, so its heavy-mode N (> 2^31) boxed 16 B at the return (the returned-double pattern above).
  Proven: `--no-turbo-inlining` / `--max-inlined-bytecode-size=0` read 16 every run; the sampling heap
  profiler (includeObjectsCollectedByMinorGC) puts the only render-path site in `total` <- `renderScmPrep`.
  Fix (demo only, `Adaptive.js` byte-identical): SlidingCountMin has no 0-alloc total reader, so the render
  sums `total()`'s own loop in its body over the library's `_paneEnd` / `_paneTotal` (bound once at
  createScmWorld behind a shape check; any other shape falls back to `scm.total()`), the sum landing in the
  flat slot -- C_TOTAL Object.is-identical to `scm.total()` (parity vs HEAD: every flat slot + return over
  192 configs / 47040 renders incl. 16088 heavy, unset, oracle off / resume, paused, after `clear()`).
  New gates, both revert-checked (FAIL on HEAD): the render lane under `--no-turbo-inlining` (runDemoLane
  `flags`, execArgv asserted; the scm_estimate_box control still boxes 16 under the flag) and a C_TOTAL ===
  `scm.total()` source test (the bind must hold).
- OPEN (library, a later release): `SlidingCountMin.totalInto(out, i, w?)` -- a 0 B/call total reader
  (parity with SlidingHyperLogLog.countInto) so the demo can drop its read of the private `_paneEnd` /
  `_paneTotal` / `_now` / `_W` (a coupling; the C_TOTAL source test catches drift).
- OPEN (demo, measured 2026-10-04, pre-existing at HEAD): under `--max-opt=2` (Maglev only) renderScmPrep's
  own body allocates ~2.6 KB/op in heavy mode (HEAD and fixed alike), so every probe window scavenges. Not
  hit by the gated default-flags / no-inline states (TurboFan); a Maglev-tier render audit is unscheduled.

## 13. Next session -- N6 completion (demo, repo-only) + ledger close-out  [SHIPPED 2026-10-04, uncommitted]

State: 9487785 (demo session committed). Everything lite-hud / lite-pick waited on has shipped (HK drop-in
1.8.0, EH, SlidingAggregate latency means 1.9.0, the 0-alloc readers 1.11.0). lite-adaptive is feature-
complete for its consumers; this session is small and closes the ledger. No npm release (Adaptive.js
byte-identical) unless a measurement finds a library box -- then it becomes a 1.11.x patch, re-planned.

SETTLED (coordinator, 2026-10-04; maintainer may override on the ping):
- N-S1 H2-5 (megamorphic-site double-field boxing) is WONTFIX-UNLESS-REPORTED. It needs 5+ subclass shapes
  of one member at ONE call site (mega5 INFO: SCM 49, SDD 70.5 B); no consumer does that, and the fix (a
  per-instance Float64Array state slab) changes `bytes` and rewrites every hot body of all ten members.
  Re-open only on a consumer report, as its own minor. The mega5 INFO lanes stay as the documentation.
- N-S2 The EH addFrom 0.95x residue is CLOSED (accepted in 10.2: the cost of the fail-closed `now` check).
- N-S3 N6 for the other key-hashing members: extend the S11 lane, do not add a new instrument. Members with
  a hashed integer KEY: HeavyKeeper (done), SlidingHyperLogLog (addFrom stride 2: [now, key]),
  SlidingCountMin (addFrom stride 3: [now, key, count]). Key classes per member: small (i & 1023),
  [2^30, 2^31), >= 2^31 (2^31 + i), negative -- RE-SETTLED in N4 to -(2^30 + 1 + i) (review: -(i + 1) is a
  Smi on every build, so it measured nothing the small class did not). Same method as S11 (warm-up, key lanes first,
  control last, same window size, scavenged windows dropped, second-largest clean, KM_MIN_CLEAN, blind ->
  "n/a"). The explicit-time members get a monotone `now` (a running counter) and W = 1e9, so the pane ring
  never rotates during a measurement (a rotation's bounded clear is not the per-key cost being measured).

Batches (coordinator runs the full `npm run demo` + `npm test` after each; no coder needed -- each is small):
- **N1 (kernels.mjs + tests)**: generalize `runKeyMagLane(meter, ops)` to `runKeyMagLane(meter, ops,
  member)` with member in {'hk', 'shll', 'scm'} (default 'hk' -- the existing S11 tests stay byte-identical)
  and return `{ state, control, lanes: { small, big31, big32, neg }, raw }`; `keyMagText` prints the four
  classes. Node tests: the adversarial-meter + kmAggregate gates run per member; with the node heap meter
  every class reads ~0 (two-sided) for all three members.
- **N2 (index.html)**: the HK truth-panel button becomes "measure all": three rows (HK / SHLL / SCM), each
  `keyMagText`; still ON CLICK only; DemoAudit + the Scene wiring tests stay green.
- **N3 (measure + docs)**: headless Chrome with `--enable-precise-memory-info` (scratch cdp.mjs), 4 runs,
  quote the RAW windows per member x class in DEMO.md item 6; ROADMAP 7.1 N6 -> CLOSED for every hashed-key
  member, or -- if any class boxes -- a finding with the raw windows and a 1.11.x patch plan (not fixed in
  this session). CHANGELOG [Unreleased] demo line.
- **N4 (reviewer, one round)**: the N1-N3 diff + one mutant (a member lane that boxes must not print 0).
Exit: `npm run demo` green, 0 todo; `npm test` 860/860; raw Chrome numbers recorded; ledger empty except
N-S1 (wontfix-unless-reported).

After this: switch sessions to a consumer package (lite-hud or lite-pick) -- `cd <package> && claude`.

### 13.1 As built (2026-10-04)

- N1-N3 as planned. Deviations: the result keeps FLAT fields (`small`, `big31`, `big32`, `neg`, plus
  `member`) instead of a `lanes` object, so every existing S11 assertion on `r.small` / `r.big31` still holds;
  the ok-text regex test changed (the text now prints four classes), and QA-2's meter-call threshold moved
  54 -> 102 (two more classes) with new asserts pinning that arithmetic (review N4: the old number had no
  teeth). New: `keyMagClass` (a boxing class is never green), the "nowork" state via `kmDidWork`.
- N4 review: REJECTED on one doc blocker (the docs said "0.00 - 0.01 in every window"; 3 raw windows were
  higher). Fixed, along with every minor: the no-work proof (mutants for hk / shll / scm and a single-class
  hk mutant all read "nowork"); the large-negative class; the per-window-constant claim, which a 4x-ops run
  now confirms; QA-2's teeth; the `$KM_ROWS` and rem nits. The rework cap was not reached.
- Mutant (required by the plan): a SHLL key window boxing one HeapNumber per op for the >= 2^31 class reads
  16.0 B/op, the row goes red, and the "S11 N1" Node gate fails.
- "measure all" runs ~2M ops synchronously in one click (~0.3 s): a deliberate on-demand cost, never the
  frame path.
- Ledger: empty except N-S1 (H2-5, WONTFIX-UNLESS-REPORTED). lite-adaptive is done for its consumers; next
  session switches to lite-hud or lite-pick.
