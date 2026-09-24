# ADR 0008 -- SlidingDDSketch (windowed relative-error quantiles over a fixed-B pane ring)

Status: ACCEPTED (2026-09-24). The THIRD additive post-1.0 member (MINOR 1.3.0). PURE APPEND: the
six prior classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
DriftDetector) stay BYTE-IDENTICAL; only the file header + the `VERSION` const change above the
append point, plus the appended SlidingDDSketch class and its `SLD_*` consts.

## Context

The family already windows COUNT / SUM (ExponentialHistogram), DISTINCT (SlidingHyperLogLog), and
detects drift (ADWIN, DriftDetector). What it does NOT have is the QUANTILE corner on the recency
axis: "what is the p50 / p90 / p99 of the values in the LAST W" in fixed space. lite-sketch's
cumulative DDSketch (ADR 0004; Masson-Rim-Lee, "DDSketch: A Fast and Fully-Mergeable Quantile Sketch
with Relative-Error Guarantees", VLDB 2019) answers it over the WHOLE stream with a HARD per-query
relative bound `|q_est - q_true| <= alpha * q_true`. SlidingDDSketch is its RECENCY sibling -- the
same log-scale bucketing over a sliding window -- and the quantile complement of SlidingHyperLogLog.
It unblocks the lite-hud latency-panel use case (a rolling p99 of span durations).

## Decision -- window model A: a fixed-B ring of DDSketch panes

Three windowing strategies were on the table. The chosen one is **A -- a fixed-B pane ring**.

- **A (ACCEPTED) -- fixed-B pane ring.** B preallocated DDSketch panes, each covering `W/B` of the
  window, held in a ring. `add(now, value)` writes the CURRENT pane; when `now` crosses a pane
  boundary the ring rotates to the next pane and CLEARS it (`fill(0)`, 0-alloc). A `now` jump of many
  pane-widths expires multiple panes in a bounded while-loop CAPPED at B iterations (skipping >= B
  panes clears them ALL, then re-anchors the ring around `now`). `quantile` / `quantileInto` / `count`
  MERGE the live panes into an INSTANCE-OWNED preallocated scratch (cold, 0-alloc -- never a per-query
  allocation). Every hot op is a bounded index manipulation on preallocated columns -- a true 0 B/op,
  the discipline the suite sells. The cost is a disclosed window-EDGE error of up to one pane width
  (`W/B`): the oldest live pane straddles the window boundary and is counted in full.

- **B (REJECTED) -- an EH/DGIM-style exponential histogram OF DDSketches.** Merge-on-add (the DGIM
  bucket cascade folds two DDSketches into one) ALLOCATES / walks a variable number of buckets per
  add and mutates sketch structure on the hot path -- not a bounded 0-B/op op. It buys a tighter,
  logarithmically-graded edge error, but at the cost of the family's zero-GC headline. Rejected.

- **C (REJECTED) -- Arasu-Manku windowed quantiles.** Their sliding-window quantile summary keeps
  per-item state whose size grows with the window and the accuracy target (unbounded per-item
  bookkeeping), which is neither fixed-space nor zero-GC. Rejected for the same reason DDM/EDDM's
  per-item contract was rejected in ADR 0007: it does not fit the preallocated-pool discipline.

Default `panes = B = 32` (the `panes` option, caller-tunable, an integer in `[2, 1024]`). Edge error
`W/32`. More panes -> a tighter edge but more memory (`panes * SLD_MAX_BINS` Uint32 bins).

## The pane rotate-and-clear model (grid-aligned)

Each pane holds an EXCLUSIVE upper time bound `paneEnd[p]`; pane `p` covers `[paneEnd[p] - pw, paneEnd[p])`
with `pw = W / panes`. The first add ANCHORS the ring grid-aligned: the current pane's end is
`E = (floor(now / pw) + 1) * pw` and predecessors step back by `pw` each. An add rotates while
`now >= paneEnd[cur]` (clearing each pane it rotates onto), capped at B rotations; a jump of >= B panes
clears the whole ring and re-anchors. So the ring always covers `[E - W, E)` -- exactly B panes of `pw`
each -- and `E` can sit up to `pw` ABOVE `now`, which is the source of the (disclosed) edge error: the
retained window is `(E - W, now]`, up to one pane width SHORTER than the ideal `(now - W, now]`.

`count` sums the live panes' counts; `quantile` / `quantileInto` MERGE the live panes into the
instance-owned scratch and walk it -- both COLD, both 0-alloc (the scratch is allocated ONCE at
construction and reused, NEVER per query). An empty window returns NaN (quantile) / 0 (count) with a
merged total of 0 -- never a throw, never a silent wrong number.

## The DDSketch mapping -- INLINED, not depended on (design parity)

The log-scale bucketing is reimplemented INLINE, byte-for-byte faithful to lite-sketch DDSketch (ADR
0004), NEVER an import: `gamma = (1 + alpha) / (1 - alpha)`, `key(x) = ceil(ln(x) * multiplier)` with
`multiplier = 1 / ln(gamma)`; a value `x > 0` bins on the log scale, `x === 0` routes to a per-pane
zero counter (the smallest value), `x < 0` fails closed (log is undefined for non-positives). Bins
collapse-lowest by default (protecting the p90/p99 tail -- collapsing-HIGHEST would degrade exactly the
quantiles a sketch is bought for), with a `strict` opt-in that throws on a collapse instead. The getter
NAMES mirror DDSketch: `alpha` / `strict` / `minIndexable` / `maxIndexable` / `collapsed`. The indexable
band (`minIndexable` / `maxIndexable`) is computed with DDSketch's exact ctor-time cold-verification loop,
so **the accepted value band is IDENTICAL to lite-sketch DDSketch** at every practical alpha. RATIONALE
for inlining vs depending: a consumer (lite-hud M2) pre-checks a value against this mapping identically to
lite-sketch DDSketch; a shared dependency would couple release cadences and any divergence in the accepted
band would be a breaking surprise -- inlining freezes the contract in one file.

## The pane-boundary collapse subtlety (WITNESSED, not assumed)

Each pane is an INDEPENDENT DDSketch: it anchors and collapses its OWN lowest bins based on the values IT
saw. So the merged min-key across the B live panes can differ from the min-key a single cumulative
DDSketch would have -- the merge re-folds every pane's populated keys through the SAME collapsing-lowest
logic on the scratch, which can collapse further. Because of this, the per-query accuracy bound and the
edge bound are WITNESSED, not assumed: `test/witness.mjs` drives `sldDrive` on positive streams against an
EXACT sorted-array oracle over the sketch's LIVE pane content (replicating the grid-aligned retention
exactly) and GATES the relative error `<= alpha` on 100% of >= 2000 queries across 3 W x 3 alpha + a
distribution SHIFT + a post-burst edge, and separately asserts the window-edge error `<= W/panes`. Two
negative controls the same gates REJECT: a NO-EXPIRY variant (`_clearPane` disabled -> stale values from
prior ring cycles linger -> rel >> alpha) and a COARSE `panes = 2` variant (edge error ~W/2, far above the
fine `W/32` bound -- proving the pane count is load-bearing for the edge).

## SoA store, saturation, and the merge scratch (types)

Per-pane bin counts are `Uint32Array(panes * SLD_MAX_BINS)` -- non-negative frequencies, so Uint32 gives
the full `2^32 - 1` saturation ceiling and matches the suite's SATURATE-NEVER-WRAP policy (the
CountMinSketch precedent). A bin count CLAMPS at `0xFFFFFFFF` and never wraps. This is the ONE recorded
DEVIATION from lite-sketch DDSketch, whose bins are `Float64Array` (DDSketch needs an exact cumulative
count for its single global rank walk; here the per-pane counts are summed into a Float64 scratch before the
walk, so per-pane Uint32 saturation only bites at an astronomically unlikely 4-billion-adds-to-one-bucket-
in-one-pane-time-slice, a fail-safe not a common case, while the merged total stays exact). The instance-
owned merge scratch is therefore `Float64Array(SLD_MAX_BINS)` so summing B near-saturated panes stays exact
to `2^53` -- the merged rank walk never overflows. Per-pane offset / max-key / anchored-flag live in
`Int32Array(panes)`; per-pane count / zero-count / pane-end in `Float64Array(panes)`.

`SLD_MAX_BINS = 2048` -- matches lite-sketch DDSketch's default `maxBins` so the per-pane accuracy contract
is identical (the alpha guarantee holds unless a pane's value RANGE exceeds 2048 log-buckets and its low end
collapses; disclosed via `collapsed`).

## Fail-closed domain -- `SLD_KEY_MAX` (the ADWIN / DriftDetector overflow lesson)

`SLD_KEY_MAX = 1 << 30`. Per-pane bin offsets live in `Int32Array`; a bucket key beyond `+/- SLD_KEY_MAX`
would overflow the offset arithmetic and silently corrupt the merge. `add` / `addFrom` reject a value whose
key would exceed `SLD_KEY_MAX` fail-closed (a byte-identical no-op). The per-alpha indexable band (computed
like DDSketch) is intersected with `SLD_KEY_MAX`; for every practical alpha the indexable band is far
tighter, so `SLD_KEY_MAX` only bites at a pathologically small alpha whose offsets would not fit Int32 --
mirroring the ADWIN finite-square-overflow and the DriftDetector `DD_X_MAX` fail-closed caps: an unverified
numeric state is an error, never a silent wrap.

## Fail-closed surface + the byte-identical no-op ordering

The ctor throws `[lite-adaptive]` on a bad W / alpha / strict / panes / unknown-option BEFORE any
allocation (no half-built instance). `add` validates the VALUE (typeof / NaN / +-Infinity / negative /
out-of-indexable) FIRST, then the TIME (mode switch / non-finite / decreasing `now`) -- ALL before any
state write, so every value-domain / indexable / time rejection is a BYTE-IDENTICAL no-op (the
SlidingHyperLogLog ordering). A STRICT collapse rejection is the one exception it discloses: it throws
after the time model has advanced (time is monotone and value-independent -- it advances on every add
regardless), but BEFORE any bin/count write, so the quantile/count state is intact; and a strict reject
can only occur on an add that did NOT rotate (a freshly-rotated pane always anchors its first value), so
no pane state is corrupted either. `strict = false` and `value = 0` are guarded distinctly (`null` is not
zero, `null` is not false). `quantile` throws on `q` outside `[0, 1]` or a sub-window outside `(0, W]` and
returns NaN on an empty window; `count` returns 0 on empty; `quantileInto` writes NaN per bad entry.

`addFrom(buf, i)` is the ZERO-BOX entry (`now = buf[i]`, `value = buf[i + 1]` read UNBOXED from a
caller-owned Float64Array), EXPLICIT-time only; its hot body is DUPLICATED from `add` (not delegated) to
keep `add`'s hot body byte-identical and avoid re-boxing at an internal call boundary -- the N7 idiom shared
with ADWIN / ForwardDecay / HeavyKeeper / SlidingHyperLogLog / DriftDetector.

## Space + the honesty anchor

SPACE: a FIXED ring of `panes` dense `Uint32Array(2048)` bin stores + per-pane Float64/Int32 bookkeeping +
one `Float64Array(2048)` merge scratch; never grows (`panes = 32` -> ~256 KB). The torture gate proves
`add` / `addFrom` (incl. pane rotate + clear + collapse) / `quantile` (merge) / `quantileInto` / `clear`
are each 0 B/op with `gc major = 0`, plus a retention check (bytes constant + count returns to baseline over
10 clear/refill cycles). The witness (above) proves the accuracy + edge bounds and rejects the two negative
controls. This member closes the quantile gap on the recency axis; further windowed members (windowed
Count-Min, a decayed reservoir, an error-rate DDM/EDDM detector) remain possible post-1.3, each a pure
append that keeps the frozen classes byte-identical.
