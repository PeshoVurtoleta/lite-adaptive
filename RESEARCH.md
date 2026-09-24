# lite-adaptive Research Notes

Blueprint: modeled on `../LiteSketch/RESEARCH.md` (the approximate-summary family)
and, one step back, `../LiteO1/RESEARCH.md` (the O(1) family) + `../LiteFilter`
(the honesty discipline). Same spine: identity, the analytical anchor, the
benchmark, the roster, the honesty hook, the sibling boundaries, a reference
member, the central design call, the demo, the path, the open questions.
ASCII-only (`->`, `<=`, `x`, "approx", "epsilon", "alpha" -- never Unicode).

Status: PROPOSED (pre-code, 2026-09-23). Theme + roster to be SETTLED with the
maintainer before the first member session. This document + ROADMAP.md are the
research pass; nothing is coded yet. The scope name (`@zakkster/lite-adaptive`)
and the reference member (Exponential Histogram) are the two calls to confirm
first -- see section 11.

---

## 1. Core Identity

`@zakkster/lite-adaptive` is a zero-GC, zero-runtime-dependency, single-file ESM
family of APPROXIMATE, sublinear-space streaming summaries over the TIME / RECENCY
axis -- one small structure per question you can only answer about the RECENT or
CHANGING stream, not the whole of it:

- **How many events in the LAST W?** (sliding-window count / sum) -- Exponential Histogram.
- **Did the distribution just CHANGE, and over what window is it stable now?**
  (concept-drift detection + adaptive windowing) -- ADWIN.
- **What is the DECAYED rate / average / top item?** (time-decayed aggregates, recent
  weighs more) -- Forward-Decay.
- **Which few keys dominate RIGHT NOW?** (decayed / windowed heavy hitters) -- HeavyKeeper.
- **How many DISTINCT items in the last W?** (windowed cardinality) -- Sliding HyperLogLog.

Every member trades a small, DISCLOSED, provable error for a huge space win AND for
the ability to FORGET: it answers a recency question in fixed memory that an exact
structure would need to buffer the whole window (O(W) items) to answer. Every hot op
(`add` / `update` / `tick`) is amortized O(1) and allocates ZERO bytes after
construction, over flat TypedArray bucket pools -- the lite-o1 zero-GC discipline,
carried into the time-adaptive world.

### The honest unifying thread

The suite already has three honesty anchors that are the SAME idea in three domains:
- **lite-o1** witnesses its COMPLEXITY: a flat throughput line vs a foil that curves away.
- **lite-filter** witnesses its ACCURACY: measured false-positive rate vs the paper's FPR.
- **lite-sketch** witnesses its ERROR: measured relative error vs the paper's bound.

lite-adaptive is the fourth: it witnesses its RECENCY. It carries lite-sketch's
"measured error vs the theoretical bound" anchor onto a WINDOWED / DECAYED oracle,
AND adds a second anchor unique to this axis: **change-response** -- measured drift
DETECTION LATENCY and FALSE-ALARM RATE against a stream with an INJECTED, known
changepoint. "The window adapts to real change and ignores noise -- and here is how
fast, and how rarely it cries wolf."

This is a real gap in the family. lite-sketch is CUMULATIVE (the whole stream,
unweighted, no forgetting). lite-o1's WindowFold / MonoDeque / RingLog are EXACT but
bounded-capacity and monoid-only. Neither answers "approximate distinct-count over the
last 10 minutes" or "has this metric drifted?" in fixed memory over an unbounded,
evolving stream. lite-adaptive is the home for FORGETTING and for CHANGE.

---

## 2. The Analytical Anchor: two witnesses (recency error + change response)

### 2.1 The windowed / decayed accuracy witness (`test/witness.mjs`)

The lite-sketch move, one axis over. For each member, over a sweep of window sizes W
(or decay half-lives) and stream sizes N:
1. Drive the member with an evolving stream (uniform, Zipfian, and a MIXTURE that
   shifts partway -- recency matters most when the stream changes).
2. Compute the exact recency ground truth with a naive oracle:
   - sliding-window count / sum: an exact ring buffer / deque of the last W items.
   - decayed aggregate: an exact decayed accumulator recomputed from the full history.
   - windowed distinct-count: an exact per-timestamp Set expired at the window edge.
3. Measure the member's error against that oracle and GATE it against the theoretical
   bound (each member's paper ships one):
   - Exponential Histogram: relative error on the windowed count `<= epsilon` by
     construction (bounded by the bucket-merge rule, `1/(2k)`-style) -- a HARD ceiling.
   - Sliding HLL: windowed cardinality relative error within ~3 sigma of `1.04/sqrt(m)`.
   - Forward-Decay: the decayed estimate matches the exact decayed accumulator within
     floating-point tolerance (it is EXACT in the aggregate, APPROX only in the
     heavy-hitter / sampled variants) -- a different, honest mode.
4. Show error SHRINKING as space grows (more buckets / registers -> tighter): the
   accuracy/space Pareto, the sketch analog carried to the window.

The foil: the EXACT windowed oracle, whose memory grows O(W) (it must hold the window)
while the member's is FIXED -- so the witness prints, alongside error, the memory the
exact answer would cost vs the member's constant KB. "Same recent answer, 1/1000th the
memory, and it forgets on its own."

### 2.2 The change-response witness (the anchor unique to this family)

For the adaptive / drift members (ADWIN and companions), the accuracy question is not
"how close to a number" but "how well does it track CHANGE." The witness drives a
stream with a KNOWN injected changepoint (a mean/rate shift at a known index) and
measures, against ground truth:
- **Detection latency**: how many items after the true change before it is flagged.
- **False-alarm rate**: flags raised during a genuinely STATIONARY run (should be
  bounded by the detector's `delta` confidence parameter).
- **Missed-detection rate**: real changes never flagged (should be ~0 for a large shift).
- **Adapted-window correctness**: after a change, the reported window/mean reflects the
  NEW concept only (the old regime is dropped).
GATE: false-alarm rate `<= delta` on a stationary stream, and detection latency below a
bound that scales with the shift magnitude (small shifts are allowed to take longer --
disclosed, not hidden). This is the drift analog of "the error bound is real."

### 2.3 The zero-GC witness (`test/torture.mjs`)

Unchanged from lite-o1 / lite-sketch: `node --expose-gc test/torture.mjs` drives each
member's hot ops under @zakkster/lite-leak + @zakkster/lite-gc-profiler and asserts
0 B/op and 0 retained growth -- INCLUDING the bucket-merge / bucket-expire / window-drop
paths (the adaptive members' amortized reshaping must not allocate). A member that
allocates per `add`, or whose window resize churns the heap, is disqualified.

---

## 3. The Benchmark Suite (the ecosystem MVP)

Fork the lite-sketch bench chassis; the recency dimensions differ:

1. **Recency error vs space** -- windowed/decayed error at each bucket/register budget.
2. **Error vs window size W (or half-life)** -- does the bound hold as W grows?
3. **Response to change** -- detection latency + false-alarm rate vs shift magnitude
   (the drift Pareto: faster detection buys more false alarms).
4. **Error vs skew + drift** -- uniform / Zipfian / concept-shifting mixtures.
5. **Throughput** -- ops/ms of `add` / `tick` (must stay flat -- the amortized-O(1) claim).
6. **Space** -- bytes per member vs the exact windowed oracle's O(W) footprint.
7. **0 B/op** -- the allocation dimension (incl. the reshaping paths), shared with the suite.

MEASURED vs THEORETICAL side by side (the lite-filter table shape), plus, for drift, a
changepoint timeline (true change vs detected change).

---

## 4. The Candidate Roster (all candidates)

### 4.0 Verdict on the inherited backlog (answering "are these enough?")

The lite-sketch post-1.0 backlog in memory was `KMV/MinHash, CountSketch, HeavyKeeper,
SlidingHLL`. Judged as lite-ADAPTIVE candidates:

- **HeavyKeeper -- KEEP (Tier 1).** It IS an adaptive structure: exponential-decay
  count-with-eviction, markedly better than Space-Saving on skewed / evolving streams.
  It belongs here, not in cumulative lite-sketch.
- **Sliding HyperLogLog -- KEEP (Tier 1/2).** Windowed cardinality is squarely the
  recency axis. (Zero-GC is harder here -- see the member note -- so it may be Tier 2.)
- **KMV / MinHash -- RE-ROUTE to lite-sketch.** Plain whole-stream cardinality +
  set-similarity; no recency dimension. It is lite-sketch's own post-1.0 work.
- **CountSketch -- RE-ROUTE to lite-sketch.** Plain whole-stream (signed / L2)
  frequency; not adaptive. lite-sketch post-1.0.

So the memory list is NOT enough for lite-adaptive: 2 of 4 fit, 2 belong elsewhere, and
it OMITS the highest-value members of this axis -- the sliding-window primitive
(Exponential Histogram / DGIM) and the whole reason to have this package
(drift detection: ADWIN, and the cheap scalar detectors), plus time-decay
(Forward-Decay). Those omissions, not KMV/CountSketch, are the reference material.

### Tier 1 -- core roster (the members to ship, in order)

| Member | Question | Bound | Substrate | Notes |
|--------|----------|-------|-----------|-------|
| **ExponentialHistogram** | count / sum over the last W (sliding window) | relative error `<= epsilon` (HARD, by the bucket-merge rule) | fixed pool of (timestamp, size) buckets grouped by level | Datar-Gionis-Indyk-Motwani (SODA 2002); DGIM is its 0/1 special case. THE foundational sliding-window primitive + the FLAGSHIP / reference member: defines the bucket substrate, the windowed witness, the time source. `add(t)` / `add(t, v)` / `query()` amortized O(1), 0 B/op (merge-on-overflow within the fixed pool). |
| **ADWIN** | did the stream drift? + the current stable window's mean | false-alarm `<= delta`; detection latency scales with shift | an EH-style bucket list over the fixed pool | Bifet-Gavalda (SDM 2007). The marquee member -- adaptive windowing with NO magic window size: grows while stable, SHRINKS on detected change. Built on the M1 bucket substrate. `add(x)` -> boolean (drift?) + `mean` / `width` getters. The change-response witness lives here. |
| **ForwardDecay** | time-decayed count / sum / mean / rate (recent weighs more) | EXACT in the aggregate (approx only in decayed-topk) | a landmark + O(1) decayed accumulators | Cormode-Shkapenyuk-Srivastava-Xu (ICDE 2009). The DECAY axis (vs EH's hard window). Generalizes EWMA; forward-decay avoids the drift of backward-decay. Tiny, trivially 0-GC. `add(t, v)` / `count()` / `mean()` at a query landmark. Base for decayed heavy hitters. |
| **HeavyKeeper** | decayed / windowed heavy hitters (top-k right now) | overestimate bounded; strong on skew | a d x w (fingerprint, count) table + a top-k min-heap | Gong et al. (USENIX ATC 2018). The adaptive top-k: probabilistic exponential-decay count-with-eviction, far lower error than Space-Saving on Zipfian / evolving streams. REUSES lite-o1's intrusive min-forest idiom for the top-k (design-parity). `add(key)` / `topK()`. |

### Tier 2 -- strong candidates (next releases)

| Member | Question | Notes |
|--------|----------|-------|
| **SlidingHyperLogLog** | distinct-count over the last W | Chabchoub-Hebrail (2010): per-register lists of "possible future maxima" timestamped and expired at the window edge. Zero-GC is the challenge (per-register variable lists) -- a fixed per-register ring with a disclosed capacity bound is the honest zero-GC form. |
| **Scalar drift detectors (Page-Hinkley / CUSUM / DDM / EDDM)** | lightweight change detection | O(1) SCALAR state, trivially zero-GC; a cheaper companion to ADWIN when a fixed threshold is acceptable. Could ship as one small `DriftDetector` with a mode flag. |
| **Time-biased / decayed reservoir** | a recency-weighted sample of the stream | Aggarwal (VLDB 2006), exponential-bias reservoir. The adaptive complement to lite-o1's UNIFORM whole-stream `Reservoir`. Fixed sample array + weights, 0-GC. |
| **Windowed / decayed Count-Min** | frequency over the last W / decayed | EH-backed or forward-decayed counters; windowed point queries. |
| **Sliding-window quantiles** | p50/p99 over the last W | sliding DDSketch or Arasu-Manku windowed quantiles; evaluate the zero-GC bucket-expiry cost. |

### Tier 3 -- adjacent / evaluate

- **Lossy Counting** (Manku-Motwani, VLDB 2002): approximate frequent items with an error
  `epsilon` over batched windows. Borderline -- its batch-decay flavor fits here, but plain
  whole-stream frequent-items is lite-sketch. Evaluate against HeavyKeeper; likely a note.
- **Stable Bloom / time-decaying Bloom filter**: approximate membership that FORGETS old keys.
  Recency membership -- sits on the lite-adaptive / lite-filter seam; route by whichever owns
  the decay policy. Evaluate; do not ship without settling the boundary.
- **t-digest / moment sketches over a window**: allocation-heavy merges -- deferred, as in lite-sketch.
- **Concept-drift ML ensembles / learned models**: OUT -- these are models, not zero-GC data structures.

### The boundary -- what is explicitly OUT (and why)

- **EXACT sliding-window aggregation over a monoid** (windowed sum / min / max / and/or/xor)
  -> lite-o1 `WindowFold` / `WindowFoldUint32` / `MonoDeque` / `RingLog`. Those are EXACT and
  bounded-capacity. lite-adaptive is the APPROXIMATE / unbounded-window / large-domain complement:
  windowed DISTINCT-count / frequency / heavy-hitters / drift, where exact windowing is too big.
- **Whole-stream cumulative approximate summaries** (HLL, Count-Min, DDSketch, Space-Saving,
  KMV, CountSketch) -> lite-sketch. The line is RECENCY: cumulative -> lite-sketch; windowed /
  decayed / drift -> lite-adaptive.
- **Exact uniform whole-stream sampling** -> lite-o1 `Reservoir` (Algorithm R). The decayed /
  time-biased reservoir is the lite-adaptive complement.
- **Approximate membership** -> lite-filter (decaying membership is the one seam to settle).
- **Caches / eviction** -> lite-lru.

### REJECTED / re-routed (recorded so they are not re-proposed)

- KMV/MinHash, CountSketch -> lite-sketch post-1.0 (section 4.0).
- Bloom-family filters -> lite-filter.
- WindowFold / MonoDeque exact windowing -> lite-o1 (already shipped).

---

## 5. The Recency + Approximation Honesty Hook

lite-sketch's hook is error-honesty (the bound is a co-headline). lite-adaptive adds a
RECENCY-honesty hook -- what "forgetting" actually costs and how fast "change" is seen:

- Every member's headline is a TRIPLE: the space it costs, the error it guarantees at that
  space, AND the recency model (hard window W vs decay half-life vs adaptive/auto window).
  "O((1/epsilon) log W) buckets, `<= epsilon` windowed error, hard last-W window" -- all three.
- Hard window vs decay is stated: EH forgets EXACTLY at the window edge; Forward-Decay never
  fully forgets (weights decay smoothly); ADWIN forgets ADAPTIVELY (window boundary is
  data-driven). A caller must know which model they bought.
- Detection is disclosed as a TRADE, never as magic: a drift detector's false-alarm rate,
  detection latency, and minimum detectable shift are stated together and gated in the
  change-response witness. No detector "just works"; each has a confidence knob with a cost.
- The time source is disclosed: members driven by a caller-supplied logical tick vs
  wall-clock vs an item counter -- stated per member, never assumed (section 8).

---

## 6. Boundaries with sibling packages (no duplication)

- **lite-o1** -- EXACT and bounded. `WindowFold`/`WindowFoldUint32` (exact monoid windowed
  fold), `MonoDeque` (exact windowed min/max), `RingLog` (last-N ring), `Reservoir` (exact
  uniform sample). lite-adaptive is the APPROXIMATE / unbounded-window / drift complement.
- **lite-sketch** -- CUMULATIVE approximate summaries (whole stream, no forgetting).
  lite-adaptive is the same questions with a WINDOW / DECAY / drift lens. (HeavyKeeper here is
  the adaptive sibling of lite-sketch's Space-Saving; Sliding HLL of its HyperLogLog.)
- **lite-filter** -- approximate membership. The decaying-membership seam (stable Bloom) is the
  one boundary to settle explicitly.
- **lite-lru** -- caches / eviction. Not a summary.
- **DESIGN-PARITY, never a dep** (the family law): HeavyKeeper reuses lite-o1's FreqO1 /
  BucketQueue intrusive min-forest IDIOM for its top-k; the members reuse lite-sketch's shipped
  hash IDIOM for keying -- by copying the technique, NEVER importing (zero runtime deps).

---

## 7. Reference Implementation: Exponential Histogram (the headline member)

EH is to lite-adaptive what HyperLogLog is to lite-sketch: the reference member that defines
the substrate (the fixed bucket pool + the time source), the windowed witness, and the
recency-honesty contract. It is the most foundational recency question -- "how many / how much
in the last W" -- and ADWIN and the windowed counters build directly on its buckets.

- **Substrate**: a FIXED pool of buckets, each a `(timestamp, size)` pair over parallel
  `Float64Array` (or `Uint32Array`) columns, grouped into LEVELS by size. The bucket count is
  bounded by `O((1/epsilon) log(epsilon W))`, so the pool is preallocated at construction and
  NEVER grows -- the lite-o1 fixed-capacity discipline.
- **add(now)** / **add(now, value)** (hot, amortized O(1), 0 B/op): open a size-1 bucket at
  `now`; while more than `k = ceil(1/(2 epsilon)) + 1` buckets share a level, MERGE the two
  oldest at that level into one of double size (a cascade, bounded and amortized O(1) -- the
  disclosed reshaping op). Expire buckets whose timestamp fell out of `[now - W, now]`.
- **query()** (O(buckets), a query not a per-item op): sum the sizes of live buckets, minus
  half the oldest straddling bucket (the standard EH estimate) -- windowed count within
  `<= epsilon` relative error. O(buckets) is a disclosed co-headline (buckets is small + fixed),
  not a per-add cost.
- **merge(other)** where meaningful (distributed windows), `clear()`, getters `windowSize` /
  `epsilon` / `bucketCount`.
- **Fail closed**: a bad W / epsilon at construction throws `[lite-adaptive]` before allocation
  (typeof-first); `add` typeof-guards a monotone-nondecreasing `now` (a time going backwards is a
  throw, byte-identical no-op); `query` never throws.
- **Witness**: windowed count error `<= epsilon` on every query vs the exact-ring oracle over a
  W-sweep and a shifting stream; error shrinks as epsilon tightens (more buckets).

The exact-ring oracle it is measured against grows O(W); EH stays O((1/epsilon) log W) -- the
space co-headline the witness prints. DGIM (the 0/1-stream special case) is the same code with
`value = 1`; ship EH and note DGIM as the special case in the ADR.

---

## 8. The Central Design Call: the window model + the time source (load-bearing)

lite-adaptive's equivalent of "which hash" for lite-sketch. The calls to settle at ADR 0001:

1. **The time source.** Members need a notion of "now." Options: (a) a caller-supplied LOGICAL
   tick / item index (deterministic, testable, zero-dep -- the lite-o1 TimerWheel `now` model);
   (b) an item COUNTER the member increments itself (count-based windows); (c) wall-clock ms
   (time-based windows). LEAN: a caller-supplied monotone `now` (logical or ms -- the member does
   not read the clock), with a count-based convenience for the "last N items" case. Never read
   the clock internally (untestable, non-deterministic) -- the caller owns time.
2. **The window model per member**, stated in its headline: HARD window (EH, count/time-based),
   DECAY (Forward-Decay, a half-life), or ADAPTIVE (ADWIN, data-driven). One package, three
   honest models -- documented, never conflated.
3. **The fixed bucket pool** is the shared substrate (like lite-sketch's register array): a
   preallocated pool sized to the theoretical bucket bound, a free-list for merge/expire, NO
   per-op allocation. This is the M1 deliverable every later member reuses.
4. **Keying** (for the frequency / heavy-hitter members): reuse lite-sketch's shipped two-lane
   hash IDIOM (design-parity, not a dep) -- numeric-key core + an alloc-free string hasher.
5. **Confidence / error knobs**: EH's `epsilon`, ADWIN's `delta`, Forward-Decay's half-life --
   each a single constructor scalar with a disclosed cost, validated fail-closed.

Settle the time source + the bucket-pool substrate FIRST -- they gate every member, exactly as
the hash gated every lite-sketch member.

---

## 9. The Demo (later, in the style of lite-o1 / lite-sketch)

Once 2-3 members ship. The natural visualization: a live stream with a moving window highlighted;
the exact windowed oracle's memory bar climbing with W while the member's stays a flat sliver; the
windowed estimate tracking the truth inside a shaded `epsilon` band; and -- the money shot -- a
regime CHANGE injected mid-stream, with ADWIN's adaptive window visibly SHRINKING to the new
concept and a "drift detected" marker landing a measured latency after the true changepoint.
Recency + change made kinetic. Repo-only, zero-GC frame path (the lite-o1 demo law).

---

## 10. Recommended Path

1. Settle the TIME SOURCE + bucket-pool substrate (section 8, ADR 0001) FIRST -- blocks everything.
2. **M1 ExponentialHistogram** (v0.1.0): the reference member; stand up the bucket substrate, the
   windowed witness, the torture gate, the bench chassis, the README blueprint, the time source.
3. **M2 ADWIN** (v0.2.0): drift detection + adaptive window on the M1 buckets; the change-response
   witness -- the marquee capability, and the reason the package exists.
4. **M3 ForwardDecay** (v0.3.0): the decay axis (vs EH's hard window); EXACT decayed aggregates +
   the base for decayed heavy hitters. A different, honest witness mode.
5. **M4 HeavyKeeper** (v0.4.0): decayed / windowed top-k; the FreqO1 min-forest idiom reuse; the
   adaptive sibling of lite-sketch's Space-Saving.
6. **1.0.0** at four members (the lite-filter / lite-sketch cadence: reference + 3), API stable.
   Sliding HLL, scalar drift detectors, decayed reservoir, windowed Count-Min / quantiles follow
   post-1.0, one per release.

Each member is a full pipeline session (planner -> settle -> coder -> reviewer -> qa); the
maintainer commits/publishes; /release gate + catalog card sync after -- identical to lite-sketch.

---

## 11. Open Questions

1. **Scope / theme confirmation** (the first call): is `@zakkster/lite-adaptive` the
   sliding-window + decay + drift package as framed here, and is Exponential Histogram the right
   reference member (vs leading with ADWIN, the flashier but heavier drift flagship)? LEAN: EH
   first (foundational, defines the substrate the others reuse), ADWIN second.
2. **The time source** (section 8) -- caller logical tick vs item counter vs wall-clock. LEAN:
   caller-supplied monotone `now` + a count-based convenience; never read the clock internally.
3. **Window model surface**: three models (hard / decay / adaptive) across the roster -- distinct
   classes (the lite-o1 / lite-sketch model), each stating its model, vs one windowing interface.
   LEAN: distinct classes, a shared bucket substrate + witness harness.
4. **Sliding HLL zero-GC**: per-register timestamp lists allocate; a fixed per-register ring with
   a disclosed capacity bound is the honest zero-GC form -- confirm the trade before committing it
   to Tier 1 (else it is Tier 2).
5. **Drift detectors: one member or many?** ADWIN (adaptive, no threshold) as the Tier-1 flagship;
   Page-Hinkley / CUSUM / DDM as a single lightweight `DriftDetector` (mode flag) in Tier 2, or
   each its own member. LEAN: ADWIN in Tier 1, a bundled scalar `DriftDetector` in Tier 2.
6. **The decaying-membership seam** (stable Bloom / time-decaying Bloom): lite-adaptive or
   lite-filter? Settle who owns the decay policy before either ships it.
7. **Naming**: `ExponentialHistogram` vs `EH`; `ForwardDecay` vs `DecayedAggregate`. LEAN: full,
   discoverable names (the suite spells out `HierarchicalTimerWheel`, `CountMinSketch`).
8. **Package scope / name**: `@zakkster/lite-adaptive`, folder `LiteAdaptive`, main file
   `Adaptive.js`. Confirm before the GitHub wire-up.

---

## 12. Post-1.0 warnings -- the evidence behind ROADMAP section 6 (2026-09-23)

The same failure repeated across four sibling audits in one day. Each package passed its own
zero-GC gates while still boxing, or while failing open, because the gate inputs were friendlier
than real inputs. The lite-adaptive members take fractional timestamps on every call, so they are
more exposed than any of those packages.

| Lesson | Where it was measured | What it means here |
| --- | --- | --- |
| A fractional double passed to a non-inlined call boxes (~16 B); measureAllocs cannot see it | lite-hud M2: DDSketch.add, paired 24 -> 43 scaling scavenges; fixed by addFrom (lite-sketch 1.1.0) | R1: every `now`/value-taking method ships `addFrom` |
| Small-integer inputs hide boxing | lite-hud M2 gates were Smi-only; lite-lru torture TTL clock counted up from 0 | R2: epoch-ms and performance.now scales, large keys, keys read from typed arrays |
| A helper that RETURNS a computed double boxes once its call site goes polymorphic | lite-lru 1.18.0 A1: `expiryFor` 0 in a fresh process, ~31.5 B/op after a TTL-off instance ran; inlining fixed it | R3: warm up with other configs first; never return a computed double from a hot-path helper |
| A default argument is part of the hot path | lite-lru A2: default `Date.now` 15.7-31.5 B/op | the members never read a clock (law); keep it that way |
| Integer keys beyond Smi range box | lite-lru A8: W-TinyLFU keys below -2^30, 15.7 B/op | R2 key-magnitude lane; HeavyKeeper and SlidingHLL keys go through addFrom |
| NaN slips through `>=`-style guards | lite-lru A6: a NaN clock meant entries never expired | R5 |
| A second door skips the first door's checks | lite-lru A4 (DirectLru options), A3/A5 (restore) | R6 |
| A "read-only" query that expires state is a mutation | lite-lru A11 | R7 |
| Configuration learned by catching errors | lite-sketch N1, lite-filter N2-N3 | R8 (already law since 2026-09-23) |

Design warnings specific to the Tier-2 members (numbers from the ROADMAP 6.2 sizing):
- **SlidingHLL memory.** A per-register ring is the only honest zero-GC form (open question 4), and
  it multiplies HLL's m bytes by ~9 x ringCap. p=12 with ring 8 is ~288 KB. The default must be
  chosen for a consumer running many instances, and ring overflow must be visible.
- **Windowed Count-Min.** An EH per cell (the ECM-sketch, VLDB 2012) is ~6 MB at ordinary sizes, so
  use B+1 panes. Keep the oldest partial pane, so the estimate stays a one-sided upper bound, and
  sum across panes before taking the min over rows. The rotation loop must be bounded by B+1
  panes, not by the size of the time jump. Suggestions in ROADMAP 6.2.
- **Idle-stream freeze (R11).** Every windowed member expires lazily relative to `lastNow`, so a
  stream that stops receiving adds keeps reporting its last window forever. That fails open for a
  live display: a "0 distinct in the last 5 s" reads as the old burst. `advance(now)` fixes it
  without making queries mutate.
- **Sliding quantiles are a compatibility problem more than an algorithm problem.** If the accepted
  value band, the zero/negative policy or the empty-window readout differs from lite-sketch
  DDSketch, every consumer's pre-check (lite-hud M2's getter-driven band) is silently wrong. Reuse
  the mapping.
- **DriftDetector is real-valued only** (Page-Hinkley / CUSUM). The Bernoulli error-rate detectors
  (DDM/EDDM, tri-state) were split into their own unscheduled contract, because one class with
  mixed input domains is a fail-open trap. Post-alarm reset semantics decide whether a consumer's
  "regime changed" marker fires once or keeps firing.
- **Decayed Reservoir and DDM/EDDM have no lite-hud demand.** If either ships, the reservoir must
  never hold caller objects (retention outside the member's control; store numbers and ids only).


MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- never "Karadjov".
