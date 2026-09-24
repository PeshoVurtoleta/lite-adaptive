# ADR 0009 -- advance() / advanceFrom() (the R11 idle-slide sweep)

Status: ACCEPTED (2026-09-24). A NON-breaking method ADD (MINOR 1.4.0). PURE ADDITION: every
existing method + hot body of the three touched classes (ExponentialHistogram, SlidingHyperLogLog,
SlidingDDSketch) stays BYTE-IDENTICAL; the four untouched classes (ADWIN, ForwardDecay, HeavyKeeper,
DriftDetector) stay BYTE-IDENTICAL; only the file header + the `VERSION` const change, plus the two
new methods (`advance` / `advanceFrom`) and their cold throwers appended inside each of the three
touched classes.

## Context -- R11: a sliding window must slide even with NO data

Every TIME-windowed member in this family expires stale state ON an `add` / `addFrom`: the expiry
sweep (EH), the lazy ring drop (SlidingHyperLogLog), the pane rotate-and-clear (SlidingDDSketch)
all run as a side effect of ingesting a value. This is correct while data keeps arriving, but it
leaves a hole: an IDLE stream (a channel that goes quiet) reports a STALE window. `count()` /
`sum()` / `quantile()` keep returning values from the last-seen second long after the window should
have drained, because nothing has moved the reference clock forward. A monitoring caller polling a
quiet channel sees a frozen last-known-good number, not the honest "the window is now empty".

R11 (the roadmap requirement) closes this: the caller must be able to advance the window's reference
time WITHOUT inserting a value, so an idle stream slides to empty. v1.4.0 adds `advance(now)` and
its zero-box sibling `advanceFrom(buf, i)` to the three time-windowed members.

## Decision -- advance() moves the clock + applies expiry, inserts NO value

`advance(now) -> this` resolves + locks the mode and the monotone guard exactly as `add` does, then
applies the SAME expiry / rotation an `add` would, but opens / writes NOTHING. Queries stay PURE
(R7: `count` / `sum` / `quantile` / `quantileInto` never mutate) -- `advance` is the ONLY operation
that moves the clock without a value. This keeps the mutation surface explicit: a caller that never
calls `advance` gets exactly the pre-1.4.0 behavior, byte-for-byte.

### Per-member body (WHY each differs)

- **ExponentialHistogram.advance(now)**: runs `add()`'s expire loop VERBATIM (drop every bucket
  with `timestamp <= now - W`, oldest first, updating maxLevel), but opens NO level-0 bucket and
  runs NO merge cascade. An idle EH forgets exactly at the window edge; `count()` / `sum()` slide
  to 0. 0 B/op -- the loop is the same preallocated-column index manipulation as `add`.

- **SlidingHyperLogLog.advance(now)**: CLOCK-ONLY -- set `_now` / `_lastNow` and touch NOTHING
  else. `count()` ALREADY lazily expires `stamp <= now - W` off `_now` at query time, so a pure
  clock bump is sufficient for an idle stream to slide to 0. Eager expiry here would be WRONG: the
  ring's `overflows` / `degraded` degradation signal accounts for capacity pressure from real adds;
  evicting entries during an idle slide (entries that, as far as capacity accounting is concerned,
  never happened) would corrupt that honest-degradation flag. O(1), 0 B/op. Confirmed: `count()`
  reads correctly after `advance()` with no intervening `add`.

- **SlidingDDSketch.advance(now)**: set `_now = t`, then `if (t >= paneEnd[cur]) this._advance(t)`
  to rotate + clear stale panes (the PRIVATE `_advance` that `add` already calls -- the new PUBLIC
  method is `advance`, a distinct name). An UNSET instance locks EXPLICIT and anchors the pane ring
  around `now` via the existing `_anchor` path (mirroring `add`'s first-add branch). Bounded (<=
  panes clears), 0 B/op. An idle sketch slides to `count() === 0` and `quantile(q)` NaN.

## The mode / unset rule (parity with addFrom)

`advance` / `advanceFrom` are EXPLICIT-time ONLY -- identical to `addFrom`. A COUNT-locked instance
THROWS (advancing a logical item-tick has no meaning; COUNT mode auto-ticks per add). An UNSET
instance LOCKS EXPLICIT and sets the reference time (and anchors, for SlidingDDSketch). Monotone:
`now` must be finite and `>= lastNow`; a decrease throws. `advanceFrom(buf, i)` reads `now = buf[i]`
UNBOXED (needs `i < buf.length` -- ONE scalar, unlike addFrom's `i + 1 < buf.length` pair) and
otherwise shares the mode / monotone / body of `advance(now)`; a non-Float64Array `buf`, an
out-of-range `i`, or a NaN at `buf[i]` throws `[lite-adaptive]` typeof-first.

## The byte-identical no-op discipline

A REJECTED advance (bad mode / non-finite / decreasing `now` / bad buffer) is a BYTE-IDENTICAL
no-op: nothing is expired, the mode is not locked, the monotone guard does not advance -- matching
each member's `add` reject ordering (validation before any state write). There is NO strict-collapse
exception here (that add-time subtlety only exists because add WRITES a value; advance writes none),
so the no-op is total. New cold throwers per touched class -- `_badAdvanceMode` / `_badAdvanceNow` /
`_badAdvanceMonotone` / `_badAdvanceBuf` -- carry advance-specific messages (they do not reuse the
add throwers, whose messages say "add", to keep the diagnostic honest); the existing add throwers
are untouched.

## EXCLUDED members (WHY)

- **ForwardDecay**: EXCLUDED (user-confirmed). It already satisfies R11 via its existing `now?`
  query args (`count(now?)` / `sum(now?)` / `mean(now?)` / `rate(now?)`): the decay weight of every
  element is computed AT QUERY TIME relative to `now`, so an idle ForwardDecay already fades
  correctly with no advance needed -- there is no stored-window state to sweep. Adding `advance`
  would be redundant surface.
- **ADWIN, HeavyKeeper, DriftDetector**: EXCLUDED. They are ITEM-indexed, not time-windowed. ADWIN's
  window is data-driven (measured in items, cut by the ADWIN2 test); HeavyKeeper decays per add;
  DriftDetector is a scalar O(1) test statistic. None has a `now` axis to advance -- there is no
  idle-slide semantics to give them.

## Consistency invariants (WITNESSED, not assumed)

`test/witness.mjs` gates an idle-slide lane and a state-equivalence lane:

- **Idle-slide**: burst 10000 adds, then `advance(lastNow + 2*W)` -> EH `count() === 0`,
  SlidingHyperLogLog `count() === 0`, SlidingDDSketch `count() === 0 && Number.isNaN(quantile(0.5))`.
- **State equivalence** (>= 5000 random `(t, v)`): `advance(t); add(t, v)` deep-equals `add(t, v)`
  directly on EVERY SoA column -- advance followed by an add lands in the identical state as the add
  alone (advance only moves the clock the add would have moved anyway). And `advance(t); advance(t)`
  is IDEMPOTENT.
- **Negative controls REJECTED by the same gate** (each targets the LOAD-BEARING part of its
  member's advance): EH.count() sums the LIVE buckets and does NOT self-filter by `now`, so the
  load-bearing part for EH is the EXPIRE loop -- a clock-only `EHNoExpire` (moves the clock, skips
  the expire) leaves every bucket in place -> count frozen -> REJECTED. SlidingHyperLogLog.count()
  and SlidingDDSketch.count() self-filter by `_now` (an entry / pane with `paneEnd <= _now - W` is
  dropped / ignored at query time), so moving the clock alone already empties them -- the
  load-bearing part there is ADVANCING THE CLOCK; a frozen-clock variant (`SHLLFrozen` / `SDSFrozen`,
  an advance that never updates `_now`) leaves the window frozen -> REJECTED. All three prove the
  real advance body is load-bearing, not decoration.

The torture gate proves `advance` / `advanceFrom` are each 0 B/op with `gc major = 0` on all three
members, that the existing `add` lanes stay 0 B/op (unchanged hot bodies), and a
construct->advance->clear retention lane (bytes constant, baseline restored).

## Space + the honesty anchor

SPACE: unchanged -- `advance` allocates nothing and adds no field. This member closes the idle-slide
gap on the recency axis; the three time-windowed summaries now report an honest window whether or not
data is flowing. Further windowed members remain possible post-1.4, each a pure append that keeps the
frozen classes byte-identical.
