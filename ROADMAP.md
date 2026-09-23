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
- After M4: declare 1.0.0, API stable; post-1.0 backlog (SlidingHLL, scalar DriftDetector, decayed
  Reservoir, windowed Count-Min / quantiles), one per release.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
