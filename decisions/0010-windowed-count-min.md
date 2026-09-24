# ADR 0010 -- SlidingCountMin (windowed per-label frequency over a fixed-(B+1) pane ring)

Status: ACCEPTED (2026-09-24). The FOURTH additive post-1.0 member (MINOR 1.5.0). PURE APPEND: the
seven prior classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
DriftDetector, SlidingDDSketch) stay BYTE-IDENTICAL; only the file header + the `VERSION` const change
above the append point, plus the appended SlidingCountMin class and its `SCM_*` consts. `git diff HEAD`
on Adaptive.js is exactly three logical regions: header, VERSION, append.

## Context

The family already windows COUNT / SUM (ExponentialHistogram), DISTINCT (SlidingHyperLogLog), QUANTILES
(SlidingDDSketch), and detects drift (ADWIN, DriftDetector). What it does NOT have is PER-LABEL FREQUENCY
on the recency axis: "how many times did KEY occur in the LAST W" in fixed space over a large / unbounded
key domain. lite-sketch's cumulative CountMinSketch (ADR 0003 there; Cormode-Muthukrishnan, "An Improved
Data Stream Summary: The Count-Min Sketch and its Applications", 2005) answers it over the WHOLE stream
with a one-sided over-estimate `est >= true`, `est - true <= epsilon*N` w.p. `>= 1 - delta`. SlidingCountMin
is its RECENCY sibling -- the same d x w counter matrix over a sliding window -- and unblocks the lite-hud
per-channel rolling event-rate panel (one shared instance keyed by a composite `channelIdx*2^32 + tag`).

## Decision -- window model: a fixed-(B+1) ring of CountMin panes, keep the oldest

B+1 preallocated CountMin panes, each a full `Uint32Array(d * w)` matrix covering `W/B` of the window,
held in a ring. `add(now, key, count?)` writes the CURRENT pane; when `now` crosses a pane boundary the
ring rotates to the next pane and CLEARS it (`fill(0)`, 0-alloc). A `now` jump of k panes clears
`min(k, B+1)` panes in a bounded while-loop CAPPED at B+1 iterations (skipping >= B+1 panes clears them
ALL, then re-anchors the ring around `now`) -- it NEVER loops k, so an astronomical clock jump is O(B+1),
not O(jump). One rotation is an O(d*w) `fill(0)` spike inside `add` -- disclosed as amortized (the same
disclosure SlidingDDSketch makes for its pane clear).

**Why B+1 panes and KEEP the oldest (the one-sided-bound crux).** The query covers the LIVE panes
(`paneEnd > now - W`). With B panes of width `W/B` the ring covers exactly `W`, but the oldest pane
straddles the window boundary; if you DROP it you cover only `[W - W/B, W)` and UNDER-count, silently
breaking the lower side of the CMS contract (`est >= true(W)`). If you KEEP it you cover `[W, W+W/B]` --
always the full `W` plus at most one extra pane -- so the estimate is a ONE-SIDED UPPER bound:

    true(W) <= est <= true(W + W/B) + epsilon * N(W + W/B)

The extra `+1` pane is what makes the ring hold B+1 panes: the ring must physically retain the straddling
pane AND a full W behind it. Keeping the oldest (over-counting by at most one pane width) preserves the
CMS "never undercount" guarantee that a consumer relies on; dropping it (under-counting) would violate the
one property CMS sells. This is the mirror-image choice to SlidingDDSketch, which also counts its
straddling oldest pane in full and discloses the W/B edge error.

## Rejected alternative -- an EH-per-cell ECM-sketch

REJECTED: the ECM-sketch (Papapetrou-Garofalakis-Deligiannakis, "Sketch-based Querying of Distributed
Sliding-Window Data Streams", VLDB 2012) replaces each of the `d*w` CountMin counters with its OWN
exponential histogram, giving a per-cell windowed count with a tight per-cell relative error. It buys a
sharper bound than the pane ring, but at two costs the suite will not pay: (1) SPACE -- an EH per cell is
`O((1/epsilon') log(epsilon' W))` buckets x `d*w` cells, ~6 MB for a modest `d=5, w=512` at a useful
per-cell epsilon (vs the pane ring's ~338 KB at the same d, w); (2) HOT PATH -- each add runs a DGIM merge
cascade PER touched cell, a variable-cost, sometimes-allocating operation, NOT the bounded 0-B/op index
manipulation the family sells. The pane ring trades the sharper per-cell bound for a fixed store and a true
0-B/op add, and discloses the resulting W/B edge error. Rejected for the same reason ADR 0008 rejected the
histogram-of-DDSketches (model B): merge-on-add is not zero-GC.

## Absolute pane alignment (forward-compat for merge)

Each pane holds an EXCLUSIVE upper time bound `paneEnd[p]`. The first add ANCHORS the ring grid-aligned to
an ABSOLUTE grid: the current pane's end is `E = (floor(now / pw) + 1) * pw` with `pw = W / panes`, and
predecessors step back by `pw` each. Because the grid is anchored at absolute 0 (not at the first `now`),
two instances with the same `(W, panes)` place their pane boundaries at IDENTICAL absolute times -- so a
future `merge(other)` could add corresponding panes cell-by-cell without re-aligning. (No `merge` ships in
1.5.0; the alignment is a cheap forward-compat choice, not a feature.)

## The query: sum-then-min (NOT min-then-sum)

`estimate(key, w?)`: for each of the d rows, SUM the key's cell across the live panes, THEN take the MINIMUM
over the d rows. This is the ONLY correct order for a windowed CMS. A single pane's row-cell is an
over-estimate of that key's count IN THAT PANE; summing a fixed row's cell across panes gives an
over-estimate of the key's count over the whole window FOR THAT ROW; the min over rows is then the tightest
windowed over-estimate. The reverse order (MIN over rows within each pane, then SUM the per-pane minima)
is WRONG: each pane's min may land on a different colliding key, so the per-pane minima are over unrelated
cells and their sum has no CMS guarantee. `test/witness.mjs` runs a MIN-THEN-SUM variant as a negative
control and the one-sided-bound gate rejects it. `estimate` returns a DOUBLE (a window sum across B+1
near-saturated panes can exceed `2^32`) and NEVER throws (0 for an unseen / out-of-domain key, an empty
window, or a bad sub-window `w`) -- parity with lite-sketch CMS so a consumer can swap it in.

## Per-pane conservative update + Uint32 saturation + `saturated`

Conservative update (Estan-Varghese, default -- lite-sketch CMS parity) runs PER PANE: within the CURRENT
pane, find the min over the key's d cells and raise only the cells below `min + count` up to it. It is NOT
run over window sums (that would need reading every live pane on the hot path and has no linear-merge
meaning). `conservative: false` selects the classic plain add. Counters are `Uint32Array`, SATURATING at
`2^32 - 1` (`SCM_SAT`) -- they CLAMP, never wrap (the CountMinSketch precedent; the suite's
saturate-never-wrap policy). The `saturated` getter counts the adds that hit the ceiling -- the honesty
flag, exactly like SlidingHyperLogLog's `degraded`: 0 in normal use, nonzero means a single pane's cell
saw > 4 billion of one key in one W/B time slice (a fail-safe, not a common case; the window sum stays
correct up to the clamp).

## The W-not-capped resolution (correcting the planner spec)

The planner sketched a "W_MAX 1<<16" cap. That is WRONG for the window span `W`: the other windowed members
(SlidingDDSketch, SlidingHyperLogLog) take `W` as a "finite number > 0" with NO small cap, and lite-hud
uses ms / record-time timestamps where a multi-minute window far exceeds 65536. The cell array
`(panes+1)*d*w` is INDEPENDENT of `W`, so `W` needs no small cap. RESOLUTION: `W` is a finite number > 0
(parity with the siblings). The `1<<16`-style cap belongs on the CMS WIDTH `w` (`SCM_W_MAX = 1<<16`, cells
per row) -- a TIGHTER cap than lite-sketch CMS's `1<<25`, because the windowed store is `B+1` full matrices
so per-instance memory is `(B+1)x` a single CMS. `d` (rows) is capped at 32 (`SCM_D_MAX`, lite-sketch
parity). Any pane arithmetic that could overflow is guarded on the DERIVED quantity, not `W`: an
`SCM_CELLS_CAP = 2^31` check on `(panes+1)*d*w` keeps every flat cell index a SMI (so `_cells[id]` never
boxes), thrown at the ctor door BEFORE allocation.

## Sizing -- ctor + `withAccuracy`-equivalent via options

`w` and `d` derive from `epsilon` / `delta` exactly as lite-sketch CountMinSketch's `withAccuracy`:
`w = ceil(e / epsilon)` clamped to `SCM_W_MAX` and rounded UP to a power of two (so a column is picked with
a single `hash & (w - 1)` mask, byte-identical to lite-sketch), `d = ceil(ln(1 / delta))` clamped to
`[1, 32]`. The ctor accepts `epsilon` / `delta` OR explicit `w` / `d` in the options bag (explicit `w` / `d`
override the derived value); defaults `epsilon = delta = 0.01` give `d = 5`, `w = 512`. A static
`SlidingCountMin.withAccuracy(W, epsilon, delta, options?)` is the lite-sketch parity convenience: it
merges `epsilon` / `delta` into the options bag and delegates all sizing + validation to the one
options-bag ctor. So both the ctor (`{ epsilon, delta }`) and `withAccuracy` reach the identical sizing.

## Fail-closed surface + the byte-identical no-op ordering

The ctor throws `[lite-adaptive]` on a bad W / epsilon / delta / w / d / panes / seed / conservative /
unknown-option BEFORE any allocation (no half-built instance). `add` validates the KEY (typeof / NaN /
+-Infinity / non-safe-integer) and the COUNT (positive integer <= `SCM_SAT`) FIRST, then the TIME (mode
switch / non-finite / decreasing `now`) -- ALL before any state write, so every rejection is a
BYTE-IDENTICAL no-op (the SlidingDDSketch / SlidingHyperLogLog ordering). Key domain is every SAFE INTEGER
`|key| <= 2^53 - 1` (the hot body folds the low word + high word + sign, so a composite
`channelIdx*2^32 + tag` works for lite-hud's ONE-shared-instance use). `estimate` NEVER throws (an
un-addable / out-of-domain key was never added, so its windowed frequency is 0). `null` is not zero
(`conservative` and `seed` are guarded via `=== undefined`, so `seed = 0` and `conservative = false` are
legal explicit values).

`addFrom(buf, i)` is the ZERO-BOX entry -- a caller-owned Float64Array packs a stride-3 `[now, key, count]`
triple (`now = buf[i]`, `key = buf[i+1]`, `count = buf[i+2]` read UNBOXED), EXPLICIT-time only; its hot body
is DUPLICATED from `add` (not delegated) to keep `add`'s hot body byte-identical and avoid re-boxing at an
internal call boundary -- the N7 idiom shared with the other windowed members. `advance(now)` /
`advanceFrom(buf, i)` are the R11 idle slide (ADR 0009): move the window's reference time forward and run
the same bounded rotate-and-clear an add would, inserting NO value, EXPLICIT-time only, monotone, 0 B/op.

## Space + the honesty anchor

SPACE: a FIXED ring of `panes+1` dense `Uint32Array(d*w)` matrices + a `Float64Array(panes+1)` paneEnd
column + an `Int32Array(d)` conservative-update scratch; never grows (defaults -> ~338 KB). The torture gate
proves `add` / `addFrom` (incl. pane rotate + clear) / `advance` / `advanceFrom` / `estimate` / `clear` are
each 0 B/op with `gc major = 0`, including a rotation-every-add lane and a 1e12 now-jump advance lane, plus
a retention check (bytes constant + estimate returns to baseline over clear/refill cycles). The witness
proves the ONE-SIDED bound `true(W) <= est <= true(W+W/B) + epsilon*N` against an exact per-key ring oracle
on 100% of >= 2000 queries across >= 4 (W, eps) pairs + a churny key stream + advance-empties, and rejects
two negative controls the same gate rejects: a DROP-OLDEST-PANE variant (under-counts -> breaks
`est >= true(W)`, the LOWER side) and a NO-CLEAR-ON-ROTATE variant (a pane rotated back into the ring
keeps stale counts from a prior ring cycle -> over-counts -> breaks the UPPER side). CORRECTION: an
earlier draft of this ADR named MIN-THEN-SUM (per-pane row-min then sum) as the upper-breaking control;
`test/witness.mjs` proves that is WRONG -- by `sum of mins <= min of sums`, min-then-sum is <= the shipped
sum-then-min and still >= true(W), so it is a valid (if weaker-guarantee) estimator, NOT a bound violation,
and cannot be used as a rejectable negative control. The witness keeps a min-then-sum COMPARISON (proving
the two orders numerically differ, so the sum-then-min choice is not vacuous) but gates the upper side with
NO-CLEAR-ON-ROTATE instead. This member closes the per-label-frequency gap on the recency axis; a
`merge(other)` (the absolute pane alignment makes it a cell-by-cell pane add) remains a possible pure-append
post-1.5.

## No `total` getter (intentional asymmetry vs lite-sketch CountMinSketch, not a parity gap)

lite-sketch's cumulative `CountMinSketch` exposes `get total()` because a lifetime accumulator has one
well-defined scalar: the running sum of every `count` ever added. SlidingCountMin has no such scalar to
expose cheaply: the only meaningful analogue -- the WINDOWED sum across ALL distinct keys -- is not
obtainable in O(1) from the `d x w` grid (a single row's raw cell sum is not it either: CMS collisions
make any one row's sum an OVER-estimate of the true windowed grand total, not a usable headline number),
and computing it honestly would need either a SEPARATE running counter re-derived every pane rotation
(hot-path bookkeeping the family does not pay for a value nothing currently consumes) or an
O(d*w*(panes+1)) full-grid scan on every call. Omitted BY DESIGN in 1.5.0, not an oversight; an
approximate `total(w?)` (disclosed as an over-estimate, e.g. via one row's raw windowed sum) remains a
possible additive follow-up alongside `merge`, same as any other post-1.5 pure append.
