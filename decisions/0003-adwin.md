# 0003 -- ADWIN: concept-drift detection + adaptive windowing (the marquee member)

Status: accepted (v0.2.0)

## Context

ADWIN (ADaptive WINdowing; Bifet-Gavalda, SDM 2007) is the reason lite-adaptive
exists: a change detector with NO magic window size. It keeps a window of the most
recent values, GROWS it while the stream is stationary, and SHRINKS it from the old
end the moment a mean shift is statistically significant -- so the window is
DATA-DRIVEN. It answers "did the stream drift, and over what window is it stable
now?" -- the change-response question (RESEARCH.md 2.2), the second honesty anchor of
the family (after EH's windowed-error anchor). It is a PURE APPEND onto the M1 chassis
(ADR 0001/0002): the ExponentialHistogram class + its substrate stay byte-identical;
only the file header roster comment + `VERSION` + the appended `ADWIN` class change.

## The settled calls

1. **The cut test is ADWIN2's VARIANCE-AWARE (Bernstein) bound.** Each bucket carries
   `(sum, sumSq, count)`. On `add`, after the insert + merge cascade, scan EVERY
   boundary split of the window into `W0` (older) | `W1` (newer) and flag a cut when
   `|mean(W0) - mean(W1)| > epsCut`, where:

       m          = 1 / (1/n0 + 1/n1)                          (harmonic mean of the sub-window counts)
       deltaP     = delta / ln(width)                          (Bifet-Gavalda multiple-testing correction)
       sigmaHat^2 = total-window variance                      (from the running sum + sumSq over the window)
       R          = range of the CURRENT window (see the F18 amendment; pre-1.7.0 this was a
                    running max - min over ALL x seen, which never shrank -- the F18 bug)
       epsCut     = sqrt( (2/m) * sigmaHat^2 * ln(2/deltaP) ) + (2/3) * (R/m) * ln(2/deltaP)

   On a detected cut, DROP the oldest bucket(s) (shrink `W0` away) and RE-scan until no
   cut remains. This is the full Bernstein bound (a variance term + a range term); MOA's
   ADWIN2 is its `R = 1` (values pre-normalized to `[0,1]`) special case -- we keep `R`
   explicit because `add(x)` accepts any finite real.

   - ALTERNATIVE RECORDED (`delta` / splits): ADWIN's confidence is a single scalar
     `delta in (0, 1)` -- the per-test significance. Because the window is tested at
     every bucket boundary on every add (many tests), the raw `delta` is corrected by the
     number of splits via `deltaP = delta / ln(width)` -- Bifet-Gavalda's Bonferroni-style
     correction with `ln(width)` standing in for the split count (buckets are `O(log width)`).
     We chose `deltaP = delta / ln(width)` (the paper's form) over `delta / #splits` (tighter
     but noisier for small windows) and over an uncorrected `delta` (too many false alarms).
     `ln(width)` is guarded for `width <= 1` (no split possible -> no cut).

2. **The data model is ADWIN's OWN variance-carrying SoA columns (design-parity with
   M1, a SEPARATE pool -- the EH substrate is NOT edited).** `Float64` `sum` + `sumSq`
   per bucket; `Int32` `count` + per-level `next`/`prev`/`lvl` linkage + a free-list;
   `Int32` per-level `head`/`tail`/`lcount`; plus running scalars for the whole window
   (`total` = width, `wsum`, `wsumSq`); since 1.7.0 (F18) the range `R` is derived from
   per-bucket `_bmin`/`_bmax` over the live window (NOT a running global -- see the F18 amendment). Buckets are grouped by LEVEL exactly as EH: a
   level-L bucket holds `2^L` items; more than `M` buckets at a level merges the two
   OLDEST into one of the next level (the same amortized cascade). `M = 5` (the ADWIN2
   default), `LEVELS = 64`, so the FIXED pool is
   `CAP = (M+1) * LEVELS + 2 = 386` buckets -- preallocated, never grown.

3. **The window is ITEM-INDEXED.** `add(x)` takes one value per item; there is NO `now`
   argument. ADWIN's adaptive window is data-driven and measured in ITEMS, not time --
   unlike EH's caller-supplied monotone clock. `add(x)` returns `true` iff a cut fired
   (drift detected) this add. Getters: `mean` / `variance` / `width` / `bucketCount` /
   `capacity` / `delta`; `clear()` reuses the pool.

4. **The value domain is any finite real WHOSE SQUARE IS FINITE, i.e. `|x| <= sqrt(MAX_VALUE)`
   (`ADWIN_X_MAX ~= 1.34e154`).** `add(x)` accepts any such number (zero, negative, fractional);
   a non-number / `NaN` / `+-Infinity`, OR a finite `x` with `|x| > ADWIN_X_MAX`, throws
   `[lite-adaptive]`. The upper bound is a FAIL-CLOSED guard, not a limitation of the algorithm:
   ADWIN squares every value into `sumSq` / `wsumSq` for its Bernstein variance term, so a finite
   `x` whose square overflows to `Infinity` would poison the accumulators -- `variance` would then
   read `0` (via `Inf - Inf = NaN` clamped) and every `epsCut` would be `Inf/NaN`, permanently
   freezing drift detection to `false` with NO throw (a silent fail-open of the member's core
   function). Rejecting `|x| > ADWIN_X_MAX` at the door closes that hole. DEFENSE-IN-DEPTH: because
   summing many in-domain squares can still overflow `wsumSq`, the `mean` / `variance` getters
   `_guardFinite()` (mirroring ForwardDecay) and THROW on a non-finite accumulator rather than
   returning `0`. The range `R` (the CURRENT window's range since 1.7.0 F18) scales the Bernstein
   bound to the actual data range (no `[0,1]` pre-normalization required of the caller).

5. **Fail closed, typeof-first, BEFORE any state mutation (the M1 reviewer lesson).** A
   bad `delta` / unknown option throws `[lite-adaptive]` at the ctor door BEFORE any
   allocation (no half-built instance). `add(x)` validates `x` FIRST -- a rejected add is
   a BYTE-IDENTICAL no-op: it opens no bucket, touches no aggregate, and does not widen
   `R`. Getters (`mean` / `variance` / `width` / ...) NEVER throw; an empty window reads
   0 (null is not zero). A free-list exhaustion is a fail-closed `[lite-adaptive]` throw
   (unreachable if `CAP` is correct; a guard, not a growth path).

## Consequences

- The change-response witness (`test/witness.mjs`) GATES: false-alarm rate `<= delta` on
  a stationary Bernoulli(0.5) stream (measured ~0.01%-0.07% at delta 0.05-0.30, far under
  the bound); detection latency per shift magnitude (a 0.5->1.0 shift at +22 items, a
  0.5->0.55 shift at +3245 items -- small shifts disclosed to take longer); missed = 0
  over 8 large-shift runs; adapted-window correctness (after a 0.2->0.8 shift settles, the
  window mean is ~0.79 and the old regime is dropped). NEGATIVE CONTROLS (the N4
  discipline): a bound-DISABLED ADWIN false-alarms ~100% (rejected by the delta gate), and
  a NO-SHRINK ADWIN's post-shift mean stays at the ~0.5 blend (rejected by the adaptation
  gate) -- both the bound AND the shrink are load-bearing.
- 0 B/op on `add` INCLUDING the cut-scan AND the drop-older shrink over a drifting stream,
  proven by `test/torture.mjs` (gc major 0, retention 0, arrayBuffers delta <= 0) and the
  `test/perf/PerfGate.test.mjs` drifting-stream scenario (flat throughput, 0 old-gen).
- `count` is stored as `Int32` (= `2^level`); this is exact for any single window of fewer
  than ~2^31 items (the item-indexed design's practical range). The whole-window `total` /
  `wsum` / `wsumSq` are plain-number scalars maintained incrementally (add on insert,
  subtract on drop) -- an O(1) variance read with the standard incremental-FP trade.
- The next members (ForwardDecay, HeavyKeeper) append below ADWIN and reuse the substrate
  idiom by DESIGN-PARITY (never a dep), changing only the header roster + `VERSION`.

## Amendment (1.7.0, F9) -- CENTRED sums; false alarms at a large absolute offset

The 1.6.0 audit (RESEARCH.md 13, ROADMAP 7 F9) found ADWIN false-alarming on a STATIONARY
stream once the data sat at a large absolute offset: variance was computed as
`E[x^2] - mean^2`, and at a large `|mean|` the two terms are nearly equal and catastrophically
cancel in floating point. Measured: ADWIN(0.002), 5 seeds x 20k N(0,1): 0 alarms at offset 0
and 1e6, 98 at 1e9, 144 at 1.7e12; variance read as low as 0 (span `[0, 3e10]`); at 1.7e12 a
+1 step was MISSED within 2000 items on 2 of 5 seeds. A near-zero variance shrinks `epsCut`,
so noise trips the cut test -> phantom drift.

FIX -- keep every sum / sum-of-squares CENTRED on an offset `c`:
- `add` anchors `c = x` on the first value of a (re)started window, then accumulates the
  CENTRED `xc = x - c` into every bucket column (`_sum`, `_sumSq`) and into the window totals
  (`_wsum`, `_wsumSq`). `mean = c + wsum/n`; `variance = wsumSq/n - (wsum/n)^2` is unchanged
  because variance is OFFSET-INVARIANT (`Var[x - c] == Var[x]`) -- the E[x^2] - mean^2
  cancellation is gone (mean is now near 0 in the centred frame). `_scanCut` needs NO change:
  it works on centred sums, and mean DIFFERENCES between sub-windows are offset-invariant.
- The range `R` stays RAW (the per-bucket `_bmin`/`_bmax` store raw x since F18): the range is
  offset-invariant, so it needs no centring.
- After a cut FIRES (after the cut loop exits, NEVER inside it) and when the window empties,
  `_recentre()` shifts every LIVE bucket + the window totals to a new offset `c' = c + wsum/n`
  (the current window mean): `sum' = sum - n*d`, `sumSq' = sumSq - 2*d*sum + n*d^2`,
  `d = c' - c`, `c = c'`. This keeps `c` close to the data after a regime change. Cold, 0
  alloc, O(live buckets). A slow drift WITHOUT a cut is NOT re-centred: `c` then lags the data,
  but the centred magnitude grows only with the DRIFT distance `|mean - c|`, never with the
  ABSOLUTE offset -- so the cancellation cannot return from a slow drift alone.
- DOMAIN NARROWED (disclosed behavior change): the accepted input bound HALVED from
  `sqrt(Number.MAX_VALUE)` (~1.34e154) to `sqrt(Number.MAX_VALUE)/2` (~6.7e153). The quantity
  that must stay finite is now the CENTRED square `(x - c)^2`; with `|x|, |c| <= XMAX` the worst
  case is `(2*XMAX)^2`, which stays `<= Number.MAX_VALUE` iff `XMAX = sqrt(MAX)/2`. A finite
  `|x|` in `(6.7e153, 1.34e154]` that 1.6.0 accepted now throws a tagged `[lite-adaptive]`
  RangeError (a byte-identical no-op). No real telemetry value approaches this.

REJECTED alternative -- per-bucket Welford `(n, mean, M2)` with the Chan parallel merge. It
centres each bucket independently and is numerically excellent for the growing MERGE, but the
adaptive shrink DROPS the oldest bucket, which would need a SUBTRACTIVE un-merge (remove a
sub-population from a combined M2). That reintroduces exactly the same catastrophic
cancellation this fix removes (subtracting two nearly-equal M2 sums), and costs an extra
column. A single global offset with a post-cut re-centre gets the accuracy without the
subtractive-merge hazard and keeps the bucket columns BYTE-IDENTICAL in layout (still
`_sum`/`_sumSq`/`_bcount`).

GATE (HARD, `test/witness.mjs` F9 offset lane): ADWIN(0.002), seeds 1..5 x 20k stationary
N(0,1) -- false alarms at 1e9 and 1.7e12 each `<= offset-0 count + 1` (measured 0/0/0); a +1
step at item 10000 detected 5/5 within 2000 items with per-seed delay within +-2 items of the
offset-0 delay (measured EXACTLY equal, delta 0 on all 5 seeds); stationary rate `<= delta`.
Unit tests (`test/ADWIN.test.js`): variance at 1.7e12 within 1e-6 rel of offset 0 (exact on an
integer sequence), mean includes the offset, `_recentre` after a fired cut leaves the summary
self-consistent, `clear()` resets `_c`. The offset-0 numbers are NOT bit-identical to 1.6.0
(FP rounding changed), so the gate is STATISTICAL, not a golden replay.

## Amendment (1.7.0, F18) -- R is the range of the CURRENT window, not a running global

The 1.6.0 audit (found by QA, ROADMAP 7.1 F18; pre-existing in 1.6.0) found ADWIN going DEAF
after a large level shift. The range term `(2/3)(R/m)ln(2/deltaP)` used `R = max - min` over a
running min/max (`_min` / `_max`) of ALL raw `x` ever seen, which WIDENED ONLY and never shrank
after a cut. So after one big shift `R` stayed at the shift height for the instance's lifetime,
the range term dominated `epsCut`, and later shifts were never flagged -- a SILENT fail-open of
the member's core function (`lite-hud` M6 drives drift off ADWIN). Measured, ADWIN(.002), 5 seeds,
N(0,1) noise: a later `+1` shift caught in 87-99 items with no prior jump, 921-988 after a prior
jump of 100, and NEVER within 20000 items after a prior jump of `1e4` / `1e6`. A straddling bucket
that mixed both regimes also survived (window variance ~2.7e8 instead of ~1 after a `1e6` jump).

FIX -- R is the range of the CURRENT window:
- Two per-bucket `Float64Array` columns `_bmin` / `_bmax` carry each bucket's RAW min/max (RAW,
  not centred -- the range is offset-invariant, so `F9`'s centring does not touch them). They are
  set to `x` when a bucket opens (`add` / `addFrom`, duplicated bodies for byte-parity) and the
  merged bucket takes `min(_bmin)` / `max(_bmax)` of the two on a merge. A dropped/freed bucket
  needs nothing (a dead slot is never read).
- `_scanCut` derives `R` in ONE pass over the live buckets, EXCLUDING the globally-oldest bucket
  (the head of the highest level). WHY exclude the oldest: after a level shift a single straddling
  bucket at the oldest end carries one stale value from the prior regime; the whole live-window
  range would let that lone value pin `R` at the old shift height (the straddle then protects
  itself -- its own extreme keeps `epsCut` above the mean gap, so it is never cut). Excluding the
  oldest bucket is exactly the range of the window ADWIN would RETAIN when it cuts there, so the
  straddle's stale extreme cannot pin `R`, and the bucket is dropped -- the window then reads its
  true (post-shift) variance and range. On a STATIONARY stream the oldest bucket is large and
  well-sampled, so excluding it barely moves `R`: the false-alarm rate stays `<= delta` and 0 at
  offsets 0 / 1e9 / 1.7e12 (the F9 gate is unperturbed). Alternatives measured and REJECTED: (A)
  the whole live-window range -- still deaf (the straddle pins it); (B) the newer sub-window `W1`
  range per split -- cleans the straddle but under-samples `R` for small `W1` and false-alarms
  above 0 on stationary streams (34 alarms over 20k Bernoulli(0.5) at delta 0.1, and heavy-tailed
  streams worse); (D) per split, max(range(W0 minus its oldest bucket), range(W1)) -- recovered
  like (C) but raised 1 false alarm on the heavy-tailed stationary stream at delta 0.002, for no
  gain over (C). Excluding just the oldest bucket (C) is the only candidate that passed BOTH the
  recovery gates AND kept stationary false alarms at 0.
- No whole-window range scalar is carried; `_min` / `_max` are REMOVED (no public getter exposed
  them). `add` / `addFrom` hot bodies gained only the two per-bucket writes on open + the two-way
  union on merge -- the range WALK lives in the cut scan that already iterates the live buckets, so
  `add` stays 0 B/op (proven by `test/torture.mjs`). The bucket pool grows by two
  `Float64Array(CAP)` columns: `2 x 8 x 386 = +6176 B` (13120 -> 19296 B; ADWIN has no `bytes`
  getter). Stationary per-add cost +5.6% (the extra range pass); throughput on a drifting stream is
  ~26% lower only because the FIXED detector now correctly fires the cuts it used to miss.

GATE (HARD, `test/witness.mjs` F18 recovery lane + `test/ADWIN.test.js`): G1 recovery -- 5 seeds, a
later `+1` shift after a settled prior jump J in `{100, 1e4, 1e6}` detected within `1.5x + 10` of
the no-prior-jump delay on the same seed (measured 96/82/113/78/83 vs 91/85/115/89/88). G2 clean
window -- after `0 -> 1e6` + 30000 settled items, variance in `[0.8, 1.25]` and `|mean - 1e6| < 1`
on all 5 seeds (measured ~1.0, `|md| < 0.01`). G4 negative control -- an ADWIN pinned to the OLD
running-global R FAILS G1 (proves the gate has teeth). The F9 offset gate, the change-response
witness, and the stationary false-alarm gates are unperturbed.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
