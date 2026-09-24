# lite-adaptive -- roster roadmap (to 1.0.0: ExponentialHistogram -> ADWIN -> ForwardDecay -> HeavyKeeper)

Blueprint: `../LiteSketch/ROADMAP.md` (milestone table, shared law, gate spec, per-member
briefs) and the `../LiteFilter` / `../LiteSketch` cadence (reference member + one per release,
complete at 1.0.0). See `RESEARCH.md` for the identity, the two witnesses (recency error +
change response), the roster rationale (incl. the verdict on the inherited backlog), and the
open questions. ASCII-only (`->`, `<=`, `x`, "epsilon", "alpha", "delta").

Status: PRE-CODE / PROPOSED (2026-09-23). Two calls to SETTLE before M1: the scope/theme (is
this the sliding-window + decay + drift package, with Exponential Histogram as reference?) and
the TIME SOURCE + bucket-pool substrate (ADR 0001). Each milestone is then a full pipeline
session (planner -> settle -> coder -> reviewer -> qa); the maintainer commits/publishes;
/release gate + catalog card sync after, exactly as lite-sketch.

## Milestones

| # | Member | Version | Headline (space, error, recency model) | Status |
|---|--------|---------|----------------------------------------|--------|
| **M0** | Package scaffold + the TIME SOURCE + the fixed bucket-pool substrate + the two-witness chassis | 0.1.0 (with M1) | caller-supplied monotone `now`; preallocated bucket pool; windowed + change-response witnesses | planned (ADR 0001) |
| **M1** | **ExponentialHistogram** (sliding-window count / sum) | 0.1.0 | `O((1/epsilon) log W)` buckets -> `<= epsilon` windowed error; HARD last-W window | planned (reference member, ADR 0002) |
| **M2** | **ADWIN** (drift detection + adaptive window) | 0.2.0 | EH-bucket list -> false-alarm `<= delta`; ADAPTIVE data-driven window | planned (the marquee member, ADR 0003) |
| **M3** | **ForwardDecay** (time-decayed count / sum / mean / rate) | 0.3.0 | landmark + O(1) accumulators -> EXACT decayed aggregate; DECAY half-life model | planned (ADR 0004) |
| **M4** | **HeavyKeeper** (decayed / windowed heavy hitters, top-k) | 0.4.0 | d x w table + top-k forest -> bounded overestimate, strong on skew; DECAY model | planned (ADR 0005) |
| -- | **1.0.0** -- API declared STABLE at four members | 1.0.0 | reference + 3, the lite-sketch cadence | planned |
| M5+ | SlidingHyperLogLog, scalar DriftDetector (Page-Hinkley/CUSUM/DDM), decayed Reservoir, windowed Count-Min / quantiles | post-1.0 | one per release (RESEARCH.md Tier 2) | backlog |

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

**Decayed Reservoir** and **DDM/EDDM error-rate detector** (unscheduled; NO lite-hud demand)
- Neither is a lite-hud requirement. The HUD never samples: its panels are aggregates. Its only 0/1
  stream (budget verdicts) is served by ADWIN.
- If either ships, the shared rules R1-R10 still apply, plus:
  - Reservoir: a Float64Array of samples plus an optional id column, and NEVER caller objects
    (retention). R9 seeded PRNG. `size` vs `capacity` getters, with empty reading as size 0.
    `forEach`/`copyInto` readers.
  - DDM/EDDM: a tri-state result (none / warning / drift) through a `state` getter. The input is
    strictly 0/1: a 0.5 throws, never a silent round.

**Windowed Count-Min** (IN DEVELOPMENT 2026-09-24; design suggestions from the lite-hud side)
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

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
