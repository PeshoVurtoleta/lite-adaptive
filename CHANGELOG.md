# Changelog

All notable changes to `@zakkster/lite-adaptive` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Demo (repo-only; `demo/` is not in the npm tarball, no library change)

The demo session (ROADMAP section 11). `Adaptive.js` is byte-identical to 1.11.0. Gates: `npm run demo`
(Demo.test + Demo.qa.test + the new DemoAudit.test + DemoSession.qa.test) all green with 0 todo; `npm test`
860/860.

- Re-baselined to 1.11.0: the SlidingHyperLogLog render (`countInto`) and the DriftDetector render
  (`dd.into`, 48 -> 0 B/tick) are gated 0 B/op lanes with must-box controls; the stale `dd_frame` todos
  are real gates (0 B/op since 1.10.0).
- SlidingCountMin scene (D7 / D8): the render reads through `estimateInto`; `total(W)` is shown beside the
  oracle N; a heavy-count mode pushes a tracked key past 2^31 (0 B/op; the scalar `estimate()` control
  boxes 16); a contracts line shows a bad sub-window reading NaN and the library's own did-you-mean.
- New Scene 10 -- SlidingAggregate: whole-ms latencies, count / sum / min / max gated EXACTLY equal to an
  independent recount, next to ExponentialHistogram's `sum()` breaking its epsilon on spikes (measured up to
  ~14.6% vs 5%, F17). 0 B/op frame and render lanes.
- S11: an on-demand, Chromium-only key-magnitude lane in the HeavyKeeper panel ("measure all"),
  self-tested against a boxing control ("n/a (meter blind)", never 0). It drives every hashed-key member's
  `addFrom` (HeavyKeeper, SlidingHyperLogLog, SlidingCountMin) with small, [2^30, 2^31), >= 2^31 and
  <= -(2^30 + 1) keys, and proves each window reached `addFrom`. Measured in headless Chrome 154 with
  precise memory info (control 12.00 B/op): every member x key class reads 0.0 B/op in 4/4 runs; raw key
  windows 0.0013 - 0.0051 B/op (a per-window constant), 3 of 384 single-window outliers (0.10 - 0.33)
  dropped by the aggregate. N6 is closed for every hashed-key member.
- `demo/DemoAudit.test.mjs`: the static DEMO AUDIT (unique ids, cached DOM lookups incl. handlers and toggle
  callbacks, no per-frame closure / format / string build over the call graph from `loop`, no layout read
  after a write, layout reads only in `measureScene`, tick writes only through the write-on-change helpers,
  pointer events, `:hover` in `@media (hover: hover)`, hex before oklch, no inline style), each rule with an
  injected-violation control.

### Fixed (demo)

- Two duplicate ids (`eh-eps`, `dr-hl`) made two readouts write into their slider `<input>` and never update.
- The SlidingCountMin oracle expired the oldest LIVE pane (`<=` for `<`): its N ran one pane short of
  `total()` and every tracked `true(W)` was under-counted, so the one-sided bound gate was weaker than
  claimed. Found by the new `total(W)` readout; gated by a from-spec recount.
- Turning a scene's exact oracle off (SCM) showed a false "VIOLATED"; oracle slots now read "n/a" while off
  and until a full covered span refills.
- Forced reflows: one per canvas in every scene layout (now one per layout, two-phase sizing) and one in
  three rebuild handlers; per-frame closures in two draw functions; DOM lookups in 16 handlers.
- Readouts: every ~10Hz readout is write-on-change (no format and no DOM write for an unchanged value; NaN
  renders "n/a"); a count above 2^31 no longer wraps through an int32 fold; `fmtNum(NaN)` renders "n/a".
- The tab bar scrolls instead of clipping the last tabs; the space bar pauses every scene.

## [1.11.0] - 2026-09-28

The zero-alloc READERS release (ROADMAP section 12; one feature). Two render readers --
`SlidingHyperLogLog.countInto` and `DriftDetector.into` -- plus the estimator fix that makes
`SlidingHyperLogLog.count()` itself 0-box (output bit-identical to 1.10.0). The only other behavior change is
on invalid input: the cold readers reject a prototype-swapped typed array / DataView. Gates: npm test
860/860; torture 0 B/op on every lane (0 major GC); test:perf 33/33; test:perf:matrix 167/167 incl. the
`--no-turbo-inlining` reader rows; witness ok; gates:red exit 0.

### Added

- **`SlidingHyperLogLog.countInto(out, w?) -> 1`** -- the 0-alloc render sibling of `count(w?)`. Writes
  `count(w)` into `out[0]` (the SAME value, `Object.is`-identical -- one estimator path, no duplicated
  math) and returns `1`. A bad sub-window `w` writes `out[0] = NaN` and returns 1 (the F12 NaN contract,
  never a throw); an unset sketch writes 0. `out` must be a `Float64Array` of length `>= 1`: a wrong
  container TYPE throws `TypeError`, a short one `RangeError` (length read ONCE via the intrinsic getter),
  and `out` is untouched on a throw. 0 B/call at a monomorphic / poly-4 site (mega5 INFO 16 B).
- **`DriftDetector.into(out) -> 5`** -- the 0-alloc render reader. Writes
  `[statistic, mean, count, lastDriftIndex, lastDirection]` into `out[0..4]` (each slot `Object.is` its
  matching getter) and returns `5`. A never-fed or cleared detector writes `[0, 0, 0, NaN, NaN]`; after a
  reset-on-fire the count is 0 but slots 3-4 KEEP the last fire. `out` must be a `Float64Array` of length
  `>= 5` (wrong TYPE -> `TypeError`, short -> `RangeError`). FAIL CLOSED: when `count > 0` the accumulator
  guard runs BEFORE the first slot write, so a non-finite accumulator throws the SAME `RangeError` the
  `statistic` / `mean` getters throw and `out` stays untouched (never a partial write). 0 B/call at a
  monomorphic / poly-4 site (mega5 INFO 160 B); a six-getter render loop boxes ~48 B/frame.

### Changed

- **The `SlidingHyperLogLog` estimator tail is now 0-box.** `slSigma` / `slTau` and the count no longer
  RETURN a computed double (each returned double boxes a ~16 B HeapNumber at a non-inlined call boundary --
  the 1.8.0 finding A stable box inside `count()`). They are now VOID helpers writing their converged value
  into SHLL-only module-level scratch (`SL_EST` / `SL_SIG_S` / `SL_TAU_S` / `SL_CUT`, re-entrancy-safe like
  HeavyKeeper's `HK_KIN`), and the shared `_writeCount` estimator body writes the rounded count straight
  into a caller slot. `count()` is now **0 B/call steady** (and 0 B/op under `--no-turbo-inlining`),
  boxing only its one returned double at a megamorphic 5+ shape site. Output is **bit-identical to 1.10.0**
  on the SHLLParity + F19Boundary vectors and a 1e6 random-query sweep.
- **The cold readers now check the INTRINSIC type tag (S2 RE-SETTLED).** `SlidingHyperLogLog.countInto`,
  `DriftDetector.into`, `SlidingAggregate.into`, `SlidingCountMin.estimateInto`,
  `SlidingDDSketch.quantileInto`, `HeavyKeeper.topKInto` and `DecayedReservoir.sampleInto` verify the
  container with the `%TypedArray%.prototype[@@toStringTag]` getter (captured at module init as `TA_TAG`;
  it reads the element-kind of the internal slot and returns `'Float64Array'` only for a genuine
  `Float64Array`, runs no user code) instead of `ArrayBuffer.isView(x) && x instanceof Float64Array`. This
  is a **behavior change on invalid input only**: a prototype-swapped `Uint8Array` / `DataView` re-parented
  to `Float64Array.prototype` is now REJECTED with the tagged `TypeError` -- before, it was accepted with
  silent byte truncation, or hit a native error. HOT entry points keep `isView && instanceof`. A valid
  `Float64Array` behaves byte-identically.

### Fixed

- **RESOLVED: the 1.8.0 Known limitation on `SlidingHyperLogLog.count(w?)` (16-32 B/call, the `[12, 40]`
  band).** The estimator-tail box is gone (see Changed above): `count()` is 0 B/call steady, and the
  `q_shll_count` lane is re-cut accordingly. What REMAINS is the megamorphic-site field-read box -- at a
  call site of 5+ subclass shapes V8 boxes the one returned double (the family-wide clock/field-read box
  already logged for `SlidingAggregate` in 1.10.0); use `countInto` for a guaranteed 0-alloc render path.

## [1.10.0] - 2026-09-28

The H2 HARDENING release (ROADMAP section 10; fail-open + allocation findings in the shipped classes).
NOT a pure append: `SlidingCountMin`, `SlidingDDSketch` and `DriftDetector` change in place. MINOR bump:
behavior changes are limited to inputs that previously produced a WRONG or corrupt answer (an
out-of-precision clock, a Proxy / length-lying container, an `undefined` buffer read) plus the
grid-exact pane-end move (bit-identical for a dyadic pane width). Valid inputs behave byte-identically,
except the pane-end grid correction for a NON-dyadic pane width (the old accumulated `E += pw` drifted up to
450 ulp) and the latched Page-Hinkley `statistic` after its first accumulator re-centre (past ~th * 2^20;
more accurate, fire history identical on every tested stream). Gates: npm test 817/817; torture 0 B/op on
every lane (0 major GC); test:perf 33/33; test:perf:matrix 149/149; witness ok; gates:red exit 0.

### Fixed

- **H2-1 -- `SlidingCountMin` and `SlidingDDSketch` fail CLOSED on a clock outside the pane-grid precision
  domain (was a silent under-count / collapsed window).** Exact pane containment needs the double clock to
  resolve the pane grid (`ulp(now) << pw`, `pw = W / panes`), so `|now|` (and the count-mode tick) must be
  `<= pw * 2^42` (`SCM_CLOCK_SPAN` / `SLD_CLOCK_SPAN`); at the bound `ulp(now) <= pw * 2^-10`, so the grid
  line `(floor(now/pw) + 1) * pw` still CONTAINS the true window. Before this, a large epoch clock at a
  small `W` silently mis-answered: `new SlidingCountMin(1e-3)` then `add(1.75e12, 7)` x3 read `estimate 1`
  (not 3), and the same shape collapsed a `SlidingDDSketch` window. `add` / `addFrom` / `advance` /
  `advanceFrom` now reject a larger clock with a `RangeError [lite-adaptive]` BEFORE any state write (one
  field compare against `this._nowMax = pw * 2^42`, precomputed in the ctor -- rebase the clock, e.g.
  `performance.now()`, or use a larger `W`). A SUBNORMAL pane width (`W / panes < 2^-1022`,
  `SCM_MIN_NORMAL` / `SLD_MIN_NORMAL`) is rejected at construction (it under-covers `W`). Generous for real
  clocks (32 panes): epoch-ms allows `|now| <= 1.37e14` at `W = 1000`, `8.25e15` at `W = 60000`; `W = 16`
  epoch-ms is legal until ~2039-09 (disclosed) and `W < 12.7` epoch-ms is rejected today; epoch-us allows
  `1.37e17` at `W = 1e6` (`W = 1e4` rejected, min 12,733 us). Gates: `test/Hardening110.test.js` H2-1,
  `test/differential/GridParity.test.mjs`.
- **H2-1 (behavior change) -- `SlidingCountMin` / `SlidingDDSketch` pane ends are computed on the exact grid
  `(k+1) * pw`, not an accumulating `E += pw`.** For a DYADIC pane width `pw` the two are bit-identical
  (GridParity D + count-mode replay bit-identical to the 1.9.0 goldens over 20000 adds x 5 configs). For a
  NON-DYADIC `pw` the accumulator drifted (HEAD drifted up to 450 ulp on the non-dyadic configs); the grid
  form now matches the exact `(floor(t/pw)+1)*pw` oracle at every boundary.
- **H2-3 -- `DriftDetector` `latch: true` PH accumulators no longer drift without bound, and the latched
  fire no longer boxes (resolves both 1.8.0 Known limitations).** On an infinite same-direction stream the
  running `gP` / `mMin` (and `gN` / `mMax`) drifted monotonically (~0.078/item on a square wave) toward
  `Infinity`. The chosen fix is V0 + V3 (ROADMAP 10.1 pre-declared rule): `_clampGap(dir)` is now
  argument-free (it reads `this._mode` / `this._threshold` from slots instead of taking the mode /
  threshold doubles across a non-inlined call boundary -- V0), so the fire-heavy latched-PH lane measures
  **0 B/op** fresh AND warmed and the `dd_latch_ph_fireheavy` gate tightens from `<= 4` to `<= 0.25`; and
  a GATED re-centre (V3) runs after the arming, opposite-fire and sustained branches of the latched cold
  `_fired()`: once `max(|mMin|, |mMax|) > threshold * DD_RECENTRE_SPAN` (`2^20`) it subtracts the running
  min/max off the accumulators (`gP -= mMin; mMin = 0; gN -= mMax; mMax = 0`), bounding all four to
  `threshold * 2^20 + 30` (`ulp(threshold * 2^20)` stays far below `threshold`, so the bound costs no fire
  accuracy; it fires ~98 per 100k items on the torture drift lane). The re-arm branch is untouched
  (`_rearm` already zeroes the accumulators). **Public output is IDENTICAL to 1.9.0 UNTIL the first
  re-centre** (which trips only past a ~`threshold * 2^20` accumulator magnitude -- far beyond any parity
  series, so the 1.9.0 latched-PH golden vectors and the 1.7.0 vectors stay green with no re-pin). **After
  a re-centre trips**, `statistic` is *more accurate* (1.9.0's unbounded accumulators suffer catastrophic
  cancellation that the bounded re-centred accumulators avoid) and a re-arm at an *exact* `threshold / 2`
  tie may resolve differently; `fired`, `mean`, `count`, `lastDriftIndex` and `lastDirection` stay
  bit-identical, and the fire history is identical on the tested streams. `latch: false` and CUSUM (both
  latch modes) are bit-identical to 1.9.0. New gates: `test/Hardening110.test.js` H2-3,
  `test/Hardening110.qa.test.js` P2, and a `dd_latch_ph_drift` torture lane.
- **H2-4 -- every container guard rejects a Proxy-over-`Float64Array` and a NaN-length view (fail-closed),
  under a HOT/COLD threat model that keeps the zero-GC hot path (SETTLED 2026-09-28).** All 20 `addFrom` /
  `advanceFrom` / Into sites now verify the type with `ArrayBuffer.isView(x) && x instanceof Float64Array`
  (a Proxy passes `instanceof` alone but not `isView`) and use NaN-safe bounds `!(i + k < n)`. HOT entry
  points (`addFrom` / `advanceFrom`) read `x.length` ONCE into the index bound: a caller-defined subclass
  `length` getter is the caller's own code and may run at most once per call (documented). COLD render
  readers (`into` / `estimateInto` / `quantileInto` / `topKInto` / `sampleInto`) read the length through
  the intrinsic `%TypedArray%.prototype.length` getter (`TA_LEN`, captured at module init), so a lying or
  re-entrant `length` is ignored and never runs and a benign subclass is accepted with correct results.
  A valid `Float64Array` argument behaves byte-identically. Gates: `test/Hardening110.qa.test.js` (C1-C9)
  and `test/TrapFreeReject.test.js` (H34 rows).
- **H2-4b -- a length-lying `Float64Array` subclass no longer slips an `undefined` buffer read past the
  hot-path value / `now` guards (fail-closed).** Every `addFrom` / `advanceFrom` value and `now` check
  written `x !== x || x === Infinity || x === -Infinity || ...` ACCEPTED `undefined` (a subclass whose
  `length` getter lies makes `buf[i]` return `undefined`), which drove `DriftDetector` / `ADWIN` `_mean`
  to `NaN` and left `_lastNow = undefined` (monotone guard off) on `ExponentialHistogram`, `ForwardDecay`,
  `DecayedReservoir`, `SlidingHyperLogLog`, `SlidingDDSketch`. Replaced each with the positive form
  (`!(now > -Infinity && now < Infinity)`, `!(v > 0 && v < Infinity)`, `!(x <= ADWIN_X_MAX && x >= -ADWIN_X_MAX)`,
  `!(v > -Infinity && v < Infinity)`, `!(x <= DD_X_MAX && x >= -DD_X_MAX)`): every finite / non-finite
  NUMBER is accepted or rejected exactly as before (byte-identical no-op on reject, reaching the same
  thrower), only `undefined` now fails closed. `SlidingCountMin` / `SlidingDDSketch` `now` checks were
  already safe (their `nowMax` range form rejects `undefined`); `SlidingAggregate` untouched.
- **H2-6 -- a rejected mutating call is now a byte-identical no-op even when the bad argument is a Proxy
  (or any object with `toString` / `valueOf` / `Symbol.toPrimitive`).** About 125 throw sites built the
  reject message as `'...got ' + String(userArg)`; `String()` on such an object RUNS caller code AFTER the
  guard has already decided to reject, so a re-entrant trap could mutate the same instance --
  `SlidingCountMin`, `SlidingAggregate` and `DriftDetector` threw the tagged error yet left `total` /
  `count` advanced (the reject was not the no-op the contract promises). Added one cold module-private
  `describeArg(x)` helper (`typeof` + `ArrayBuffer.isView` never fire a Proxy trap; `String` only on a
  primitive) and replaced every `String(userArg)` in a throw message with it. **Number reject messages
  stay byte-identical**; an object / function / typed-array view is named inertly (`'an object'` /
  `'a function'` / `'a typed-array view'`). Family-wide, every class (`SlidingAggregate` included). New
  gate `test/TrapFreeReject.test.js` drives every validating method of all ten classes (ctors + both
  `withAccuracy` factories) with a hostile Proxy and asserts the reject fires no caller code and mutates
  nothing.

### Changed

- **`SlidingCountMin` / `SlidingDDSketch` ctors precompute `this._nowMax = pw * 2^42`** and their
  `_anchor` / `_advance` helpers are now argument-free (they read `this._now` and compute pane ends from
  the grid index), matching `SlidingAggregate`. No new public API; no `bytes` change.
- **Hot-path throughput is flat.** An in-process A/B vs 1.9.0 measures hot `addFrom` at 0.98-1.01x across
  the family, except `ExponentialHistogram` at ~0.95x (from the stricter positive-form `now` check, H2-4b);
  latched-PH throughput is 0.98x of 1.9.0.
- **The `SlidingHyperLogLog.countInto` reader and the `DriftDetector` `statisticInto` / `meanInto` readers
  move to 1.11.0** (README, `llms.txt`, `Adaptive.d.ts` JSDoc). 1.10.0 is hardening only, one feature per
  minor; the latched-PH fix that shared their 1.9.0->1.10.0 retarget ships here (H2-3).

### Known limitations

- **`SlidingHyperLogLog.count(w?)` is NOT 0 B/call.** It keeps its Ertl multiplicity scratch (no ARRAY
  allocation) but RETURNS a rounded double: a stable **16 B/call** in the estimator tail even under
  Turbofan, plus another **16 B** when the caller is not yet optimized (16-32 B/call). The `q_shll_count`
  lane gates it in the documented band `[12, 40]` B/op. The 0-alloc `countInto` reader is planned for
  1.11.0 (the zero-alloc readers minor).
- **H2-5 -- a scalar reader that RETURNS a double boxes one 16 B HeapNumber at a MEGAMORPHIC call site
  (5+ receiver subclass shapes).** This is a V8 property (a double FIELD read across such a site boxes),
  not a fix in reach without moving every hot body onto a per-instance state slab (which changes `bytes`);
  logged for a later minor, measure-and-document only. Per-class INFO lanes record it: `mega5` reads
  `SlidingCountMin` 49 B/op and `SlidingDDSketch` 70.5 B/op at 5 maps. The `into` / `estimateInto` /
  `quantileInto` / `forEach` / `sampleInto` readers stay 0 B/call and are the render path.

## [1.9.0] - 2026-09-27

The sixth additive post-1.0 member (`SlidingAggregate`, ADR 0012) -- a PURE APPEND. All nine prior classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`, `DriftDetector`,
`SlidingDDSketch`, `SlidingCountMin`, `DecayedReservoir`) are BYTE-IDENTICAL (a per-class sha256 gate,
`test/differential/AppendParity.test.mjs`); outside the append only the file header, the optDoor docblock
count and the `VERSION` const change. MINOR bump (new API, no break). Gates: npm test 581/581; torture 0 B/op
on all 61 lanes (0 major GC); test:perf 33/33; test:perf:matrix 127/127; witness ok incl. the lite-hud lane;
gates:red exit 0; 40/40 reviewer mutants killed.

### Added

- **`SlidingAggregate` -- EXACT windowed count / sum / mean / min / max over the last `W`, in fixed
  memory (ADR 0012).** The aggregate the family lacked: `ExponentialHistogram.sum()` is bounded by the
  oldest straddling bucket's POPULATION, not its value mass, so it fails on a skewed stream (F17), while
  `SlidingDDSketch` answers quantiles and `SlidingCountMin` per-key counts. `SlidingAggregate` keeps a
  ring of **B+1 preallocated panes** of width `W / B` (the `SlidingCountMin` ring, COPIED verbatim --
  never a shared helper, so that member's bytes and behavior cannot move), each a stride-5 `Float64Array`
  slot `[count, sum, kcomp, min, max]`.
  - `new SlidingAggregate(W, { panes })` -- `W` a finite number `> 0`; `panes` the pane count `B`, an
    integer in `[2, 1024]` (default 32; the ring holds `B + 1`). Throws `[lite-adaptive]` typeof-first,
    before any allocation; a `W` too small for `panes` (`W / panes` underflows to 0), or a `W / panes`
    that is a SUBNORMAL double (the pane grid cannot hold `W` exactly -- QA190 F3), throws before
    allocation.
  - `add(now, value)` / the zero-box stride-2 `addFrom(buf, i)` (`[now, value]`) -- HOT, 0 B/op incl. the
    pane rotate + clear. EXPLICIT mode (a finite, non-decreasing `now`) or COUNT mode
    (`add(undefined, value)`, auto-tick); the mode locks at the first add (a switch throws). Each add does
    `count += 1`, a branch-free Kahan compensated sum (`y = v - c; t = s + y; c = (t - s) - y; s = t`),
    and min / max by comparison on the current pane. `value` is **REQUIRED** (no default of 1 -- a
    forgotten latency must fail closed): a finite real with `|value| <= 1e150` (`SA_X_MAX`, the same cap as
    `DriftDetector`'s `DD_X_MAX`, so `|sum| <= n * 1e150` and every Kahan / Neumaier intermediate stays
    finite). A non-number / `NaN` / `+-Infinity` / over-cap value throws `[lite-adaptive]` value-first (a
    byte-identical no-op).
  - **Clock-precision domain (fail-closed; QA190 F1/F2).** Exact containment needs the double clock to
    resolve the pane grid (`ulp(now) << pw`), so `|now|` (and the count-mode tick) must be `<= pw * 2^42`
    (`SA_CLOCK_SPAN`); at the bound `ulp(now) <= pw * 2^-10`, so `(floor(now/pw)+1)*pw` still CONTAINS the
    true window. `add` / `addFrom` / `advance` / `advanceFrom` reject a larger clock with
    `RangeError [lite-adaptive]` BEFORE any state write (one field compare against `this._nowMax = pw * 2^42`
    precomputed in the ctor -- rebase the clock, e.g. `performance.now()`, or use a larger `W`). Pane ends
    are computed by multiplication from the grid index (`(k+1) * pw`), not an accumulating `E += pw` that
    drifts near the domain edge. Generous for real clocks: epoch-ms (`W=1000, B=32`) allows
    `|now| <= 1.37e14`, epoch-us (`W=1e6`) `<= 1.37e17`, `performance.now()` (`W=16`) `<= 2.2e12` ms.
  - `advance(now)` / `advanceFrom(buf, i)` -- built in from the start (R11 idle-slide; ADR 0009 amended):
    rotate + clear stale panes with no value added, EXPLICIT-time only, monotone, 0 B/op.
  - `count(w?)` / `sum(w?)` / `mean(w?)` / `min(w?)` / `max(w?)` / `into(out, w?)` -- COLD readers that
    Neumaier-merge the LIVE, non-empty panes (the straddling oldest pane KEPT) over `{s_p, -c_p}`. Over
    the COVERED span `[w, w + W/B]` (which always CONTAINS the true window) `count`, `min` and `max` are
    **BIT-EXACT** and `|sum - exact| <= (4u + O(N u^2)) * sum|v|`, `u = 2^-53` (Kahan per pane `2u`, Higham
    ASNA eq. 4.8; the Neumaier merge over the `2(B+1)` terms adds `2u`); `mean = sum / count`. An empty
    covered window reads `count` 0, `sum` 0, `mean` / `min` / `max` `NaN` (a cleared pane holds identity
    sentinels `min +Infinity` / `max -Infinity`, never `fill(0)`; null is not zero). A bad sub-window `w`
    (outside `(0, W]`) returns `NaN` and never throws; `into(out)` writes `[count, sum, mean, min, max]`
    into a caller `Float64Array` (length `>= 5`) and is **0 B/call** at a monomorphic / polymorphic site
    (16 B/call at a megamorphic site of 5+ subclass shapes -- a family-wide V8 clock-field box, logged for
    1.10.0). The scalar readers box their return once (up to 16 B/call; up to 32 B at a megamorphic site)
    -- use `into()` on a render path. A wrong CONTAINER type (a non-`Float64Array` `out`, or `out.length
    < 5`) throws.
  - `clear()`; getters `W` / `panes` / `mode` / `lastNow` / `bytes` (`= (B + 1) * 48`; **1584 B** at the
    default `B = 32`, independent of `W`, never grows; 50 lite-hud channels = 79,200 B).
  - MEASURED (the honesty anchor, ADR 0012): against a lite-hud lane of 50 lognormal-ms channels,
    `SlidingAggregate` vs its covered span is EXACT (mean worst relative error **0**) where
    `ExponentialHistogram` vs the true window is **1.27e-1** off and vs SlidingAggregate's covered span is
    **2.62e-1** off. Against a TRUE `(now - W, now]` oracle the mean's worst relative error at the pane
    edge is **8.61e-3** at 32 panes and **2.93e-3** at 128 panes (the worst single case ~0.35, dominated by
    lognormal outliers in near-empty windows). The witness gates the merged count / sum / mean / min / max
    against an exact covered-span oracle (BigInt over quantized values) and a true-window lane, with a
    mutation test of `w` for every reader; controls REJECTED by the same gates: a B-pane ring, no clear on
    rotate, a dropped straddling pane, Kahan removed, Neumaier removed, empty-pane `fill(0)` poisoning.
    `add` / `addFrom` / `advance` / `advanceFrom` / `clear` are torture-gated at 0 B/op (0 major GC),
    including EVENT-HEAVY rotate-every-add epoch-clock lanes and a +1e12 `advance` + `add` jump
    (p99 < 0.005 ms) with a per-pane-loop control.

### Changed

- **The `SlidingHyperLogLog.countInto` reader, the latched-PH allocation fix, and the `DriftDetector`
  `Into` readers are retargeted from 1.9.0 to 1.10.0** (README, `llms.txt`, `Adaptive.d.ts` JSDoc). 1.9.0
  is `SlidingAggregate` only (one feature per minor); the three previously "planned / tracked for 1.9.0"
  items move to the next minor.

## [1.8.0] - 2026-09-27

The additive-API release (ROADMAP section 8). MINOR bump: `DriftDetector` gains the opt-in `latch`
option with `latched` / `lastDriftIndex` / `lastDirection` (`latch: false` is output-identical to
1.7.0, proven by the DDParity vectors); `SlidingCountMin` gains `total(w?)` and the 0-alloc
`estimateInto(keys, out, w?)`; F19 moves the HeavyKeeper / SlidingHyperLogLog / SlidingCountMin hash
paths to register int32 locals (bit-identical output, throughput guarded against the frozen 1.7.0
file). Two allocation findings from the demo probe are disclosed under Known limitations. Gates: npm
test 517/517; torture 0 B/op on all 54 lanes (0 major GC); test:perf 30/30; test:perf:matrix 93/93;
gates:red exit 0.

### Added

- **`DriftDetector` `latch` option + `lastDriftIndex` / `lastDirection` / `latched` getters (settle
  S9; ADR 0007 amendment).** A new `latch` boolean option (default `false`, so every 1.x stream is
  byte-identical -- proven bit-for-bit by the DDParity differential vectors). With `latch: true` the
  detector fires ONCE per regime instead of on every sustained item: a fire LATCHES (re-clamping the
  firing gap back to `threshold` ONLY while it is still ABOVE `threshold`, so a SUSTAINED regime stays
  bounded and never spuriously re-arms, while a gap already `<= threshold` -- a gradual return to
  baseline -- is left to decay) and re-arms only when the latched-direction gap falls below
  `threshold / 2` (hysteresis) or on `clear()`. An OPPOSITE-direction crossing while latched flips
  direction and is REPORTED in BOTH modes: CUSUM (independent accumulators) fires on the reversal's
  own item, while PH resets its running-mean reference AT the fire and `_rearm()` keeps the mean built
  since, so a sustained reversal re-arms first and rebuilds the opposite gap against the post-shift
  mean, reported a few items past the true edge (not on its own item unless a single item jumps more
  than `threshold`). Measured: `CUSUM(target 0, delta .5, threshold 8)` on a +10 x5000 step fires 5000
  times unlatched vs EXACTLY 1 latched; on +10 x100 / 0 x5000 / +10 x100 (a regime, a gradual return,
  then a NEW regime) it fires EXACTLY twice, at items 0 and 5100. `PH(delta .005, threshold 50)` on
  0/+10/-10 (each x2000) fires EXACTLY twice -- `2005+` then `4003-` (~3 items past the reversal edge);
  on 0/+10/-30, `4002-` (~2). Three new getters, in BOTH modes: `latch`
  (the option), `latched` (currently latched?), `lastDriftIndex` (0-based item index of the last
  fire, NaN before any -- null is not zero) and `lastDirection` (+1 / -1, NaN before any). The
  option is validated typeof-first (a non-boolean throws `[lite-adaptive]`, no truthy coercion).
  Disclosed trade: while latched every item routes through the cold fire path, so `latch: true`
  throughput is lower than `latch: false`; and a SECOND same-direction shift is not seen until the
  regime ends and re-arms. `lastDriftIndex` / `lastDirection` box one double per read (F6). The hot
  `add` / `addFrom` gain only a mutable trip-level read, a zero-arg fire call, and one typed-array
  counter store -- the torture gate proves the three latched lanes (add PH, add CUSUM, addFrom) at
  0 B/op and the existing DD lanes unchanged at 0 B/op.
- **`SlidingCountMin.total(w?)` -- the exact windowed item total N (the `eps x N` denominator).**
  Returns the EXACT number of items observed over the covered span (the last W, or a sub-window
  `w <= W`), summed from a NEW per-pane Float64 total over the SAME live panes as `estimate`
  (`paneEnd > now - effW`, INCLUDING the straddling oldest pane), so N covers exactly the span
  `estimate` covers (`[W, W + W/B]`). EXACT, not saturated: the `d x w` cells saturate at
  `2^32-1`, but this Float64 total sums the VALIDATED per-add `count` and a pane loses no unit
  until its running total passes `2^53`. Fail closed (F12 parity with `estimate`): a bad
  sub-window `w` (non-number / NaN / +-Infinity / `<= 0` / `> W`) returns NaN, an unset instance
  (no add yet) returns 0 (null is not zero). COLD, `O(B+1)`, 0 B/call.
- **`SlidingCountMin.estimateInto(keys, out, w?)` -- the 0-alloc batch reader (closes F6).**
  `keys` and `out` are caller-owned Float64Arrays; for each key j it writes `out[j] =
  estimate(keys[j], w)` (NaN for an out-of-domain key, 0 for an unseen valid key / empty window,
  else the sum-then-min windowed frequency; a bad sub-window `w` fills every `out[j]` with NaN),
  and returns `keys.length`. No computed double is returned from, or passed across, a non-inlined
  call, so it is 0 B/op where the scalar `estimate` still boxes ONE ~16 B HeapNumber per call for a
  windowed count `>= 2^31`. It replaces that boxed return on the render path. Container-TYPE
  contract (a wrong container is a programming error, distinct from a bad data VALUE): a
  non-Float64Array `keys`/`out`, or `out.length < keys.length`, throws a tagged
  TypeError/RangeError BEFORE any write (a byte-identical no-op). COLD, 0 B/op.

### Changed

- **`SlidingCountMin` `bytes` grows by `(panes+1) * 8`** for the new per-pane Float64 total
  (`_paneTotal`, one slot per ring pane; the ring holds `B+1` panes). The default
  `new SlidingCountMin(60000)` (B = 32) now reports **338468 B**, up from **338204 B** (+264 B).
- **F6 is closed.** With `estimateInto` shipped as the 0-alloc reader for the boxed `estimate`
  count `>= 2^31`, no boxed hot read remains under `todo`, so `npm run gates:red` now exits 0 (no
  `todo` gate remains).
- **`estimateInto` documents its aliasing contract:** `keys` and `out` MAY be the same
  `Float64Array` (each slot is read then written before the next), but must NOT PARTIALLY OVERLAP
  (an aliased non-zero offset clobbers not-yet-read keys and yields wrong results).

### Fixed

- **`DriftDetector` `latch: true` with a `threshold` whose half underflows to 0 fails closed
  (QA-1.8.0-DD1).** With `threshold = Number.MIN_VALUE`, `threshold / 2` rounds to 0, so a floored
  CUSUM gap could never fall below the re-arm level: the detector stayed latched forever and silently
  missed every later regime. The constructor now throws a tagged `RangeError` for a latch whose re-arm
  level is not `> 0` (`2 * Number.MIN_VALUE` and above are accepted; `latch: false` is unaffected).
  Disclosed alongside: with `DRIFT_CUSUM` and `delta: 0`, a signal sitting exactly at `target` gives
  the statistic no evidence to decay, so it stays latched until the signal moves below target -- use
  `delta > 0` with `latch`.

- **`DriftDetector` `latch: true` now RE-ARMS on a gradual return to baseline (the F-latch-rearm
  clamp fix).** A latched detector re-clamped the firing-direction accumulator back to `threshold` on
  EVERY latched item, which re-inflated a SHRINKING gap so a gradual return to baseline never fell to
  `threshold / 2` -- the detector never re-armed and every LATER same-direction regime was silently
  missed. The clamp is now conditional: `if (latchedGap > threshold) clamp`, so a sustained regime
  stays bounded while a gap already `<= threshold` is left to decay and re-arm. Measured before:
  `CUSUM(target 0, delta .5, threshold 8, latch)` on +10 x100 / 0 x5000 / +10 x100 fired ONCE with the
  statistic stuck at 8; after: EXACTLY 2 fires at items 0 and 5100. A new true-regime-boundary witness
  lane (oracle = the ground-truth regime edges), a `DriftDetector.test.js` gradual-return case, and a
  sustained-latched `statistic === threshold` assertion guard it; the `NeverRearmDD` and `NoClampDD`
  witness controls are both REJECTED by these gates. This latch discipline is new in this cycle, so no
  released version was affected.
- **`DriftDetector` PH `latch: true` now resets the running-mean reference AT the fire, so a reversal
  toward the running mean is reported and the delay does NOT grow with history (the F-ph-latch fix,
  amends F-ph-latch-rearm).** PH deviates from the ONLINE running mean, so where that reference resets
  is load-bearing. The 1.x discipline is to reset `_n` / `_mean` AT the fire so the reference restarts
  from the shifted level; `_fired` now runs `if (ph) { this._n = 0; this._mean = 0; }` on both the
  arming->latched fire and the opposite-direction re-fire (CUSUM does not: it deviates from the FIXED
  `target` and resets only at re-arm). `_rearm()` still keeps `_n` / `_mean`, but since the reference
  was already reset at the fire, by re-arm time they track the POST-SHIFT level -- exactly the
  reference a later reversal must deviate from. The earlier fix reset the reference ONLY at re-arm and
  KEPT it across the fire; that was itself fail-open -- the PH reference stayed the mean-since-`clear()`
  (the whole history), so a shift TOWARD a level near that historical mean was never reported and the
  reversal delay grew without bound with history. Measured before: `PH(delta .005, threshold 50,
  latch)` on 0/+10/+5 (each x2000) fired ONCE (`2005+`, the `+5` reversal swallowed); on
  0x100k/+10x100k/+5x100k, ONCE (the reversal lost after a long up-regime); 0/+10/0/+10 reported the
  down edge at `4015` (10 items late and growing). After: EXACTLY 2 fires -- `0/10/5` -> `2005+, 4014-`;
  `0x100k/10x100k/5x100k` -> `100005+, 200010-` (the down edge is bit-identical to `latch: false`, so
  the delay is bounded by the step geometry, not history); 0/10/0/10 -> `2005+, 4007-, 6007+`. Two new
  witness lanes (the 0/10/5 fire-reset lane and the 0x100k/10x100k/5x100k long-history lane, oracle =
  the true step edges) plus mirrored `DriftDetector.test.js` cases guard it, and a `PhNoFireResetDD`
  control (the pre-fix `_fired`, no reference reset at the fire) is REJECTED by both (1 fire, not 2);
  the `PhSwallowRevDD` control stays REJECTED by the `0/10/-10` lane. Disclosed trade: a PH reversal is
  reported a few items past the true edge (measured delay vs `latch: false`: `+4` items on the `0/10/5`
  down edge, typically `+2`, `0` on the long-history reversal, `+10` on a `0/10/20/10/0` staircase --
  measured, not a general bound; a monotone staircase `0/10/20/30` fires ONCE under the latch), not on its
  own item unless a single item jumps more than `threshold`. A separate 1.x property (not a latch
  defect): with the default `delta = 0.005`, uniform +-2 noise false-alarms in BOTH modes (order 10^2
  fires over a 300k stream, `latch: true` about half as often as `latch: false`) -- tune `delta` up for
  a quieter stream. This latch discipline is new in this cycle, so no released version was affected.
- **`SlidingCountMin.estimate(key, w)` and `total(w)` now fail CLOSED on an unset instance with a bad
  `w`.** The `w` validation ran AFTER the `mode === unset` early return, so an instance with no add
  yet returned a fail-OPEN `0` for `estimate(key, -1)` / `total(NaN)` while `estimateInto` (which
  validates `w` first) returned `NaN` -- the "each `out` slot is exactly what `estimate(keys[j], w)`
  returns" contract was false in that case. The `w` check now precedes the unset return in both
  methods, so an unset instance with a bad `w` returns `NaN` (a good/omitted `w` still returns `0`)
  and `estimate` / `total` / `estimateInto` agree slot-for-slot. For `estimate` this is a behavior
  fix (a previously fail-open bad-`w` query on an unset sketch now fails closed to `NaN`).
- **The `HeavyKeeper` / `SlidingHyperLogLog` / `SlidingCountMin` hash path no longer passes a boxable
  argument, so a large / negative key no longer boxes under inlining pressure -- and the fix keeps the
  hot-path throughput flat (F19).** The MurmurHash3 round /
  finalizer helpers (`hkRound` / `hkFinal` / `slRound` / `slFinal`) used to take the key's low 32-bit
  word `lo` (a ~16 B HeapNumber for any key with bit 31 set: `2^31 .. 2^32-1`, `2^53-1`, `-2^31`) and
  the running int32 hash state as CALL ARGUMENTS. When V8 left one `*Round` call site un-inlined --
  deterministically under `--no-turbo-inlining`, and flakily (measured 15-20 in 300 runs at
  concurrency 12) when Turbofan's cumulative inlining budget ran out under CPU contention -- each such
  large-key `addFrom` boxed 16-32 B/op in every window, breaking the advertised 0 B/op for large keys
  (`HeavyKeeper.addFrom` was the 1.6.0 sweep's High finding; the same pattern lived in the SHLL and
  SCM hot hashes). The fix (F19v2) HAND-INLINES the whole two-lane murmur -- every round + `fmix` --
  in register-resident int32 LOCALS directly in each hot body: `SlidingHyperLogLog` and
  `SlidingCountMin` keep NO `slRound` / `hkRound` sub-call at all, and `HeavyKeeper` runs the rounds
  inside the argument-free helpers `hkHash` / `hkMapHash` (key + seed via the `HK_KIN` `Float64Array`
  slots, the two lanes out via the `HK_HS` `Int32Array`; `hkPos(r, w)` passes only Smi-range ints,
  which never box). No hash word -- neither the key word `lo` nor the running state -- ever crosses an
  inner call boundary, so nothing boxes even on a 31-bit-Smi engine or under `--no-turbo-inlining`.
  Each lane's single `HK_HS` `Int32Array` store and the `| 0` / `Math.imul` `ToInt32` in the inlined
  bodies apply the SAME `ToInt32` as before, so every hash output,
  column position, top-k order and estimate is BIT-IDENTICAL to 1.7.0. This is PROVEN, not asserted:
  `SCMParity` now replays ~4096 DISTINCT large / negative keys through an UNSATURATED `d x w` sketch
  so each key's collision overestimate differs key to key (72 distinct probe values), pinning the
  column geometry -- a consistent column-shift mutant (`Math.imul(i + 1, HK_ODD)`) mismatches 549/600
  probes, and a MUST-FAIL control (a different seed) mismatches >= 400; `HKParity` adds a
  position-sensitive `_cnt` / `_fp` column-layout digest pinned to `HEAD`, so an `hkPos` row-salt
  mutant (`Math.imul(r + 1, HK_ODD)`) is caught where top-k / estimate alone stay bit-identical and
  miss it. A `--no-turbo-inlining` gate group (`noInlineLargeKey` in `test/perf/AllocMatrix.test.mjs`,
  driven through a new `runLane` node-flags parameter) reruns the large / negative-key `addFrom` lanes
  of all three members, fresh AND warmed, at `<= 0.5 B/op`; every flagged child echoes its
  `process.execArgv` and the gate FAILS CLOSED unless `--no-turbo-inlining` actually reached it (so the
  box repro can never silently not run), and the same group measures 16-32 B/op against the pre-fix
  file (teeth). No released version shipped this flake to a hot loop unconditionally -- it surfaced
  only under inlining pressure.
  - **Throughput correction (F19v2).** The first cut of F19 (F19v1) parked each murmur round in an
    `Int32Array` scratch (`HK_RS` / `SL_RS`) so the helpers took no argument at all. That killed the
    box, but V8 could not scalar-replace the per-round MEMORY ROUND-TRIP, and the allocation gates --
    which only see boxes -- were BLIND to the cost: those paths were 0 B/op the whole time while the
    hot bodies ran materially slower. Measured (bench: 2M `addFrom`, min of 5, large / negative keys,
    ns/op HEAD 1.7.0 vs F19v1 vs shipped F19v2): `SlidingCountMin` 27 -> 42 (+56%) -> 27 (flat);
    `SlidingHyperLogLog` 12.5 -> 18.4 (+47%) -> 13.5 (~+8%, at the noise floor); `HeavyKeeper`
    175 -> 201 (+15%) -> 178 (flat -- its hash is a small slice of `addFrom`). F19v2 reverts the
    round-trip to register-resident int32 locals (above), restoring HEAD throughput. To keep a future
    edit from silently reintroducing a hot-path round-trip, a new **throughput-regression guard**
    (`test/perf/HashThroughput.test.mjs`, wired into `test:perf:matrix` / `gates:red`) runs an
    in-process interleaved A/B: it times the shipped `HeavyKeeper` / `SlidingCountMin` /
    `SlidingHyperLogLog` `addFrom` against a FROZEN 1.7.0 baseline (`test/perf/HashThroughputRef.mjs`,
    the pre-F19v2 argument-passing murmur) -- same process, interleaved trials, median of N -- and
    fails RED if `median(shipped) / median(baseline) > 1.15` for any class. Teeth: pointed at the
    F19v1 copy it reads `SlidingCountMin` ~1.59x and `SlidingHyperLogLog` ~1.37x and goes RED.

### Known limitations

- **`SlidingHyperLogLog.count(w?)` is NOT 0 B/call.** count() keeps its Ertl multiplicity scratch (no
  ARRAY allocation), but it RETURNS a rounded double from the estimator: a stable **16 B/call** in the
  estimator tail (`slTau` / the k-loop / `slSigma` / `Math.round`) even under Turbofan, plus another
  **16 B** when the caller is not yet optimized (the integer-valued double is materialized at the call
  boundary) -- so **16-32 B per call**, measured on a non-degenerate sketch (thousands of distinct keys
  across the window). No library allocation gate measured count() before 1.8.0; a new
  `q_shll_count` lane (`test/perf/AllocMatrix.test.mjs`) now gates it in the documented band
  `[12, 40]` B/op. The 0-alloc `countInto` reader is planned for 1.9.0.
- **`DriftDetector` `latch: true` PH can box one ~16 B HeapNumber on a latched fire.** The effect is
  TIER-dependent: in V8's Maglev tier it measures ~**2 B/op** on a fire-heavy stream when a per-window
  collection re-tiers the hot loop; in steady Turbofan it measures **0** on realistic re-arming streams,
  where a fire-heavy never-re-arming stream reads ~2 scavenges per 625k fires (16 B/fire). `latch: false`,
  CUSUM and latched CUSUM read **0**. No bit-identical source change removes it (25+ variants measured).
  A new `dd_latch_ph_fireheavy` lane gates it at a documented ceiling `<= 4` B/op (a regression to a
  per-add box `>= 16` fails). A related latent concern: in the never-re-arming case the latched PH
  accumulators drift without bound (monotone `gP` / `mMin`), which would eventually reach Infinity and
  trip the `_guardFinite` throw. **RESOLVED in 1.10.0 (H2-3):** the argument-free `_clampGap(dir)` (V0)
  removes the box (fire-heavy latched-PH is 0 B/op fresh and warmed) and the gated re-centre (V3) bounds
  all four accumulators to `threshold * 2^20 + 30`.

## [1.7.0] - 2026-09-26

The H1 HARDENING release: fixes the 1.6.0 final-sweep audit findings (ROADMAP section 7; evidence in
RESEARCH.md 13 and ROADMAP 7.1) plus one finding QA added during the cycle (F18). NOT a pure append:
classes change in place. MINOR bump: two additive options (`ExponentialHistogram` `maxCount`,
`SlidingDDSketch` `range`), and behavior changes limited to invalid or out-of-range inputs (a bad query
value now returns NaN instead of throwing or returning 0; the `ADWIN` input bound narrows from ~1.34e154
to ~6.7e153; over-range weights and oversized constructor configs now throw) plus the documented window
and memory changes (`SlidingDDSketch` B+1 panes; `ExponentialHistogram` default pool sized from
`maxCount`). Gates: npm test 439/439; torture 0 B/op on all 49 lanes; test:perf 30/30 at
maxScavenges 0; test:perf:matrix 57 pass + 1 todo (F6: `SlidingCountMin.estimate` of a count >= 2^31
boxes 16 B/call; the `estimateInto` reader is 1.8.0).

### Added

- **`ExponentialHistogram` `maxCount` option + getter (F1, settle S3).** `new
  ExponentialHistogram(W, epsilon, { maxCount })` declares the window population the pool is
  GUARANTEED to hold, in EITHER mode (a floor: the exact ceiling is `k * (2^levels - 1)`
  elements, ~3-6x `maxCount`) -- a positive integer `<= 2^53-1`, default `2^32`, validated
  typeof-first before allocation. It sizes the fixed pool from the population, not from `W`:
  `levels = max(2, ceil(log2(maxCount/(k+1))) + 2)`, `capacity = (k+1) * levels + 2`. The
  pool is allocated before the mode locks, so a COUNT-mode instance also gets the default
  sizing -- the new default `capacity` / `levels` grow (e.g. `EH(1000, 0.01)`: 366 -> 1510
  buckets, 7 -> 29 levels, ~13 KB -> ~53 KB). Pass `maxCount: W` to keep the pre-1.7.0
  W-sized pool. A `maxCount` O(1) getter reports it.
- **`SlidingDDSketch` `range` option + `rangeMin` / `rangeMax` getters + span-based strict (F2,
  settle S8 -- lite-sketch DDSketch parity).** `new SlidingDDSketch(W, { range: [rmin, rmax] })`
  DERIVES strict from a declared band (finite `0 < rmin < rmax`, both inside the alpha indexable
  band, needing `<= SLD_MAX_BINS` bins) and pins the bin offset at `rangeKeyLo = ceil(ln(rmin) *
  mult)`, `nb = keyHi - keyLo + 1` bins -- never anchored to a first value, never slid, never
  collapsed; an out-of-band value throws "outside the declared strict range [rmin, rmax]" (a
  key-band check, so a value in `rmin`'s / `rmax`'s log bucket is accepted, identical to
  lite-sketch). Validated typeof-first BEFORE any allocation; a declared `range` with `strict:
  false` is a contradiction and throws. `strict: true` WITHOUT a `range` is now SPAN-BASED: a pane
  throws only when its occupied key span `[minKeyPop, maxKeyPop]` plus the new key would exceed
  `SLD_MAX_BINS`, otherwise it RE-ANCHORS the window losslessly (shift the occupied bins down on a
  key above the ceiling, up on a key below the floor) -- span-based, NOT a bottom anchor (which
  would only move the bug to falling values). `rangeMin` / `rangeMax` O(1) getters report the
  declared band (NaN when undeclared); `minIndexable` / `maxIndexable` are ALPHA-ONLY (identical
  across non-strict / strict / range). Non-strict behavior is byte-identical to 1.6.0 (proven by a
  200k-sample differential vector). The gap this closes was the missing `range` option -- the
  getters were already lite-sketch-shaped.

### Changed

- **One query contract across the whole package: a bad query VALUE returns NaN and never throws; a
  wrong container TYPE throws (F12).** A bad query value no longer throws on any member; only a wrong
  CONTAINER type (a programming error) does.
  - `SlidingDDSketch.quantile(q)` with `q` outside `[0, 1]` / NaN returns NaN; a bad sub-window `w`
    (`<= 0`, `> W`, NaN, non-number) returns NaN for BOTH `quantile` and `count` (NaN, not 0 -- null
    is not zero, an unrepresentable window is not an under-count). An empty window is unchanged
    (`quantile` -> NaN, `count()` -> 0).
  - `SlidingHyperLogLog.count(w)` with `w` outside `(0, W]` returns NaN (was a throw); `w` omitted
    queries the full window W; an empty window still reads 0.
  - `SlidingCountMin.estimate(key, w)` returns NaN on a bad sub-window `w` (was `0` -- a fail-open
    under-count on an upper-bound sketch) and NaN on an out-of-domain `key` (was `0`); an UNSEEN but
    VALID key is still `0` (an invalid key was never "seen 0 times", and `0` is indistinguishable
    from a legitimate miss). null is not zero.
  - `HeavyKeeper.estimate(key)` with a non-safe-integer key returns NaN (was a throw); an unseen but
    VALID key still reads 0.
  - A wrong CONTAINER type stays a programming error: an Into reader (`quantileInto`, `topKInto`,
    `sampleInto`, ...) with a non-`Float64Array` container or one too short still THROWS.

### Fixed

- **`ADWIN` range term `R` is now the CURRENT window's range, not a running global (F18).** The
  ADWIN2 Bernstein cut threshold has a range term `(2/3)(R/m)ln(2/deltaP)`. Pre-1.7.0 `R = max - min`
  was a running min/max over ALL raw `x` ever seen (`_min` / `_max`), which never shrank after a cut.
  After one large level shift `R` stayed inflated for the instance's life, so the range term dominated
  and ADWIN went DEAF to later shifts (it failed OPEN; lite-hud M6 uses ADWIN). Measured, ADWIN(.002),
  5 seeds, N(0,1) noise: a later `+1` shift was caught in **87-99** items with no prior jump, **921-988**
  after a prior jump of 100, and **NEVER within 20000** items after a prior jump of `1e4` / `1e6`; a
  straddling mixed bucket also survived, leaving the window variance at **~2.7e8** instead of `~1` after a
  `1e6` jump. FIX: two per-bucket `Float64Array` columns `_bmin` / `_bmax` (RAW `x`, offset-invariant) are
  set when a bucket opens and unioned on a merge, and `_scanCut` derives `R` from the live buckets'
  min/max EXCLUDING the globally-oldest bucket -- the range of the window ADWIN would RETAIN when it cuts
  there, so the lone straddle carrying a stale prior-regime value can no longer pin `R` at the old shift
  height. After the fix the later `+1` shift is caught in **96 / 82 / 113 / 78 / 83** items for J in
  `{100, 1e4, 1e6}` (within 1.5x + 10 of the **91 / 85 / 115 / 89 / 88** no-prior-jump baseline on the same
  seeds), and the settled `0 -> 1e6` window reads variance **~1.0** with `|mean - 1e6| < 0.01`. Stationary
  false alarms stay at 0 (offsets 0 / 1e9 / 1.7e12) and `<= delta` -- the (large, well-sampled) oldest
  bucket's exclusion barely moves `R` on a stationary stream. `_min` / `_max` are removed; no public getter
  exposed them. The ADWIN bucket pool grows by two `Float64Array(CAP)` columns, `2 x 8 x 386 = +6176 B`
  (13120 -> 19296 B; no `bytes` getter). `add` / `addFrom` stay 0 B/op (the range walk lives in the
  existing cut scan, not `add`'s hot body); stationary per-add cost +5.6%.
- **`ForwardDecay` / `DecayedReservoir` reject a subnormal `halfLife` that overflows `lambda` (F14).**
  A subnormal `halfLife` (e.g. `1e-320`) makes `lambda = ln2 / halfLife = Infinity`, which then poisons
  every weight to `NaN`: `DecayedReservoir` failed OPEN (NaN A-Res priorities, the sample froze at the
  first `k` values) and `ForwardDecay` failed only at query time with a misleading "value near Double.MAX
  was added" message. Both constructors now compute `lambda` and reject `!(lambda < Infinity)` (NaN-safe)
  with a tagged `[lite-adaptive]` RangeError BEFORE any allocation, naming `halfLife` and the smallest
  accepted value (`ln2 / Number.MAX_VALUE ~ 3.86e-309`). A normal `halfLife` that yields a finite lambda
  is accepted unchanged.
- **`ExponentialHistogram.sum()` finiteness stated; two class-comment texts corrected (F15).** `sum()` is
  an IEEE double: it overflows to `+Infinity` ONLY if the windowed value sum exceeds `Number.MAX_VALUE`
  (e.g. `add(0, 1e308)` twice). This is now DOCUMENTED as the honest IEEE result -- a query never throws on
  a bad VALUE (query contract, consistent with F12), and `+Infinity` is the representable answer;
  `count()`'s POPULATION bound is unaffected. A unit test pins the behavior. Also: the `DecayedReservoir`
  idle-gap class comment now matches the truth (a key CAN reach `-Infinity` across multiple back-to-back
  capped rebases -- harmless: order preserved, values finite, no NaN, per ADR 0011), and the `HeavyKeeper`
  class comment's estimate range is clarified to state HeavyKeeper NEVER overestimates (a reported count is
  in `[true - err, true]`, verified against ADR 0005 and the witness's worst-overestimate-0 gate).
- **`ADWIN` false alarms at large offsets (F9).** Variance was computed as `E[x^2] - mean^2`, which
  cancels catastrophically at a large absolute offset: 5 seeds x 20k stationary N(0,1) raised 0 false
  alarms at offset 0 but 98 at 1e9 and 144 at 1.7e12, and a +1 step went undetected on 2 of 5 seeds at
  1.7e12. The sums are now CENTRED on an offset `c` (the first value, re-centred on the window mean
  after every fired cut), so behavior is offset-invariant: 0 false alarms at 0 / 1e9 / 1.7e12, and the
  step-detection delay is IDENTICAL across offsets on every seed (witness gate). Columns and `bytes`
  unchanged; offset-0 results are statistically equivalent, not bit-identical (FP rounding). **Behavior change (frozen-core domain narrowing):** the
  accepted `|x|` bound drops from `sqrt(Number.MAX_VALUE)` (~1.34e154) to `sqrt(Number.MAX_VALUE) / 2`
  (~6.7e153), because a centred `|x - c|` can reach twice `|x|` and must still square finitely; a
  finite `x` in between now throws `[lite-adaptive]` (a byte-identical no-op) instead of being accepted.
- **`SlidingHyperLogLog.count()` is now PURE (F8).** It used to expire ring entries destructively, so
  `overflows` / `degraded` depended on how often you queried (6556 vs 6562 on one stream; 2694 vs 162
  in the audit). Expired heads are now dropped in `add` / `addFrom` before appending, an overflow is
  counted only for an IN-WINDOW drop, and `count()` skips expired entries without writing. A queried
  and a never-queried twin now end with identical `overflows` (17294 = 17294) and byte-identical rings;
  the estimate is bit-identical to 1.6.0 (differential vectors).

- **`HeavyKeeper.addFrom` boxed a large key / weight / the default seed (F3, hot path).** A
  safe-integer key or weight `>= 2^31`, or the default uint32 seed `0x9e3779b1`, crossed the
  internal `hkHash` / `hkPos` / `hkMapHash` / `_promote` / map call boundaries as arguments and
  boxed a ~16 B HeapNumber per op (a 31-bit-Smi V8 boxes any int32 outside +-2^30 held in a `let`
  or passed as an argument). The hot-path numeric inputs now live in fixed module scratch slots
  (a `Float64Array` for key / seed / map-key / estimate, an `Int32Array` for the hash lanes) that
  every helper reads directly, so no numeric value crosses a call boundary. `addFrom` is now
  0 B/op for EVERY safe-integer key and weight (large, negative, and the default seed) -- proven
  fresh AND warmed at maxScavenges 0. Output is bit-identical to 1.6.0 (a differential replays a
  200k-op stream and compares `topKInto` order + 512 estimate probes exactly, for the default seed
  and `seed: 0`). Plain `add(largeKey)` still boxes the key at its own public argument boundary --
  use `addFrom` (a packed `[key, weight]` Float64Array) for keys `>= 2^31`.
- **`ExponentialHistogram` explicit/count overflow -> `count()`/`sum()` = NaN (F1, High).**
  A stream denser than the old `W`-sized pool cascaded past the top level and wrote out of
  bounds on the typed columns (silently), orphaning buckets so queries returned NaN (e.g.
  `EH(1000, .01)` at 10 kHz went NaN mid-stream). `add` / `addFrom` now PRE-CHECK the pending
  insert with a read-only expiry scan and throw a tagged `[lite-adaptive]` RangeError (naming
  `maxCount` and the capacity) BEFORE any state write -- a BYTE-IDENTICAL no-op. The hot path
  adds one integer compare; the scan is a separate cold method. Under the default `maxCount`
  the dense 10 kHz / 70 s witness never goes NaN.
- **`ExponentialHistogram.sum()` did not hold `<= epsilon` (F17, doc).** Levels are sized by
  POPULATION, not value mass, so the `sum()` error is bounded ABSOLUTELY by
  `size(oldest straddling bucket) / 2` -- relative `<= epsilon` only for count or
  near-constant values. Heavy-tailed / spiky value streams can exceed epsilon (measured
  15.8% heavy tail, ~2504% spike at eps .1). The docs, d.ts, ADR 0002 and a new witness lane
  now state the true bound; `count()`'s `<= epsilon` bound is unchanged.
- **`SlidingDDSketch` under-counted the window edge -- ring now holds B+1 panes (F7, behavior
  change).** The ring stored only B panes, so it dropped the oldest (straddling) pane up to one pane
  width EARLY and `count()` under-reported the true count on 29410/29557 witness queries. The ring
  now holds B+1 panes (the `panes` option stays B, the user knob) and queries cover every live pane
  `paneEnd > now - W`, INCLUDING the straddling oldest pane. The covered span is therefore
  `[W, W + W/B]`: always the FULL window W, over-covered by at most one pane width W/B and NEVER
  under-covered. `count() >= true count in (now - W, now]` now holds on 100% of 29557 witness queries.
  `bytes` grows by one pane (default `panes: 32` -> 279712 -> 287949 B). Rotation stays bounded: a huge
  `now` jump clears at most B+1 panes.
- **`SlidingDDSketch.quantileInto(qs, out)` is now 0 B/call (F5, render path).** It boxed ~64 B/call
  by returning a double from `_walkInto`; the cut now lives in an instance `Float64Array` slot and
  `_walkInto` writes `out[j]` in place, so a render path is fully alloc-free. `quantile(q)` keeps ONE
  boxed return (16 B/call) -- use `quantileInto` on a hot render path.
- **`HeavyKeeper` single weight above `2^32-1` now throws (F10).** A single `add` / `addFrom` weight
  must be an integer in `[1, 2^32-1]`; above `2^32-1` it throws `[lite-adaptive] HeavyKeeper weight
  must be an integer in [1, 4294967295], got <w>` (a byte-identical no-op). In 1.6.0 an over-range
  single weight was stored UNCLAMPED into the `Uint32` cell and wrapped, so `add(7, 2^32)` then
  `estimate(7)` read `0` while `topK` reported `2^32`. An ACCUMULATED cell still SATURATES at
  `2^32-1` (unchanged) -- the two rules are distinct. This is parity with `SlidingCountMin`'s
  `[1, 2^32-1]` count domain.
- **Constructor memory caps -- a tagged `RangeError` BEFORE allocation (F11).** In 1.6.0 an oversized
  table aborted the PROCESS on an uncatchable V8 fatal (exit 133) or lazily over-committed multiple
  GB: `new HeavyKeeper(64, 2**30, 1)` and `new ExponentialHistogram(10, 1e-12)` crashed, and
  `new DecayedReservoir(2**31, 1)` reserved ~34 GB. Each ctor now checks a hard cell ceiling BEFORE
  allocation and throws a tagged `[lite-adaptive]` `RangeError` naming the cap: `HeavyKeeper` `d*w
  <= 2^27` cells (`HK_CELLS_CAP`, ~1 GB at 8 B/cell), `w <= 2^30` (`HK_W_MAX`), `k <= 2^24`
  (`HK_K_MAX`, ~256 MB at 16 B/slot); `ExponentialHistogram` bucket-pool `cap <= 2^22` buckets
  (`EH_CAP_MAX`, ~150 MB at 36 B/bucket -- which rejects an epsilon below ~3e-6 at the default
  `maxCount`); `DecayedReservoir` `k <= 2^24` (`DR_K_MAX`, ~256 MB at 16 B/slot).
- **Option-bag door is now prototype-safe with a did-you-mean hint (F13).** Every constructor (all 9)
  and both static factories (`HeavyKeeper.withAccuracy`, `SlidingCountMin.withAccuracy`) validate
  `options` through ONE shared door (R6: every door is the same door): `undefined` is OK; `null`, a
  non-object, an `Array`, or a typed array / `DataView` is a `TypeError`; an unknown OWN enumerable
  key is a `RangeError` with a Levenshtein `<= 2` did-you-mean hint for a known key (e.g. `{sede: 1}`
  -> `unknown option "sede" -- did you mean "seed"?`, `{maxcount: 1}` -> `"maxCount"`). The known-key
  sets are now null-proto, so inherited keys like `toString` / `constructor` are no longer accepted
  as options -- in 1.6.0 six classes used plain object-literal key sets and accepted them. Only OWN
  enumerable keys are validated; inherited enumerable keys are ignored (not part of the bag contract).

### Documentation

- **The query allocation rule is now stated (F6).** A query that RETURNS a fractional or large double
  boxes ONE ~16 B HeapNumber per call at a non-inlined call site; the `Into` / `forEach` readers are the
  0-alloc render path. Measured (steady state): `SlidingCountMin.estimate` of a windowed count `>= 2^31`
  boxes 16 B/call (the 1.8.0 `estimateInto` fixes it); `SlidingDDSketch.quantile` boxes 16 B/call (use
  `quantileInto`, 0 B/call); `ExponentialHistogram.sum()` and `HeavyKeeper.estimate` box only in the
  early JIT tier (steady 0). `llms.txt` previously claimed `SlidingCountMin.estimate` was 0-alloc -- that
  claim is corrected, and the one rule is added to `README.md` (allocation table + Design decisions) and
  `llms.txt`.
- **Docs / metadata sweep (F16).** The `package-lock.json` `version` fields now read the package version
  (were stale at `0.1.0`). The README Testing section now states the test counts (`npm test` 420,
  `test:perf` 30, `test:perf:matrix` 58) and mentions `gates:red`, `witness`, `torture`, and the
  `test/differential` parity suites. The ROADMAP milestone table and section 6.2 status words are updated
  from "planned" / "IN DEVELOPMENT" / "unscheduled" to SHIPPED with versions (M0-M4 -> 0.1.0-0.4.0, 1.0.0,
  and the post-1.0 members through 1.6.0), and section 7 (H1 hardening) is marked IN PROGRESS for 1.7.0.

## [1.6.0] - 2026-09-24

The fifth additive post-1.0 member (`DecayedReservoir`) -- a PURE APPEND. All eight prior classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`,
`DriftDetector`, `SlidingDDSketch`, `SlidingCountMin`) are BYTE-IDENTICAL; only the file header and the
`VERSION` const change. MINOR bump (new API, no break). This completes the confirmed post-1.0 roadmap.

### Added

- **`DecayedReservoir`** -- a zero-GC, recency-biased fixed-`k` SAMPLE of actual stream values
  (Efraimidis-Spirakis A-Res weighted reservoir over ForwardDecay weights; ADR 0011). An item's
  retention probability decays exponentially with its age (halves every `halfLife`), so the `k`
  retained values are always a decay-weighted sample of the recent stream -- the sampling complement
  to `ForwardDecay` (which gives decayed *aggregates* exactly). The caller reads the raw sample
  (`sampleInto` / `forEach`) and computes any statistic over it.
  - `new DecayedReservoir(k, halfLife, options?)` -- `k` a positive integer, `halfLife` a finite
    number > 0, `options.seed` a uint32 (default `0x9e3779b1`; `seed = 0` is a valid distinct seed,
    guarded as `undefined`, not falsy). Throws `[lite-adaptive]` typeof-first, before any allocation.
  - `add(now?, value?)` / the zero-box stride-2 `addFrom(buf, i)` (`[now, value]`) -- HOT, amortized
    0 B/op incl. the seeded xorshift32 draw, the min-forest sift, and the order-preserving landmark
    rebase. EXPLICIT mode (finite non-decreasing `now`) or COUNT mode (`add(undefined, value)`
    auto-tick); the mode locks at the first add. `value` is ANY finite real (signed OK; default 1). A
    mode switch, a non-finite / decreasing `now`, or a non-finite value is a byte-identical no-op -- it
    does NOT advance the PRNG or the landmark.
  - `sampleInto(buf)` (0-alloc copy of the retained values into a caller `Float64Array` of length
    `>= k`, returns the count) / `forEach(fn)` (alloc-free `fn(value)` iteration) / `clear()` /
    getters `k` / `halfLife` / `lambda` / `seed` / `size` / `mode` / `bytes`.
  - A-Res keys are computed in LOG SPACE (`log(u) * exp(-lambda*(t - L))`), so they underflow to 0
    gracefully instead of overflowing; the landmark rebase (at `DR_EXP_CAP`) is an order-preserving
    scalar transform, so it never disturbs the retained set and idle time needs no sweep. It is a
    SAMPLE, not a hard window, so -- like `ForwardDecay` -- it has NO `advance()`.
  - The recency-sample witness gates the empirical inclusion rate by item age against the
    `exp(-lambda*age)` expectation over many seeds; a no-decay (uniform) reservoir and a no-forest
    ("keep the first `k`") reservoir are both REJECTED by the witness. `add` / `addFrom` /
    `sampleInto` / `clear` are torture-gated at 0 B/op (incl. a rebase-heavy lane).

## [1.5.0] - 2026-09-24

The fourth additive post-1.0 member (`SlidingCountMin`), plus a shared fail-closed ctor guard applied
to both windowed-pane members. Six of the prior classes (`ExponentialHistogram`, `ADWIN`,
`ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`, `DriftDetector`) are BYTE-IDENTICAL; the new class
is appended after `SlidingDDSketch`, which itself changes only by the one-line ctor guard below (no
behavior change on any valid input). MINOR bump (new API + a fail-closed hardening, no break).

### Fixed

- **Subnormal-window fail-closed guard on both windowed-pane members** (`SlidingDDSketch` and the new
  `SlidingCountMin`). At an astronomically small window `W` (subnormal range, e.g. `Number.MIN_VALUE`),
  the derived per-pane width `W / panes` underflows to exactly `0`, which would make the pane-boundary
  arithmetic non-finite -- no pane ever "live", so `add` never throws yet a query silently reads empty
  for a value added on the same tick (a silent violation of the one-sided bound). The constructor now
  guards the derived pane width (`paneW > 0 && Number.isFinite(paneW)`) and throws `[lite-adaptive]` at
  construction, before any allocation -- consistent with the suite's fail-closed law. No valid,
  representable `W` is affected (a tiny `W` such as `1e-6` still constructs and works).

### Added

- **`SlidingCountMin` -- windowed per-label frequency** (Cormode-Muthukrishnan Count-Min Sketch over a
  B+1 pane ring; ADR 0010). Answers "how many times did key `k` occur in the LAST W?" in fixed memory
  -- the recency sibling of lite-sketch's cumulative `CountMinSketch`, for lite-hud's per-label rate
  panels. A ring of **B+1 panes** (default `panes` B = 32, so 33 panes), each a `d x w` `Uint32`
  counter grid aligned to absolute time (`pane = floor(now / (W/B))`). The live panes cover a span in
  `[W, W + W/B]` -- always the full window plus at most one extra pane -- and the partially-expired
  oldest pane is **KEPT, never dropped**, so the estimate stays a **one-sided upper bound**:
  `true(W) <= est <= true(W + W/B) + epsilon * N(W + W/B)`. Dropping it would under-count and silently
  break the Count-Min contract.
  - `new SlidingCountMin(W, { epsilon?, delta?, w?, d?, panes?, seed?, conservative? })` -- `W` a finite
    number `> 0` (a `now`-unit span in explicit mode, or items in count mode; **not capped** -- ms /
    epoch-time spans are fine). `epsilon` (default `0.01`) sizes the width `w`; `delta` (default `0.01`)
    sizes the depth `d`; or pass `w` (int `[1, 65536]`) / `d` (int `[1, 32]`) explicitly. `panes` an
    integer `[2, 1024]` (default 32). `seed` a Uint32 (default `0x9e3779b1`; `seed = 0` valid).
    `conservative` (default `true`) enables per-pane conservative update. Throws `[lite-adaptive]`
    typeof-first on a bad arg BEFORE any allocation.
  - `add(now, key, count = 1) -> this` -- HOT, amortized 0 B/op incl. the pane rotate + clear. EXPLICIT
    mode (finite, non-decreasing `now`) or COUNT mode via `add(undefined, key, count)`; the mode locks
    at the first add (a switch throws). `key` a SAFE INTEGER (a composite `channelIdx * 2^32 + tag`
    works, for lite-hud's ONE-shared-instance-across-channels use); `count` a positive integer,
    **saturating at `2^32-1`** (never wraps). Fail closed: a mode switch, a non-finite / decreasing
    `now`, or a non-safe-integer key / non-positive-integer count is a byte-identical no-op.
  - `addFrom(buf, i) -> this` -- HOT, 0 B/op ZERO-BOX entry: reads a packed stride-3 `[now, key, count]`
    from a `Float64Array` UNBOXED (EXPLICIT-time only). Same validation + body as `add`.
  - `advance(now) -> this` + `advanceFrom(buf, i) -> this` -- built in from the start (R11 idle-slide):
    move the reference time forward with NO increment, rotating out stale panes (bounded to B+1 clears),
    so an idle key's `estimate` slides to 0 instead of freezing. HOT, amortized 0 B/op, EXPLICIT-only,
    monotone.
  - `estimate(key, w?) -> number` -- COLD, `O(d * (B+1))`; sums the key's cell across the live panes per
    row THEN takes the min over rows (sum-then-min). Returns a **double** (a window sum can exceed
    `2^32`). **Never throws** -- returns 0 for an unseen / out-of-domain key or an empty window (parity
    with lite-sketch, so it can be swapped in). `w` an optional sub-window in `(0, W]`.
  - `clear() -> this`; getters `d` / `w` / `panes` / `W` / `seed` / `conservative` / `saturated` /
    `epsilon` / `delta` / `lastNow` / `mode` / `bytes`. `saturated` (the count of saturated increments)
    is the honesty flag, like `SlidingHyperLogLog`'s `degraded`.
  - DESIGN PARITY with lite-sketch `CountMinSketch` (inlined, never a dependency): the same two-lane
    seeded hash + row derivation, seed handling, `epsilon` / `delta` sizing, `2^32-1` saturation, and
    the `conservative` option. Counters are `Uint32Array` per pane; memory `(B+1) * d * w * 4 B`, fixed.
    Absolute pane alignment means two same-`(W, panes)` instances align cell-for-cell (forward-compat
    for a future `merge`).
  - WITNESSED (the honesty anchor, ADR 0010): the one-sided bound `true(W) <= est <= true(W + W/B) +
    epsilon * N` on 100% of the sweep + a churny key stream, plus an idle-slide-empties check. Negative
    controls REJECTED by the same gate: a DROP-OLDEST-PANE variant (under-counts, breaks the lower
    bound) and a MIN-THEN-SUM variant (mis-estimates). ADR 0010 records the B+1 / keep-oldest one-sided
    rationale and rejects the per-cell EH ("ECM-sketch", Papapetrou et al. VLDB 2012, ~6 MB) alternative.
- **`VERSION`** is now `'1.5.0'`.

## [1.4.0] - 2026-09-24

The R11 "idle streams must still slide" sweep. **NOT a pure append**: this ADDS methods to three
EXISTING classes. Every existing method + hot body of `ExponentialHistogram`, `SlidingHyperLogLog`,
and `SlidingDDSketch` (ctor, `add`, `addFrom`, `count` / `sum` / `query` / `quantile` /
`quantileInto`, `clear`, all getters) is BYTE-IDENTICAL; the only additions are the two new methods
per class (+ their cold throwers). The four other classes (`ADWIN`, `ForwardDecay`, `HeavyKeeper`,
`DriftDetector`) are BYTE-IDENTICAL. MINOR bump (new API, no break).

### Added

- **`advance(now)` + `advanceFrom(buf, i)` on the three TIME-windowed members** (ADR 0009). A windowed
  query anchored to the last applied time FREEZES while a stream is idle -- `count()` still shows the
  last burst an hour later. `advance(now)` moves the window's reference time forward to `now` WITHOUT
  adding a value, applying the same expiry / rotation `add` would, so a subsequent query reflects the
  window ending at `now` (an idle channel's readout empties instead of lying). Both are HOT, **0 B/op**;
  EXPLICIT-time only (a count-locked instance throws; the first `advance` locks EXPLICIT); monotone (a
  `now` below the last applied time throws `[lite-adaptive]` as a byte-identical no-op); chainable
  (return `this`). `advanceFrom(buf, i)` is the zero-box sibling (reads `now = buf[i]` unboxed for a
  fractional / epoch-ms `now`). Per member:
  - **`ExponentialHistogram.advance(now)`** -- expires buckets older than `now - W` (the expiry half of
    `add`, no bucket opened).
  - **`SlidingHyperLogLog.advance(now)`** -- clock-only (moves the reference time); `count(w?)` already
    lazily expires `stamp <= now - W` relative to it, so the ring is untouched and `overflows` /
    `degraded` are unaffected. O(1).
  - **`SlidingDDSketch.advance(now)`** -- rotates + clears panes as `now` passes their boundaries
    (bounded to `panes` clears), so the quantile / count reflects the window ending at `now`.
- **Excluded, by design (ADR 0009):** `ADWIN` and `DriftDetector` are ITEM-INDEXED (no clock), so
  `advance(now)` is meaningless; `ForwardDecay` already satisfies R11 the other sanctioned way -- its
  `count(now?)` / `sum(now?)` / `mean(now?)` / `rate(now?)` queries take an optional query time and
  stay pure, so no mutating `advance` is added.
- WITNESSED (the honesty anchor, ADR 0009): after a burst then an idle gap, `advance(lastNow + 2*W)`
  empties the window for all three members (`ExponentialHistogram` / `SlidingHyperLogLog` `count()` -> 0,
  `SlidingDDSketch` `count()` -> 0 and `quantile()` -> `NaN`), matching an oracle advanced the same way;
  and `advance(t)` then `add(t, v)` is state-equivalent to `add(t, v)` directly (per SoA column), with
  `advance` idempotent. A negative control -- an `advance` that moves the clock but SKIPS the expiry /
  rotation -- leaves the window frozen and is REJECTED by the same gate.
- **`VERSION`** is now `'1.4.0'`.

## [1.3.0] - 2026-09-24

The third additive post-1.0 member. **PURE APPEND**: the six prior classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`,
`DriftDetector`) are BYTE-IDENTICAL; only the file header and the `VERSION` const change above the
append point. MINOR bump (new API, no break).

### Added

- **`SlidingDDSketch` -- windowed relative-error quantiles** (Masson-Rim-Lee, "DDSketch", VLDB 2019,
  over a fixed-B pane ring; ADR 0008). Answers p50 / p99 / any quantile over the LAST W in fixed
  memory at DDSketch accuracy -- the recency sibling of lite-sketch's cumulative `DDSketch`, for
  lite-hud's M2 windowed percentiles. Window model A (fixed-B pane ring): `panes` preallocated
  DDSketch panes (default 32), each covering `W / panes` of the window; `add` writes the current
  pane, and crossing a pane boundary rotates to the next pane and clears it (a `fill(0)`, 0-alloc; a
  `now` jump of k pane-widths clears `min(k, panes)` panes, never loops unbounded). `quantile` /
  `quantileInto` / `count` merge the live panes into an INSTANCE-OWNED preallocated scratch (cold,
  0-alloc -- never allocated per query). The edge error is disclosed: the window is soft to within
  one pane width `W / panes` (~3% at the default 32), the price of a fixed-memory sliding window
  over an exact O(W) sort.
  - DESIGN PARITY with lite-sketch `DDSketch` (inlined, never a dependency -- the
    `SlidingHyperLogLog` precedent): the SAME mapping `gamma = (1 + alpha) / (1 - alpha)`,
    `key = ceil(log_gamma(v))`, the collapsing-lowest-bins default + a `strict` opt-in, and the
    getters `alpha` / `strict` / `minIndexable` / `maxIndexable` / `collapsed` -- so a consumer
    (lite-hud M2) pre-checks a value's indexable range EXACTLY as it does against lite-sketch. `alpha`
    defaults to `0.01` (1% relative error); `maxBins` per pane is 2048 (`SLD_MAX_BINS`, matching
    lite-sketch's `DD_MAX_BINS_DEFAULT`). Per-pane bin counts are `Uint32Array`, SATURATING at
    `2^32-1` (never wrap); the merge scratch sums panes in `Float64` so a merged window count stays
    exact past `2^32`.
  - `new SlidingDDSketch(W, { alpha?, strict?, panes? })` -- `W` a finite number `> 0` (a `now`-span
    in explicit mode, items in count mode) is the required positional (the `SlidingHyperLogLog`
    `(W, options)` convention; `alpha` is an option here, not the positional it is on lite-sketch
    `DDSketch`); `panes` an integer `>= 2` (default 32). Throws `[lite-adaptive]` typeof-first on a
    bad `W` / `alpha` / `strict` / `panes` / unknown option BEFORE any allocation.
  - `add(now, value) -> this` -- HOT, 0 B/op incl. the pane rotate + clear. EXPLICIT mode (a finite,
    non-decreasing `now`) or COUNT mode via `add(undefined, value)` (auto-tick); the mode LOCKS at
    the first add (a switch throws). Value domain + zero / `-0` / negative policy stated in the SAME
    words as lite-sketch `DDSketch`. Fail closed: a mode switch, a non-finite / decreasing `now`, an
    out-of-policy value, or a value whose bin key would exceed `SLD_KEY_MAX` (`1 << 30`) is a
    byte-identical no-op / throw.
  - `addFrom(buf, i) -> this` -- HOT, 0 B/op ZERO-BOX entry: `now = buf[i]`, `value = buf[i+1]` read
    UNBOXED from a packed `Float64Array` (EXPLICIT-time only). Same validation + body as `add`.
  - `quantile(q, w?) -> number` -- COLD; the windowed quantile for `q` in `[0, 1]` (outside throws),
    over the full `W` or an optional sub-window `w` in `(0, W]` (outside throws). Returns `NaN` on an
    empty window (never 0). `quantileInto(qs, out) -> number` packs several quantiles into a caller
    array, 0-alloc (the render path). `count(w?) -> number` is the windowed population (0 on empty).
  - `clear() -> this` -- 0-alloc reset (reuse the arrays; unlock the mode). Getters:
    `W` / `panes` / `alpha` / `strict` / `minIndexable` / `maxIndexable` / `collapsed` / `mode` /
    `lastNow` / `bytes`.
  - WITNESSED (the honesty anchor, ADR 0008): windowed quantile relative error `<= alpha` vs an
    EXACT windowed-sorted-array oracle on 100% of `>= 2000` queries across a `W` x `alpha` sweep, a
    distribution shift, and a post-burst edge; the edge error bounded by one pane width `W / panes`;
    empty = `NaN` with `count() === 0`. Negative controls REJECTED by the same gate: a NO-EXPIRY
    variant (counts stale out-of-window values) and a `panes = 1` variant (breaks the edge bound).
    ADR 0008 records the fixed-B pane-ring choice and the rejected alternatives -- an EH / DGIM of
    DDSketches (merge-on-add allocates, not 0 B/op) and Arasu-Manku true windowed quantiles
    (unbounded per-item state, not zero-GC) -- plus the pane-boundary collapse subtlety (each pane
    collapses its lowest bins independently, so the merged min-key can differ from a single sketch's;
    the edge bound is witnessed, not assumed).
- **`VERSION`** is now `'1.3.0'`.

## [1.2.0] - 2026-09-24

The second additive post-1.0 member. **PURE APPEND**: the five prior classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`, `SlidingHyperLogLog`) are
BYTE-IDENTICAL; only the file header and the `VERSION` const change above the append point.
MINOR bump (new API, no break).

### Added

- **`DriftDetector` -- scalar, O(1)-state streaming drift detection** (Page, "Continuous
  Inspection Schemes", Biometrika 1954; Mouss-Mouss-Linkens-Sellami, 2004; ADR 0007). A single
  class over a real-valued signal, selected by a mode const whose REFERENCE is load-bearing --
  `DRIFT_PH` (Page-Hinkley: cumulative deviation of x from the ONLINE running mean, two-sided;
  adaptive) or `DRIFT_CUSUM` (two-sided CUSUM: two accumulators `gP` / `gN`, each floored at 0,
  deviating from a FIXED `target` mu0; classic SPC). The distinct references are deliberate: under
  a shared running-mean reference the two rules collapse to the identical reflected-random-walk
  statistic (CUSUM's `max(0, cumsum)` IS `cumsum` minus its running min, which is what PH computes),
  so PH self-references the online mean while CUSUM references a fixed mu0 -- they genuinely diverge
  (e.g. on a slow ramp PH stays quiet while CUSUM fires continuously). `add(x) -> boolean` updates a
  running mean (Welford), runs the one mode branch, and returns `true` EXACTLY on the detecting item,
  RESETTING the accumulators + running mean so the NEXT shift is caught -- **0 B/op**. It is the
  item-based, scalar, fixed-scalar-state complement to `ADWIN`'s adaptive window: no pool (pure
  scalars, like `ForwardDecay`), no window. Constructor
  `new DriftDetector(mode, { delta?, threshold?, target? })` -- `delta` the magnitude allowance (PH)
  / slack (CUSUM), a finite number in `[0, 1e150]` (default `0.005`; `delta = 0` is a valid setting,
  guarded as `undefined`, not falsy); `threshold` the decision level (PH lambda / CUSUM decision
  interval), a finite number `> 0` (default `50`, tune to the signal scale); `target` the FIXED
  in-control mean mu0 the CUSUM test deviates from, a finite number of any sign, `|target| <= 1e150`
  (`target = 0` valid) -- **REQUIRED for `DRIFT_CUSUM`, FORBIDDEN for `DRIFT_PH`** (a mismatch throws,
  never a silent ignore). `add(x)` accepts a finite real with `|x| <= 1e150` (`DD_X_MAX`, so the
  accumulators cannot silently overflow to a non-finite value -- the `ADWIN` finite-overflow
  lesson). Getters `mode`, `delta`, `threshold`, `target` (the fixed CUSUM mu0; `undefined` for PH),
  `count` (items seen since the last reset), `mean`, `statistic` (the current test statistic; crosses
  `threshold` exactly when `add` fires); `mean` / `statistic` throw `[lite-adaptive]` fail-closed on
  a non-finite accumulator; getters return `0` on empty. Fail closed typeof-first on a bad `mode` /
  `delta` / `threshold` / `target` / option / `x` (a byte-identical no-op). Proven by the torture
  gate (add PH + add CUSUM + addFrom + clear at 0 B/op) and the change-response witness (latency per
  shift magnitude both modes + bounded stationary false-alarm + transient reset discipline + a
  PH-vs-CUSUM mode-divergence gate, plus huge-threshold and no-reset negative controls rejected).
- **`DriftDetector.addFrom(buf, i)`** -- the zero-box hot entry: `x = buf[i]` read UNBOXED from a
  caller-owned `Float64Array` (a fractional `x` boxes as a plain argument at a non-inlined call
  boundary; `addFrom` avoids it -- torture-gated 0 B/op on a fractional drifting stream).
- **`DRIFT_PH` / `DRIFT_CUSUM`** -- the two mode consts (numeric named exports, `0` / `1`).
- **`DriftDetector.target`** -- the getter for the fixed CUSUM in-control mean mu0 (`undefined`
  for PH).

### Note

- **DDM / EDDM are deliberately deferred.** They consume a Bernoulli ERROR-BIT stream (a
  classifier's 0/1 correctness) and emit a TRI-STATE (stable / warning / drift) output -- a
  different contract from a real-valued `add(x) -> boolean`. They belong in a separate future
  member, not in `DriftDetector` (ADR 0007 records the reasoning).

### Changed

- `VERSION` -> `1.2.0` (package.json / `Adaptive.js` / llms.txt trinity); the file header documents
  the six-member roster.

## [1.1.0] - 2026-09-24

The first additive post-1.0 member. **PURE APPEND**: the four frozen core classes
(`ExponentialHistogram`, `ADWIN`, `ForwardDecay`, `HeavyKeeper`) are BYTE-IDENTICAL; only the
file header and the `VERSION` const change above the append point. MINOR bump (new API, no break).

### Added

- **`SlidingHyperLogLog` -- windowed DISTINCT-count** (Chabchoub-Hebrail, 2010; ADR 0006). How
  many DISTINCT keys arrived in the LAST W, in FIXED preallocated space at HyperLogLog accuracy --
  the RECENCY sibling of lite-sketch's cumulative HyperLogLog. An `m = 2^p` register bank where
  each register keeps a small FIXED LFPM ring (List of Future Possible Maxima) of
  `(timestamp, rho)` entries -- a per-register monotonic deque. `add(now, key)` / the zero-box
  `addFrom(buf, i)` derive register + rho from an inline two-lane hash, drop dominated tail
  entries, and append (0 B/op incl. the windowed eviction); a full ring drops its oldest entry and
  bumps `overflows` (`degraded` -- the honest degradation signal). `count(w?)` lazily expires
  `stamp <= now - W`, takes each register's live-max rho, and runs Ertl's improved estimator
  (design-parity with lite-sketch, inline); standard error `1.04 / sqrt(m)`, guaranteed while not
  degraded; `w` is an optional sub-window in `(0, W]`. Constructor `new SlidingHyperLogLog(W,
  { p?, ringCap?, seed? })`; a caller-supplied monotone `now` or count mode; getters `W`, `p`, `m`,
  `ringCap`, `seed`, `standardError`, `lastNow`, `mode`, `overflows`, `degraded`, `bytes`. Fail
  closed typeof-first on every bad ctor arg / key / now / sub-window (a byte-identical no-op).
  Fully deterministic (no PRNG). Proven by the torture gate (add + addFrom + clear at 0 B/op) and
  the windowed-distinct witness (3-sigma vs an exact Set oracle, `degraded === false`, plus
  no-expiry and no-dominated-drop negative controls rejected).

## [1.0.0] - 2026-09-24

The **API-FREEZE** milestone. The four-member core -- `ExponentialHistogram`, `ADWIN`,
`ForwardDecay`, `HeavyKeeper` -- is declared STABLE: signatures, options, and valid-input
behavior are frozen under 1.x. API frozen: four-member core stable (additive post-1.0
members remain possible; the core does not break). No new member and no hot-path byte change;
this release only tightens three previously-invalid-input paths to fail closed (all cold,
0 B/op) and corrects a doc contract. Prior VALID calls are byte-for-byte behaviorally identical.

### Changed

- **API declared stable at 1.0.0.** The four-member core is frozen; the package follows
  semantic versioning from here.

### Fixed

- **`ForwardDecay` fail-closed empty query.** `count(now)` / `sum(now)` / `mean(now)` /
  `rate(now)` now validate the query-time argument (finite number `>= the last add time`)
  BEFORE the empty-summary early exit, so an invalid `now` (negative, `NaN`, `Infinity`,
  non-number) on an EMPTY summary throws `[lite-adaptive]` instead of silently returning `0`.
  Valid use is unchanged: `count()` (no arg) and `count(<valid finite now>)` on an empty
  summary still return `0`. Cold path, 0 B/op.
- **`HeavyKeeper.estimate(key)` fail-closed key.** A non-safe-integer key now throws
  `[lite-adaptive]` (the same guard `add` applies) instead of silently returning `0`. An
  unseen but VALID key still reads `0`. Cold path.
- **`HeavyKeeper.topKInto(buf)` buffer guard.** `buf` must be a `Float64Array` of length
  `>= 2*k`; a too-small or non-`Float64Array` buffer now throws `[lite-adaptive]` instead of
  silently truncating the top-k. Cold throw before any write, 0 B/op on the success path.

### Documentation

- **`topKInto` contract corrected.** `topKInto(buf)` packs the current top-k as
  `[key, estimate]` PAIRS (2 `Float64` slots per entry) and returns the ENTRY COUNT; `buf`
  must be a `Float64Array` of length `>= 2*k` (a `Float64Array` is required -- estimates and
  large u32 keys need it). Fixed in `llms.txt`, `Adaptive.d.ts`, and `README.md` (the earlier
  "top-k keys / Uint32Array" wording was wrong).

## [0.4.0] - 2026-09-23

The fourth and FINAL member -- **HeavyKeeper** (Gong et al., USENIX ATC 2018): decayed /
windowed heavy hitters (the top-k keys dominating the stream RIGHT NOW). Completes the
four-member roster; 1.0.0 (the API freeze) is next. Pure append: `ExponentialHistogram` and
`ForwardDecay` are byte-identical, and `ADWIN`'s `add(x)` hot body is unchanged (it gains an
additive `addFrom`); only the file header and `VERSION` change otherwise.

### Added

- **`HeavyKeeper`** -- a decayed top-k over a `d x w` table of `(fingerprint, count)` cells
  (SoA `Uint32Array` columns) plus an intrusive top-k min-forest (design-parity with lite-o1
  `FreqO1`, never a dependency). `add(key, weight = 1)` hashes the key to `d` cells via an
  inline two-lane hash; a matching fingerprint adds the weight, a colliding one is decayed
  with probability `b^(-count)` (a seeded xorshift32 draw) and evicted at count 0 -- so cold
  keys erode and the live top-k tracks the CURRENT concept. Amortized O(1), **0 B/op including
  the decay draw and the forest sift**. `estimate(key)` is the max matching cell (0, never
  throws, for an unseen key); `forEach(fn)` iterates the current top-k allocation-free (the
  render path); `topKInto(buf)` fills a caller buffer 0-alloc; `topK()` is a COLD convenience
  that may allocate. Weight is a positive integer (rank by count, or by total time / bytes /
  any additive weight). Far lower error than Space-Saving on skewed, evolving streams.
- **`HeavyKeeper.addFrom(buf, i)`** -- the zero-box hot entry: `key = buf[i]`,
  `weight = buf[i+1]` read UNBOXED from a caller-owned `Float64Array`. A large `u32` tag id
  (>= 2^31) passed as a plain argument boxes into a ~16 B HeapNumber at a non-inlined call
  boundary; `addFrom` avoids it (torture-gated 0 B/op on keys near 2^31 / 2^32 - 1).
- **`ADWIN.addFrom(buf, i)`** -- a zero-box sibling of `ADWIN.add(x)` (reads `x = buf[i]`
  unboxed, returns the same boolean drift flag). ADWIN 0.2.0 had only `add(x)`, which boxes a
  fractional `x` at the peer boundary; this lands before the 1.0.0 freeze so the drift member's
  surface is complete. `ADWIN.add(x)` is byte-identical.
- **The top-k witness** (`test/witness.mjs`) -- the honesty anchor for HeavyKeeper: 100% recall
  of the true current top-k above `N/k` vs an exact `Map` oracle (weighted and unit streams),
  a bounded overestimate (each reported total in `[true - ~N/w, true]`, never over the truth),
  and the marquee claim -- measured mean rel-error over the true top-k of **0.001% vs a faithful
  Space-Saving baseline's 36.75%** (Metwally et al. Stream-Summary, hand-rolled inline and cited,
  not a strawman) on a Zipfian (`s = 1.1`) + DRIFTING stream. Negative controls the same gate
  rejects: a frozen-forest variant (recall 0%) and a decay-disabled variant (`b` huge; recall
  40% on drift).

### Changed

- `VERSION` -> `0.4.0` (package.json / `Adaptive.js` / llms.txt trinity); the file header
  documents the complete four-member roster.

## [0.3.0] - 2026-09-23

The third member -- **ForwardDecay** (Cormode-Shkapenyuk-Srivastava-Xu, ICDE 2009):
the TIME-DECAY axis (recent weighs more), the complement to the EH hard window and the
ADWIN adaptive window. The `ADWIN` class is byte-identical; `ExponentialHistogram` gains
an additive zero-box `addFrom(buf, i)` entry (its `add()` hot body is unchanged); only
the file header and `VERSION` change otherwise.

### Added

- **`ForwardDecay`** -- a zero-GC, O(1)-space time-decayed COUNT / SUM / MEAN / RATE.
  It weights each item at time `t` by `g(t - L)` measured FORWARD from a landmark `L`
  (exponential decay `g(x) = exp(lambda * x)`, `lambda = ln2 / halfLife`), maintaining
  two scalar accumulators -- `C` (decayed weights) and `Sv` (decayed weighted values) --
  incrementally. `add(now, value)` is amortized O(1), **0 B/op including the landmark
  rebase**: when the forward weight's exponent would exceed `FD_EXP_CAP = 40`, the
  landmark is advanced by rescaling `C` and `Sv` by a single constant factor (EXACT
  modulo floating point), which keeps the accumulator finite for any physically reachable
  stream (overflow would require ~7.6e290 weighted terms since a rebase). For the
  pathological tail -- a single value within a factor of `exp(40)` of `Double.MAX` --
  the cold query guard fails **closed**: the queries throw `[lite-adaptive]` on a
  non-finite accumulator rather than returning `Infinity`. `count(now?)` / `sum(now?)` /
  `mean(now?)` / `rate(now?)` are cold, O(1), evaluated at an optional query time
  `now >= lastAddNow` (decayed values keep changing as time passes); `mean` is
  landmark-invariant and EXACT.
  Mirrors EH's time model (explicit monotone `now` + a count-mode auto-tick, mode locks
  at the first add). Unlike EH it accepts ANY finite real value (signed included) -- `C`
  and `Sv` are separate, so a signed value gives a proper decayed weighted mean without
  corrupting the decayed count. Fail closed: a bad `halfLife` / option throws before
  allocation, a mode switch / non-finite or decreasing `now` / non-finite value throws
  `[lite-adaptive]` (byte-identical no-op), a query `now` before the last add throws;
  queries never throw on an empty detector (return 0). `rate() = count * lambda` is
  documented as a DEFINITION (decayed events per unit time), not a statistical bound.
  See [`decisions/0004`](./decisions/0004-forward-decay.md).
- **`addFrom(buf, i)`** -- a zero-box hot entry on **`ExponentialHistogram`** and
  **`ForwardDecay`** that reads `now = buf[i]` and `value = buf[i+1]` UNBOXED from a
  caller-owned PACKED `[now, value]` `Float64Array` (a batch steps `i` by 2), then runs the
  IDENTICAL accumulate (merge cascade / expire for EH, the landmark rebase for FD) as
  `add(now, value)`. It unblocks a caller whose `now` AND `value` are both FRACTIONAL doubles
  (e.g. lite-hud's time-window sum/mean/rate, where `now` is a fractional record time the
  caller computes itself): `add(now, value)` boxes each argument into a ~16 B HeapNumber at a
  non-inlined peer call boundary, whereas `addFrom` stays **0 B/op** (torture-gated on both
  members with fractional inputs). EXPLICIT-time only (it always carries a `now`): a
  count-locked instance throws, and the first `addFrom` locks EXPLICIT mode (setting FD's
  landmark). Same fail-closed validation, throws, and byte-identical-no-op-on-reject as
  `add`; a non-`Float64Array` `buf` or a non-integer / out-of-range `i` (needs
  `i + 1 < buf.length`) throws `[lite-adaptive]` typeof-first. EH's `add()` hot body is
  unchanged (the accumulate body is duplicated into `addFrom`, not shared, to avoid a boxing
  call boundary). Same idiom as lite-sketch's `DDSketch.addFrom(buf, i)` (N7).
- **The exact-aggregate witness** (`test/witness.mjs`) -- the honesty anchor unique to
  the decay member: a brute-force oracle stores every `(t, value)` and recomputes the
  decayed aggregate directly at each query, and the gate asserts the incrementally
  maintained result matches it to `<= 1e-9` relative error on every query across a
  `halfLife x stream-shape` sweep (worst observed `6.35e-14` over 5382 queries) -- with
  negative controls (a rebase that omits the `C, Sv` rescale; a detector that never
  rebases and overflows to `Infinity`) that the same gate rejects.

### Changed

- `VERSION` -> `0.3.0` (package.json / `Adaptive.js` / llms.txt trinity); the file
  header documents the three-member roster.

### Fixed

- **llms.txt** now documents all three members: the `ADWIN` export bullet and its API
  detail block were absent at 0.2.0 (the shipped Exports section listed only
  `ExponentialHistogram` + `VERSION`); both are added, alongside the new `ForwardDecay`
  export bullet and API section.

## [0.2.0] - 2026-09-23

The second member -- the marquee one: **ADWIN** (Bifet-Gavalda, SDM 2007), concept-drift
detection with a data-driven adaptive window. Pure append: the `ExponentialHistogram`
class and the M1 substrate are byte-identical; only the file header and `VERSION` change.

### Added

- **`ADWIN`** -- an item-indexed drift detector over its own variance-carrying
  `(sum, sumSq, count)` bucket columns (design-parity with the EH pool, a separate fixed
  pool). `add(x) -> boolean` appends a value, compresses buckets (at most 5 per level),
  scans every bucket-boundary split for a statistically significant mean difference with
  the **ADWIN2 variance-aware bound** at confidence `delta`, and on a detected cut DROPS
  the older sub-window (the adaptive shrink) -- returning `true` on the detecting item.
  Amortized O(1), **0 B/op including the cut-scan and the shrink**. The window GROWS while
  the stream is stable and SHRINKS to the new concept on a change; `mean` / `variance` /
  `width` getters report the current adaptive window. Accepts any finite real; the bound's
  range tracks the running observed `[min, max]`. Fail closed: a bad `delta` throws before
  allocation, a non-finite `x` is a byte-identical no-op, queries never throw. See
  [`decisions/0003`](./decisions/0003-adwin.md).
- **The change-response witness** (`test/witness.mjs`) -- the honesty anchor unique to the
  drift members: against an injected changepoint it gates the stationary false-alarm rate
  `<= delta`, a detection latency that scales with shift magnitude, ~0 missed detections on
  a large shift, and adapted-window correctness -- with negative controls (a bound-disabled
  detector must false-alarm; a no-shrink detector must fail to adapt) that are rejected by
  the same gate.

### Changed

- `VERSION` -> `0.2.0` (package.json / `Adaptive.js` / llms.txt trinity); the file header
  documents the two-member roster.

## [0.1.0] - 2026-09-23

The first release -- the new package scaffold, the shared time-source + fixed
bucket-pool substrate (ADR 0001), and the reference member.

### Added

- **`ExponentialHistogram`** -- the reference member: sliding-window COUNT / SUM over
  the last W in FIXED memory (Datar-Gionis-Indyk-Motwani, SODA 2002). A preallocated
  pool of `(timestamp, size)` buckets grouped by level; `add` opens a level-0 bucket,
  runs the amortized merge cascade (`k = ceil(1/(2*epsilon)) + 1` buckets per level),
  and expires the window edge -- 0 B/op INCLUDING the reshaping. `count()` / `sum()` /
  `query()` return the windowed estimate within a HARD relative error `<= epsilon`
  (the oldest straddling bucket is half-corrected only when it actually straddles, so
  a not-yet-full window is EXACT). DGIM (the 0/1 count stream) is the `value = 1`
  special case.
- **The time source** -- a caller-supplied MONOTONE `now` (`add(now)` /
  `add(now, value)`); the member never reads the wall clock. A COUNT-MODE convenience
  auto-ticks when `now` is omitted (`add()`). The mode LOCKS at the first add.
- **The fixed bucket-pool substrate** -- a Struct-of-Arrays (Float64 timestamp /
  start / size, Int32 level linkage + free-list) sized to
  `CAP = (k+1) * (ceil(log2(W/(k+1))) + 2) + 2` buckets; no per-op allocation.
- **Fail-closed construction + hot path** -- a bad `W` / `epsilon` / option throws
  `[lite-adaptive]` before allocation; `add` rejects a mode switch, a non-finite /
  decreasing `now`, or a non-positive value (byte-identical no-op); queries never throw.
- **The gate chassis** -- `test/witness.mjs` (windowed error `<= epsilon` across the
  `W x epsilon` sweep + a shifting stream + a rejected broken-EH negative control),
  `test/torture.mjs` (0 B/op incl. merge/expire, gc major 0, retention 0),
  `test/perf/PerfGate.test.mjs` (flat throughput + a must-allocate control), the
  behavioral / fail-closed `node:test` suite, and the ambient type surface.
- ADR 0001 (the time source + bucket pool) and ADR 0002 (ExponentialHistogram).
