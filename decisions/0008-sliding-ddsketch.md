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

## Amendment (1.7.0 F2, settle S8) -- strict semantics, declared range, span-based strict

`SlidingDDSketch` now matches lite-sketch DDSketch's strict/range contract exactly. Two strict
regimes, both fail-closed (a strict pane NEVER collapses -- `collapsed` stays false):

- **Declared `range: [rmin, rmax]`** DERIVES strict (parity with lite-sketch, where `strict` is
  derived from `range`, not a standalone flag). It is validated typeof-first BEFORE any allocation:
  an Array of length 2, both ends finite numbers with `0 < rmin < rmax`, both inside the alpha
  indexable band, and `nb = keyHi - keyLo + 1 <= SLD_MAX_BINS` (else a tagged throw naming the widest
  representable `rmax/rmin` at this alpha). The bin offset is PINNED at `rangeKeyLo = ceil(ln(rmin) *
  mult)` in every pane -- pre-anchored in `_initState` / `_clearPane` (the loops stay keyed off the
  pane count, so a future B+1 ring inherits it), so `_addKeyPane`'s first-value TOP anchor is never
  taken and no in-range value can ever slide or collapse. `strict: false` with a declared `range` is
  a contradiction and throws. Fields `_rangeMin` / `_rangeMax` (NaN when undeclared) + `_rangeKeyLo`
  / `_rangeKeyHi` back the `rangeMin` / `rangeMax` getters.

- **`strict: true` WITHOUT a `range`** is SPAN-BASED, not a bottom anchor. A bottom anchor (pin the
  window floor at the first value) merely moves the bug to FALLING values: `add(0, 1); add(1, 0.5)`
  would then reject the second, smaller value. Instead a strict pane throws only when its OCCUPIED key
  span `[minKeyPop, maxKeyPop]` including the new key would exceed `SLD_MAX_BINS`; otherwise it
  RE-ANCHORS the maxBins window LOSSLESSLY -- on a key above the ceiling it shifts the occupied bins
  DOWN (`copyWithin` + `fill`, O(maxBins), disclosed cold), on a key below the floor it shifts them UP.
  No occupied bin is ever lost (the span-fits check guarantees it), so strict is exactly "fits or
  fails", never a silent collapse.

The hot key gate (`k > _maxKey || k < _minKey`) is UNCHANGED in shape: `_minKey` / `_maxKey` are set
to the ACCEPTED band = the alpha indexable band intersected with any declared range, so an out-of-band
value is rejected by the SAME two-comparison gate with no new hot branch. The cold thrower names the
declared range when present, else the indexable band. A new per-pane `_minKeyPop` (Int32Array) tracks
the low end of the occupied span; it is maintained ONLY where `_maxKeyPop` already is (one extra
compare in the in-window fast path, read only on the strict cold re-anchor). `minIndexable` /
`maxIndexable` are ALPHA-ONLY -- computed from the indexable band, NOT the accepted band -- so they are
Object.is-identical across non-strict / strict / range. NON-STRICT behavior (top anchor +
collapsing-lowest fold) is BYTE-IDENTICAL to 1.6.0, gated on `_strict` and proven by a 200k-sample
differential vector (test/differential/sdd-1.6.0-vectors.json). This amendment makes no choice that
conflicts with a future F7 move of the ring to B+1 panes: the single `bytes` formula and every fill
loop stay keyed off the pane count.

## Amendment (1.7.0 F7 / F5 / F12) -- B+1 ring, 0-alloc quantileInto, NaN on a bad query

**F7 -- the ring holds B+1 panes; the covered span is `[W, W + W/B]`.** The 1.6.0 ring held only B
panes (see "Decision" and "The pane rotate-and-clear model" above), so it dropped the oldest
(straddling) pane up to one pane width `W/B` EARLY -- the retained window was `(E - W, now]`, one pane
width SHORTER than the ideal `(now - W, now]`, and `count()` UNDER-reported the true count in
`(now - W, now]` on 29410/29557 witness queries. That is the wrong sign for a windowed count: like
`SlidingCountMin`'s one-sided bound (ADR 0010), a windowed estimate should over-cover, never
under-cover. The ring now holds **B+1 panes** (the `panes` option stays B, the user knob). `quantile`
/ `quantileInto` / `count` merge every live pane with `paneEnd > now - W`, INCLUDING the straddling
oldest pane, so the covered span is `[W, W + W/B]`: always the FULL window W, over-covered by at most
one pane width `W/B` and NEVER under-covered. `count() >= true count in (now - W, now]` now holds on
100% of 29557 witness queries. Line ~31 above ("the oldest live pane straddles the window boundary and
is counted in full") was true of the PANE -- the straddling pane's contents were always summed whole
-- but the B-ring dropped that pane out of the live set one pane width before the boundary reached it,
so the WINDOW still forgot early; the B+1 ring is what keeps the straddling pane live long enough for
"counted in full" to cover `true(W)`. `bytes` grows by exactly one pane (default `panes: 32`:
279712 -> 287949 B). Rotation stays bounded: a huge `now` jump clears at most B+1 panes (the while-loop
cap moves from B to B+1). The witness oracle was the SECOND half of the 1.6.0 bug: it was pane-aligned
(it replicated the grid-aligned retention exactly), so it AGREED with the early-drop and the edge gate
passed. The oracle is now the TRUE window `(now - W, now]`: it gates `count() >= true(W)` on 100% and
quantiles within `alpha` of the covered span `[W, W + W/B]`, and a B-pane control (the 1.6.0 ring) is
now REJECTED alongside the existing no-expiry and coarse-`panes=2` controls.

**F5 -- `quantileInto` is 0 B/call.** It boxed ~64 B/call by returning a double from the per-quantile
`_walkInto`. The cut now lands in an instance `Float64Array` scratch slot and `_walkInto` writes
`out[j]` in place rather than returning a double, so a render path is fully alloc-free. `quantile(q)`
keeps ONE boxed return (16 B/call) -- the single-value convenience; `quantileInto` is the render path.

**F12 -- a bad query VALUE returns NaN, never throws.** This supersedes line ~128 above ("`quantile`
throws on `q` outside `[0, 1]` or a sub-window outside `(0, W]`"). A bad query VALUE is not a
programming error, it is data: `quantile(q)` with `q` outside `[0, 1]` / NaN returns NaN; a bad
sub-window `w` (`<= 0`, `> W`, NaN, non-number) returns NaN for BOTH `quantile` and `count` (NaN, not
0 -- null is not zero, an unrepresentable window is not an under-count). An empty window is unchanged
(`quantile` -> NaN, `count()` -> 0). A wrong CONTAINER type stays a programming error: `quantileInto`
with a non-Float64Array `qs`/`out` or an `out` shorter than `qs` still THROWS. `SlidingHyperLogLog`
`count(badW)` and `SlidingCountMin` `estimate(k, badW)` move to the same NaN contract in step 4 (1.7.0).
