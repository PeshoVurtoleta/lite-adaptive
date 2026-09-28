# ADR 0012 -- SlidingAggregate (exact windowed count / sum / mean / min / max over a fixed-(B+1) pane ring)

Status: ACCEPTED (2026-09-27). The SIXTH additive post-1.0 member (MINOR 1.9.0). PURE APPEND: the nine
prior classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog, DriftDetector,
SlidingDDSketch, SlidingCountMin, DecayedReservoir) stay BYTE-IDENTICAL (a sha256 per class body, cut from
`git show HEAD:Adaptive.js`). `git diff HEAD` on Adaptive.js touches only: the header docblock, the
optDoor docblock count ("all 10 ctors"), and the append. VERSION is bumped by /release, not here.

## Context

lite-hud needs a time-window MEAN of skewed latencies (F17). ExponentialHistogram's `sum()` error is
bounded by `size(straddling bucket) / 2`, not by epsilon, so it fails hard on a skewed stream (the
`test/witness.mjs` F17 lane). SlidingDDSketch answers quantiles, not sums; SlidingCountMin answers
per-key counts. No member gives an exact windowed sum / mean / min / max in fixed memory.

## Decision -- window model: B+1 panes, keep the oldest (the SlidingCountMin ring, copied)

B+1 preallocated panes of width `W / B`, the ring of ADR 0010. It is a COPY, never a shared helper, so
SlidingCountMin's bytes and behavior cannot move. A clock jump of k panes clears `min(k, B+1)` panes, then
re-anchors on the absolute grid. A query covers the live panes (`paneEnd > now - w`), so the covered span
is `[w, w + W/B]` and always CONTAINS the true window; dropping the straddling oldest pane would
under-cover `[w - W/B, w)`.

## Per-pane state and the summation

Stride 5 in one Float64Array: `[count, sum, kcomp, min, max]`.

- Hot: `count += 1`; branch-free Kahan (`y = v - c; t = s + y; c = (t - s) - y; s = t`); min / max by
  `<` / `>`.
- Cold: every reader merges the live, NON-EMPTY panes with Neumaier over the terms `{s_p, -c_p}`.
- Guarantee over the covered span, with `u = 2^-53`:
  - count, min and max are bit-exact (a +-0 tie keeps the first value seen);
  - `|sum - exact| <= (4u + O(N u^2)) * sum|v|` (Kahan per pane contributes `2u`, Higham ASNA eq. 4.8;
    the Neumaier merge over the `2(B+1)` terms adds `2u`). A `2u` bound is NOT provable for this merge:
    even a one-pane window pays Kahan's `2u` plus the final `s + c` rounding;
  - `mean = sum / count` (one more rounding).
- Rejected: plain `+=` (loses every 1.0 behind a 2^53); per-pane offset-centring (one extra hot field and
  a re-centre branch, and it still needs compensation).

## Empty panes: identity sentinels, not zero

A cleared pane holds `min = +Infinity` and `max = -Infinity` (the identities of min / max), never
`fill(0)` over the stride, and every merge skips `count === 0`. A covered count of 0 returns NaN from
`mean` / `min` / `max` (null is not zero) and 0 from `count` and `sum` (the empty sum is exactly 0).

## Time model and the zero-box path

EXPLICIT (a monotone `now`) or COUNT mode (`add(undefined, v)`); the mode locks at the first add and a
switch throws. `addFrom` / `advance` / `advanceFrom` are explicit-only (ADR 0009). The rotate / anchor
helpers take NO argument and read `this._now`, so no epoch-ms double crosses a non-inlined call -- gated
by a rotate-every-add epoch lane. (SlidingCountMin passes `t` as an argument to `_advance(t)` /
`_anchor(t)`; its per-rotation cost with an epoch clock is unmeasured and is logged for 1.10.0. It is not
touched here.)

## Value domain and the magnitude cap

`value` is REQUIRED (no default of 1: a forgotten latency must fail closed). A finite real with
`|v| <= 1e150` (`SA_X_MAX`, the same cap as `DD_X_MAX`), so `|sum| <= n * 1e150` stays finite for any
physically reachable n and every Kahan / Neumaier intermediate stays finite. Without the cap, two adds of
`1e308` would turn a pane into Infinity / NaN silently until it rotated out (fail-open). A non-number,
NaN, +-Infinity or over-cap value throws `TypeError [lite-adaptive]`, and the rejected call is a
byte-identical no-op.

## Precision domain (amended 2026-09-27, QA190)

The containment claim above ("the covered span always CONTAINS the true window") holds only while the
double clock can RESOLVE the pane grid -- i.e. `ulp(now) << pw`. QA 1.9.0 found three configs that break
it SILENTLY (fail-open); each is now rejected fail-closed. The grid is a set of lines `k * pw` (integer
`k`); a pane end is `(floor(now/pw) + 1) * pw`. Two conditions must hold for that line to be exact and for
`(B+1) * pw` to cover `W`:

1. **`pw = W / panes` must be a NORMAL double** (`>= 2^-1022`, `SA_MIN_NORMAL`). A SUBNORMAL `pw` has fewer
   than 52 significand bits, so `(k+1) * pw` no longer round-trips and `(B+1) * pw` can fall BELOW `W`; the
   ring then under-covers the true window (QA190 F3: `W = 1500 * 2^-1074`, panes 1024 -> `pw ~ 1.46q`
   rounds so `1025 * pw < 1500q`). The ctor rejects a subnormal `pw` with `RangeError [lite-adaptive]`
   BEFORE any allocation. (A `pw` that underflows all the way to 0 keeps the older `/underflowed/` throw.)

2. **`|now| <= pw * 2^42`** (`SA_CLOCK_SPAN`). At the bound `ulp(now) <= pw * 2^-10`, so a grid line
   resolves to within `pw / 1024` and `(floor(now/pw)+1)*pw` still contains the true window. Past it the
   clock cannot represent the grid: the window collapses (QA190 F1: `W = 1e-3` at `now = 1.75e12` re-anchors
   every add) or the pane ring under-covers (QA190 F2: `W = 736`, panes 32 at `now = 1e17` -> `ulp = 16 > pw/2`,
   467/500 queries under-count). `this._nowMax = pw * 2^42` is precomputed once in the ctor, so the hot path
   pays ONE field compare (`!(t <= nowMax && t >= -nowMax)`, NaN-safe) next to the existing monotone check;
   `add` / `addFrom` / `advance` / `advanceFrom` reject a larger clock with `RangeError [lite-adaptive]`
   BEFORE any state write (a byte-identical no-op). Count mode applies the SAME bound to its integer tick.
   The bound is generous for real clocks: epoch-ms (W=1000, B=32) allows `|now| <= 1.37e14`, epoch-us
   (W=1e6) `<= 1.37e17`, `performance.now()` (W=16) `<= 2.2e12` ms (~25k days uptime). A clock beyond it
   should be rebased (subtract an epoch) or paired with a larger `W`.

Pane ends are computed by MULTIPLICATION from the grid index -- `_advance` derives `k = round(E/pw)` once
and writes each new end as `(k+1) * pw` -- NOT by an accumulating `E += pw`, whose per-step rounding drifts
by up to `~pw` near the domain edge and can drop a live pane. This is bit-identical to `_anchor`'s
`(floor(now/pw)+1)*pw` and to the oracle, so containment is exact across the whole legal domain (a 500-query
edge test at `|now|` just under `pw * 2^42` reads `count >= true(W)` on 100%).

Mutants with teeth: removing the ctor normal-check turns the F3 build-throws test RED; removing the
`nowMax` check turns the F1/F2 fail-closed tests RED (both proven on scratch copies).

## Space

`bytes = (B + 1) * 48`: `(B+1) * 5 * 8` for the stride store plus `(B+1) * 8` for the pane-end array.
1584 B at the default `B = 32`, independent of W, never grows. 50 lite-hud channels = 79,200 B.

## Gates

An exact covered-span oracle (BigInt over quantized values) and a true-window lane; a mutation test of
`w` for every reader; controls REJECTED by the same gates: a B-pane ring, no clear on rotate, a dropped
straddling pane, Kahan removed, Neumaier removed, empty-pane poisoning (`fill(0)` sentinels). A lite-hud
lane (50 lognormal channels) printed next to the EH F17 failure. Allocation: torture 0 B/op with 0 major
GC; pinned-probe lanes incl. EVENT-HEAVY rotate-every-add epoch lanes (the 1.8.0 lesson: a per-event box
hides in an average over quiet adds); JumpTiming +1e12 with a per-pane-loop control.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

## Amendment (1.10.0) -- family parity on the clock-precision domain

SlidingAggregate's clock-precision domain guard (`|now| <= pw * 2^42`, subnormal `pw` rejected,
grid-index pane ends) is now shared: in 1.10.0 SlidingCountMin (`SCM_CLOCK_SPAN` / `SCM_MIN_NORMAL`) and
SlidingDDSketch (`SLD_CLOCK_SPAN` / `SLD_MIN_NORMAL`) adopt the same guard and the same argument-free
`_advance()` / `_anchor()` reading `this._now` (H2-1; ADRs 0010 / 0008). The three windowed-pane members
now fail closed identically on an out-of-precision clock.
