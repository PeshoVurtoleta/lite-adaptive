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
       R          = running observed range (max - min over ALL x seen; widens as data arrives)
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
   (`total` = width, `wsum`, `wsumSq`) and the running `min`/`max` (for `R`, over ALL x
   seen, never rolled back on a shrink). Buckets are grouped by LEVEL exactly as EH: a
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
   returning `0`. The running range `R = max - min` tracks all `x` seen, so the Bernstein bound
   scales to the actual data range (no `[0,1]` pre-normalization required of the caller).

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

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
