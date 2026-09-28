# ADR 0007 -- DriftDetector (scalar, O(1)-state streaming drift detection)

Status: ACCEPTED (2026-09-24). The SECOND additive post-1.0 member (MINOR 1.2.0). PURE
APPEND: the five prior classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper,
SlidingHyperLogLog) stay BYTE-IDENTICAL; only the file header + the `VERSION` const change
above the append point.

## Context

The suite already has ADWIN (ADR 0003), a data-driven ADAPTIVE-WINDOW drift detector that
keeps the recent values in a bucket pool and cuts the window on a variance-aware statistical
test. What it does NOT have is the classical family of SCALAR, O(1)-STATE change detectors --
Page-Hinkley and CUSUM -- which detect a shift in the MEAN of a real-valued signal from a
handful of running scalars, no window, no pool. These are the lightest possible drift members
(the natural companion to ADWIN when you want a cheap "did this metric just jump?" alarm on a
telemetry channel), and they are what most streaming libraries mean by "drift detection". This
member fills that gap.

## Decision -- one class, two modes, real-valued `add(x) -> boolean`

A SINGLE class `DriftDetector` selected by a mode const (`DRIFT_PH` / `DRIFT_CUSUM`, exported
numeric named exports `0` / `1`, mirroring the internal mode sentinels). Both modes share the
same surface: a real-valued `add(x) -> boolean` (and the zero-box `addFrom(buf, i)`) that
returns `true` EXACTLY on the item that trips the threshold, a `clear()`, and the getters
`mode` / `delta` / `threshold` / `count` / `mean` / `statistic`.

### Roster -- Page-Hinkley + two-sided CUSUM ONLY

- **`DRIFT_PH` -- Page-Hinkley** (Page, "Continuous Inspection Schemes", Biometrika 1954;
  Mouss-Mouss-Linkens-Sellami, "Test of Page-Hinkley, an approach for fault detection in an
  agro-alimentary production system", 2004). Each item updates a running mean `m_t` (Welford),
  then two cumulative deviations are maintained with a magnitude allowance `delta`:

      dev  = x - m_t
      gP  += dev - delta          (upward cumulative)   ; mMin = min(mMin, gP)
      gN  += dev + delta          (downward cumulative) ; mMax = max(mMax, gN)

  A persistent upward shift makes `gP - mMin` grow; a downward shift makes `mMax - gN` grow.
  A cut fires when either gap exceeds the threshold `lambda`. Two-sided by construction (an
  upward accumulator watched against its running MIN, a downward one against its running MAX).

- **`DRIFT_CUSUM` -- two-sided CUSUM** (Page 1954). Two accumulators, each FLOORED at 0
  (reset to 0 whenever they would go negative -- the defining CUSUM discipline), grow only
  while the signal departs a FIXED target `mu0` (the classic SPC in-control mean) past the
  slack `delta`:

      dev = x - mu0                       (a FIXED reference, NOT the running mean)
      gP  = max(0, gP + dev - delta)      (upward)
      gN  = max(0, gN - dev - delta)      (downward)

  A cut fires when either exceeds the decision interval `threshold`.

### The reference is what makes the mode load-bearing (corrected design decision)

The FIRST cut of this member referenced BOTH modes to the online running mean (`dev = x - m_t`
for CUSUM too). qa proved that is a BUG: **the mode flag was cosmetic**. Under a shared
running-mean reference the two rules compute the MATHEMATICALLY IDENTICAL statistic, because
CUSUM's floored recursion is exactly the Page-Hinkley cumulative-minus-running-min:

      max(0, S_t)  where S_t = S_{t-1} + (dev - delta),   floored at 0 each step
    == cumsum_t - min_{k<=t} cumsum_k     (cumsum of (dev - delta))

which is precisely what the PH branch (`gP - mMin`) computes explicitly. qa measured **0
divergent fires over 800,000 adds** -- the two modes never disagreed. A cosmetic mode is a
defect.

The resolution (user-confirmed): keep BOTH modes but give them DIFFERENT references -- the
genuine textbook distinction. **DRIFT_PH keeps the ONLINE running mean** `m_t` (a self-
referencing, adaptive reference: it tracks a slow ramp and stays quiet). **DRIFT_CUSUM
references a FIXED `target` mu0** (the classic SPC in-control mean: it fires whenever the signal
departs mu0, and a SUSTAINED departure keeps alarming). Now the modes genuinely diverge: on a
slow linear mean ramp PH fires a handful of times while CUSUM (vs a fixed mu0) fires on nearly
every item -- the witness gates that divergence so a regression back to one statistic is
REJECTED (measured PH ~189 vs CUSUM ~18381 fires on a 20k ramp).

`target` is therefore REQUIRED for DRIFT_CUSUM (a CUSUM with no in-control mean is meaningless)
and FORBIDDEN for DRIFT_PH (which self-references) -- both enforced fail-closed at the ctor door,
never a silent ignore. `target` is a finite real of ANY sign, `|target| <= DD_X_MAX` (symmetry
with x, so `x - target` stays finite); `target = 0` is VALID (guarded `!== undefined`, not
falsy -- null is not zero). It is config (like delta / threshold): `clear()` and `_reset()` keep
it.

Both modes STILL maintain the Welford running mean (`m += (x - m)/n`, O(1), bounded by the x
range so it cannot accumulate an unbounded sum): it IS the PH test reference, and it is the
`mean` observability getter for CUSUM too (a caller can watch the running mean drift away from
its configured mu0). The hot body is a typeof-first reject + the mean update + the ONE mode
branch (a couple of adds and compares, `dev = x - m_t` for PH vs `dev = x - mu0` for CUSUM) +
the return -- no objects, no closures, 0 B/op.

### Reset on detection

On a positive detection the accumulators AND the running mean are RESET (`_n`, `_mean`, `gP`,
`gN`, `mMin`, `mMax` all -> 0). This is the standard PH / CUSUM discipline: after a shift the
running mean is a blend of the old and new concept, so recalibrating from scratch lets the
detector track the NEW concept and catch the NEXT shift. The reset is a dedicated `_reset()`
method (not `_initState`) so a witness control can disable ONLY the reset without breaking
construction / `clear()`. The witness GATES this: a no-reset variant keeps firing on nearly
every item after the first crossing (false-alarms forever) and is rejected.

### Why DDM / EDDM are OUT (deferred to a future member)

DDM (Gama et al. 2004) and EDDM (Baena-Garcia et al. 2006) are the OTHER classical drift
family, but they solve a DIFFERENT problem with a DIFFERENT contract:

- their INPUT is a Bernoulli ERROR-BIT stream (a classifier's per-item 0/1 correctness), not
  a real-valued signal; and
- their OUTPUT is TRI-STATE (stable / WARNING / drift), not a boolean.

Folding a tri-state, error-bit-stream detector into a real-valued `add(x) -> boolean` class
would either overload the return type or split the input contract -- both muddy the surface.
DDM / EDDM belong in a separate future member with a `warning`/`drift` status API. This ADR
records the deliberate scope: `DriftDetector` is Page-Hinkley + two-sided CUSUM, real-valued,
boolean, ONLY.

## Fail-closed domain (the ADWIN finite-overflow lesson) -- `DD_X_MAX`

ADR 0003 records ADWIN's lesson: a finite input whose square overflows silently poisons the
variance and freezes drift detection with no throw. DriftDetector has the analogous hazard on
its ACCUMULATORS: for PH, `mMax` can reach `+Infinity` while `gN` also reaches `+Infinity`,
making `mMax - gN = NaN` -> `NaN > threshold` is `false` -> drift silently frozen. The guard:

- `DD_X_MAX = 1e150` (a finite const, far below `Double.MAX`). `add` / `addFrom` reject a
  non-finite x AND any finite `|x| > DD_X_MAX` on the COLD branch (0 hot-path bytes). Reason
  the accumulators can never reach a non-finite value: each add moves `gP` / `gN` by at most
  `~2 * DD_X_MAX`, and both are BOUNDED between resets -- CUSUM floors at 0 and fires (then
  resets) at the finite `threshold`; PH resets at the finite `threshold` too. Reaching
  `Double.MAX` from a `1e150` step would need `~1e158` un-fired adds (physically unreachable),
  and a SINGLE add can never overflow. The running mean stays within the observed x range, so
  it is bounded by `DD_X_MAX` as well.
- Defense-in-depth: the `mean` / `statistic` getters call a cold `_guardFinite()` that THROWS
  `[lite-adaptive]` if any accumulator is non-finite (never a silent 0 / NaN), mirroring
  ADWIN / ForwardDecay. Unreachable via the public API given `DD_X_MAX`, but fail-closed if a
  future change ever loosens the domain.

`delta = 0` is a VALID, meaningful setting (no magnitude allowance / no slack), guarded as
`options.delta !== undefined`, never falsy -- null is not zero. `delta` is CAPPED at `DD_X_MAX`
(the same bound as `x`): each add moves `gP` / `gN` by `~delta`, so an uncapped delta near
`Double.MAX` would drive the accumulators non-finite in a few adds and `add()` would silently
stop firing -- a FAIL-OPEN boolean the getter `_guardFinite` cannot see (it guards reads, not
the boolean). Capping delta at the ctor door makes that overflow as unreachable as it already is
for `x`, so the boolean stays honest. `threshold` must be finite and `> 0` (a threshold of
`Infinity` -- "never detect" -- is a degenerate config and is rejected fail-closed at the ctor
door; the witness's "never detects" negative control is instead a huge finite threshold `1e12`).

`target` (the CUSUM fixed mu0) is capped at `DD_X_MAX` too (symmetry with `x`, so the increment
`x - target` stays finite); a non-finite / out-of-range target is rejected. It is REQUIRED for
DRIFT_CUSUM and FORBIDDEN for DRIFT_PH, both enforced at the ctor door (a CUSUM without a target,
or a PH with one, throws `[lite-adaptive]` -- no silent default, no silent ignore). `target = 0`
is valid (guarded `!== undefined`).

## The zero-box `addFrom(buf, i)`

`add(x)` boxes a FRACTIONAL `x` into a ~16 B HeapNumber at a non-inlined call boundary (the
lite-hud drift-channel idiom: a HUD-computed fractional metric). `addFrom(buf, i)` reads
`x = buf[i]` UNBOXED straight from a caller-owned `Float64Array` and runs the IDENTICAL
detection. The body is DUPLICATED from `add` (not delegated) to keep `add`'s hot body
byte-identical and avoid re-boxing at an internal call boundary -- the same N7 idiom as
ADWIN / ForwardDecay / HeavyKeeper / SlidingHyperLogLog. `add` is ITEM-INDEXED (a single
scalar, no `now`), so only `buf[i]` is read (`i < buf.length`); a bad buf / index throws
typeof-first (a byte-identical no-op).

## Space + defaults

O(1) SPACE: six mutable core scalars (`_n`, `_mean`, `_gP`, `_gN`, `_mMin`, `_mMax`), the
latch runtime (`_lDir` = latched direction, `_lvl` = the mutable trip level), the config
(`_mode`, `_delta`, `_threshold`, `_target`, `_latch`, `_half` = threshold/2 precomputed),
and ONE fixed instance `Float64Array(3)` (`_s` = [lifetime accepted-add counter,
lastDriftIndex, lastDirection]) -- no pool, no growable
TypedArray store at all (the lightest member; `grows` is a constant 0 in the perf gate).
Defaults `delta = 0.005`, `threshold = 50` suit a signal of order ~1; scale `threshold` to
the signal magnitude and the desired latency (`latency ~ threshold / (shift - delta)`).

## Honesty anchor (the witness)

The change-response witness injects a KNOWN changepoint into a real-valued signal and gates,
for BOTH modes: detection LATENCY per shift magnitude (a larger shift detects no slower, every
persistent shift above delta detected); the stationary false-alarm rate (bounded); the RESET
DISCIPLINE on a TRANSIENT shift (baseline -> spike -> back to baseline: the detector fires during
the spike then goes QUIET once the signal returns to baseline -- for CUSUM the baseline IS the
fixed target, so a sustained departure legitimately keeps firing and only a TRANSIENT separates a
working reset from a broken one); and the MODE-DIVERGENCE gate (a slow mean ramp on which PH stays
quiet while CUSUM vs the fixed mu0 fires far more -- measured PH ~189 vs CUSUM ~18381 fires; if the
modes ever collapse to one statistic again this gate FAILS). Two NEGATIVE CONTROLS the same gates
reject: a HUGE-THRESHOLD detector (never detects -> fails the latency gate) and a NO-RESET detector
(its statistic stays latched, so on the transient it keeps firing through the post-return tail ->
fails the tail-quiet gate). The torture gate proves add (PH + CUSUM), addFrom, and clear are each
0 B/op with `gc major = 0` (the CUSUM lanes construct with a target).

## Amendment (1.8.0) -- the `latch` option + `lastDriftIndex` / `lastDirection` (settle S9)

CONTEXT. The default (1.x) discipline RESETS on every fire, so a SUSTAINED regime re-fires on
nearly every item -- measured 5000 alarms in 5000 items for `CUSUM(target 0, delta .5, threshold 8)`
on a +10 step. A HUD drift marker (lite-hud M6) must fire ONCE per regime change, not once per item.
Settle S9 (maintainer): add an OPT-IN `latch` (default `false`, so every 1.x stream is byte-identical)
plus `lastDriftIndex` (the 0-based item index of the last fire, NaN before any) and `lastDirection`
(+1 / -1, NaN before any), in BOTH modes.

DECISION.
- `latch: false` (default) keeps the exact 1.x auto-reset-on-fire semantics.
- `latch: true`: a fire does NOT re-arm (the detector stays latched instead of auto-resetting). It
  fires ONCE (the arming -> latched transition), LATCHES, and re-arms only when the latched-direction
  gap falls back below `threshold / 2` (hysteresis) or on `clear()`. An OPPOSITE-direction gap
  `> threshold` while STILL latched fires immediately, flips the direction, and stays latched -- for
  CUSUM (independent accumulators) a sharp reversal is caught on its OWN item. For PH the running-mean
  reference is reset AT the fire and `_rearm()` keeps the mean built since (see the amendment below),
  so a sustained reversal is still REPORTED with the correct direction but not on its own item: the
  latched gap collapses to `threshold/2` and re-arms, THEN the opposite gap rebuilds against the
  post-shift mean over a few items (measured: `PH(.005, 50)` on `0/+10/-10` fires `2005+` then `4003-`
  -- ~3 items past the true edge; on `0/+10/-30`, `4002-` -- ~2). Only a single-item jump whose
  opposite gap alone exceeds `threshold` fires on its own item.

WHY THE ACCUMULATOR RESET MOVES TO RE-ARM. In latch mode the ACCUMULATOR reset MOVES from fire time to
re-arm time. A latched detector keeps accumulating; only when the regime demonstrably ends (the gap
decays under `threshold/2`) does it `_reset()`/`_rearm()` and re-arm at `_lvl = threshold`. This gives
clean one-fire-per-regime behavior with a Schmitt-trigger hysteresis band `[threshold/2, threshold]`
that rejects chatter around the boundary. (PH's running-mean REFERENCE is the exception: it resets at
the fire, not at re-arm -- see the `F-ph-latch` amendment below.)

THE CLAMP (clamp-ONLY-above-threshold). On a latched item the firing-direction accumulator is
re-clamped so the firing gap equals exactly `threshold` (PH: `gP = mMin + th` / `gN = mMax - th`;
CUSUM: `gP = th` / `gN = th`) ONLY when the latched gap is still ABOVE `threshold`. Without any clamp
a sustained regime drives the accumulator unbounded (and misreports the statistic; the `NoClampDD`
witness control measures 47500 for a `+10 x5000` latched CUSUM statistic that must read exactly
`threshold`). But clamping UNCONDITIONALLY was a fail-open bug: it re-inflated a SHRINKING gap back to
`threshold` on every item, so a gradual return to baseline never fell to `threshold/2`, the detector
never re-armed, and every later same-direction regime was silently missed (measured: `CUSUM(0,.5,8)`
on `+10 x100`, `0 x5000`, `+10 x100` fired ONCE, statistic stuck at 8, instead of the correct 2 fires
at 0 and 5100). The rule is therefore `if (latchedGap > threshold) clamp`: a SUSTAINED regime stays
bounded and never spuriously re-arms, while a gap already `<= threshold` (a genuine return toward
baseline) is LEFT to decay so it collapses past `threshold/2` and re-arms. This is the `F-latch-rearm`
fix; the `NeverRearmDD` control (which suppresses `_reset()` while latched) is rejected by the new
gradual-return witness lane.

PH RESETS THE RUNNING-MEAN REFERENCE AT THE FIRE (`F-ph-latch`, amends `F-ph-latch-rearm`). PH
deviates from the ONLINE running mean, so where the reference is reset is load-bearing. The correct
discipline is 1.x's: reset `_n` / `_mean` AT the fire, so the reference restarts from the shifted
level. In `_fired`, both the arming->latched fire and the opposite-direction re-fire run
`if (ph) { this._n = 0; this._mean = 0; }` before the clamp (CUSUM does not: its test deviates from
the FIXED `target`, and its accumulators reset only at re-arm). `_rearm()` then clears only the
accumulators + running extremes + the latch and KEEPS `_n` / `_mean` -- but because the reference was
already reset at the fire, by re-arm time those track the POST-SHIFT level (the running mean built
SINCE the last fire), which is exactly the reference a later reversal must deviate from.

An earlier attempt (`F-ph-latch-rearm`) reset the reference ONLY at re-arm and KEPT it across the
fire, on the theory that preserving the mean was what let a reversal be reported. That was itself a
FAIL-OPEN bug: with no reset at the fire the PH reference stayed the mean-since-`clear()` (the WHOLE
history), so a shift TOWARD a level near that historical mean never rebuilt a gap past `threshold` and
was never reported, and the reversal delay GREW WITHOUT BOUND with history. Measured pre-fix
`PH(.005, 50)`: `0/+10/+5` fired ONCE (`2005+`, the `+5` reversal swallowed); `0x100k/+10x100k/+5x100k`
fired ONCE (the reversal lost after a long up-regime); `0/+10/0/+10` reported the down edge at `4015`
(10 items late and growing). Post-fix those fire correctly: `0/10/5` -> `2005+, 4014-`;
`0x100k/10x100k/5x100k` -> `100005+, 200010-` (the down edge is bit-identical to `latch: false`, so the
delay is bounded by the step geometry, not history); `0/10/0/10` -> `2005+, 4007-, 6007+`. The
`PhNoFireResetDD` witness control (the pre-fix `_fired`, no reference reset at the fire) is REJECTED by
both new lanes (1 fire, not 2); the `PhSwallowRevDD` control (re-arm via `_reset()`) stays REJECTED by
the `0/10/-10` true-reversal lane. The disclosed trade: a PH reversal is reported a FEW ITEMS past the
true edge (the latched gap must collapse and the opposite gap rebuild), not on its own item unless a
single item jumps more than `threshold`. Measured delay vs the `latch: false` reference over the test
lanes: `+4` items on the `0/10/5` down edge, typically `+2` (the 4-regime `0/10/0/10/0` stream), `0`
on the long-history reversal, and `+10` on the staircase `0/10/20/10/0` down edge (15015 vs 15005) --
a few items, measured, not a general bound. A separate 1.x property (NOT a latch defect): with the default
`delta = 0.005`, uniform +-2 noise false-alarms in BOTH modes (order 10^2 fires over a 300k stream),
with `latch: true` firing roughly half as often as `latch: false` since it collapses a fire-storm into
re-arm cycles -- tune `delta` up to trade sensitivity for a quieter stream.

DIRECTION. The LARGER gap wins (PH: `gP - mMin` vs `mMax - gN`; CUSUM: `gP` vs `gN`); an exact tie
resolves to +1. On the arming->latched fire and on an opposite-direction re-fire, `lastDriftIndex`
and `lastDirection` are recorded.

HOT-PATH COST (the disclosed trade). The trip compare reads a mutable `_lvl` (armed: `threshold`;
latched: `-Infinity`) INSTEAD of `_threshold`, so a latched item lands in the EXISTING fire branch
with no new hot branch, and `latch: false` is OUTPUT-IDENTICAL to 1.7.0 (proven bit-for-bit by the
DDParity differential vectors, cut from HEAD before the edit). The fire branch calls a zero-arg
`_fired()` (no boxed double at the call boundary), and one `_s[0]++` accepted-add counter is stored
into an instance `Float64Array(3)` slot (never boxes). The disclosed cost of latch:true: while
LATCHED, `_lvl = -Infinity` routes EVERY item through the cold `_fired()` call, so latch:true
throughput is lower than latch:false. This is deliberate -- latch state is NEVER moved into the hot
body. The torture gate proves the three latched lanes (add PH, add CUSUM, addFrom) at 0 B/op.

RE-ARM LEVEL. A latch needs `threshold / 2 > 0`; a threshold whose half underflows (Number.MIN_VALUE)
throws at the door (QA-1.8.0-DD1: the floored CUSUM gap could never fall below 0, so it stayed latched
forever). With `DRIFT_CUSUM` and `delta = 0` a signal EXACTLY at target never decays the statistic, so it
stays latched until the signal moves below target -- disclosed; use `delta > 0` with a latch.

DISCLOSED TRADE. Because a latched detector holds its fire until re-arm, a SECOND same-direction
shift is NOT seen until the first regime ends (the gap decays under `threshold/2` and re-arms).
This is the intended one-marker-per-regime behavior; a consumer that needs every escalation within
one regime uses `latch: false`. A monotone STAIRCASE is the sharpest case: PH `0/10/20/30` fires ONCE
(`latch: false` fires at each of the 3 edges), and with `0/10/20` held for 50k items the detector stays
latched and never reports the 10->20 step (under the mean-since-fire reference the up gap decays
very slowly, so it does not re-arm). `lastDriftIndex` / `lastDirection` box one double per read (F6),
documented on the getters.

WITNESS. A `ddLatch` lane prints MEASURED vs contract: CUSUM +10 x5000 is 5000 fires (latch:false)
vs EXACTLY 1 (latch:true, `lastDriftIndex 0`, `lastDirection +1`, latched); an up-then-down stream
is EXACTLY 2 fires at indices 0 / 2500 with directions +1 / -1; a stationary stream is 0 fires and
`lastDriftIndex` NaN either way; a PH step fires once at the same item as its latch:false twin; a
slow ramp fires strictly fewer times latched. NEGATIVE CONTROL: a reset-on-latched-fire subclass
re-fires 5000 times and is REJECTED by the same "exactly one fire" gate.

## Amendment (1.10.0) -- latched-PH accumulator drift + fire box (H2-3), decision V0 + V3

On an infinite same-direction stream the latched PH running extremes (`gP` / `mMin`, `gN` / `mMax`)
drifted monotonically (~0.078 per item on a square wave) toward `Infinity`, and the latched fire boxed
one ~16 B HeapNumber in the Maglev tier (the 1.8.0 Known limitations). Five options were built on
scratch copies and run against the pre-declared rule (ROADMAP 10.1 section 3):

| option | what | box (fireheavy) | accumulator bound | parity |
| --- | --- | --- | --- | --- |
| V0 | argument-free `_clampGap(dir)` (reads `this._mode` / `this._threshold` from slots) | 0 B/op fresh + warmed | unchanged (still drifts) | bit-identical |
| V1 | re-centre at the end of every latched entry | -- | `2*th + 2*A = 30` | changes output every fire |
| V2 | V1 on fire items only | -- | 30 | changes output at each fire |
| V3 | V1 only when `max(\|mMin\|,\|mMax\|) > th * 2^20` | -- | `th * 2^20 + 30` | bit-identical UNTIL the trip |
| V4 | reset to canonical values at a fire | -- | 30 | changes output at each fire |

DECISION: ship **V0 + V3**. V0 removes the fire box (the `dd_latch_ph_fireheavy` gate tightens from
`<= 4` to `<= 0.25` B/op) with bit-identical output; V3 bounds all four accumulators to
`threshold * 2^20 + 30` while staying bit-identical until the re-centre trips (past a
`~threshold * 2^20` accumulator magnitude -- far beyond any parity series, so the 1.7.0 and 1.9.0
latched-PH vectors need no re-pin). On the torture drift lane the re-centre fires ~98 per 100k items.

IDENTICAL-UNTIL-FIRST-RE-CENTRE property: public output equals 1.9.0 exactly until the first re-centre.
After it, `statistic` is *more accurate* (1.9.0's unbounded accumulators suffer catastrophic
cancellation at a large-magnitude reversal, which the bounded re-centred accumulators avoid), and a
re-arm at an *exact* `threshold / 2` tie may resolve differently; `fired`, `mean`, `count`,
`lastDriftIndex` and `lastDirection` stay bit-identical, and the fire history is identical on the tested
streams (`phLatch` / `phSquare` / `phStep1` / `phStep2` / `phDemo`). `latch: false` and CUSUM (both latch
modes) are bit-identical to 1.9.0. Latched-PH throughput is 0.98x of 1.9.0. `_rearm` is untouched (it
already zeroes the accumulators).
