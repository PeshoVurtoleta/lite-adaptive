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

O(1) SPACE: six scalars (`_n`, `_mean`, `_gP`, `_gN`, `_mMin`, `_mMax`) -- no pool, no
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
