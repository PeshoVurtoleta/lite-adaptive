# 0011 -- DecayedReservoir: a recency-biased sample of real stream values

Status: accepted (v1.6.0)

## Context

Every existing lite-adaptive member returns a SUMMARY -- a count, a sum, a
quantile, a frequency, a drift bit, a top-k. None of them hands the caller a set
of ACTUAL, recent stream VALUES to compute anything they like over (a custom
percentile, a histogram, a bootstrap CI, a spark-line). DecayedReservoir is that
member: a fixed-size-`k` SAMPLE of real values biased toward the recent, over the
same TIME / RECENCY axis the family owns.

It is the FIFTH additive post-1.0 member and a PURE APPEND: the eight prior
classes (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper,
SlidingHyperLogLog, DriftDetector, SlidingDDSketch, SlidingCountMin) stay
BYTE-IDENTICAL. Only the file header roster comment + `VERSION` + the appended
`DecayedReservoir` class (and its `DR_*` consts) change.

## The algorithm

Weighted reservoir sampling by Efraimidis-Spirakis A-Res ("Weighted random
sampling with a reservoir", IPL 2006) with FORWARD-DECAY weights (Cormode et
al., ICDE 2009 -- design-parity with ForwardDecay). A-Res assigns every arriving
item a random key `key_i = u_i^(1/w_i)`, `u_i ~ Uniform(0,1)`, and keeps the `k`
items with the LARGEST keys. With a forward-decay weight `w_i = exp(lambda*(t_i -
L))` (more recent -> heavier), a recent item is exponentially more likely to be
retained; the retention probability of an item decays as `exp(-lambda*age)`,
`lambda = ln2 / halfLife`.

We work in LOG SPACE to avoid the `u^(1/w)` power (large `w` -> tiny exponent ->
underflow / precision loss):

```
key_i = log(u_i) * exp(-lambda * (t_i - L)) * scale
```

`log(u_i) < 0` and `exp(...) > 0`, so `key_i < 0`; keeping the `k` HIGHEST keys
(closest to 0) keeps the most-recent-weighted sample. The keys live in a size-`k`
binary MIN-HEAP (a "min-forest" -- design-parity with HeavyKeeper and lite-o1
FreqO1, INLINED, never a dep): the root is the smallest key = the eviction
candidate. `_offer(value, key)` inserts into a free slot while the heap has room,
else admits the item and evicts the root iff `key > _pri[0]`. 0-alloc.

One SEEDED xorshift32 draw `u ~ Uniform(0,1)` is taken per ACCEPTED add (the
exact same PRNG as HeavyKeeper: signed-int32 state, `x ^= x<<13; x ^= x>>>17; x
^= x<<5;`, `u = (x>>>0) / 2^32`), seeded via `hkFinal((seed ^ HK_RNG_SALT)|1)`.
The state never yields 0 (a full-period xorshift on a forced-odd seed), so `u` is
strictly in `(0, 1)` -> `log(u)` is finite and strictly negative -> `key` is
strictly in `(log(1/2^32), 0) ~= (-22.18, 0)`: never `-0`, never `-Inf`, never
`NaN`.

## The order-preserving landmark rebase (the numeric-stability proof)

As `t` grows with `L` fixed, `exp(-lambda*(t - L))` shrinks toward 0 and the
freshly-computed keys underflow to `-0`, which would TIE every recent slot and
destroy the `u`-based ordering. Mirroring ForwardDecay's `FD_EXP_CAP=40`, the hot
path REBASES the landmark to the current `t` whenever `lambda*(t - L)` would
exceed `DR_EXP_CAP = 40` -- BEFORE `exp(-lambda*(t - L))` can fall below
`exp(-40) ~= 4.2e-18` (astronomically above the smallest normal double `~2.2e-308`).
So a freshly-computed key never underflows.

The rebase is ORDER-PRESERVING. Moving the landmark `L -> L' = t` re-expresses
every stored key relative to `L'`:

```
key_i(L') = log(u_i) * exp(-lambda*(t_i - L'))
          = log(u_i) * exp(-lambda*(t_i - L)) * exp(lambda*(L' - L))
          = key_i(L) * F,   F = exp(lambda*(t - L)) > 1
```

`F` is COMMON to every stored key (no `t_i` dependence), so multiplying all live
keys by `F` is a strictly monotone transform: the `<` order among them -- and
therefore the retained set -- is UNCHANGED (QED). Because a retained item is by
construction recent (`t_i` near the current `t`), `key_i(L) ~ exp(-40)*log(u_i)`
and `key_i(L) * F ~ log(u_i) ~ O(1)`: the rescale lifts the retained keys back
off 0 without overflow.

The rescale visits the `<= k` live slots on the COLD, RARE rebase branch (roughly
every `DR_EXP_CAP / ln2 ~= 57.7` half-lives of elapsed time), NOT on the common
add path, and allocates 0 bytes. `scale` is held at `1.0`: the common factor `F`
is applied directly to the stored keys (a single scalar per rebase, one multiply
per live slot), so no separate running scale is needed; `scale` is retained in
the locked key formula as the extension hook for a future backward-decay variant.

### The idle-gap / big-jump guard

A huge idle gap then a resume (`t - L` enormous in ONE add) would make `F =
exp(lambda*(t - L))` overflow to `Infinity`, and `key * Infinity -> -Infinity`
would tie every retained slot. So the rebase CAPS the factor argument at
`DR_F_CAP = 700`: `F = exp(min(lambda*(t - L), 700))`. `exp(700) ~= 1.01e304`
times the worst-case `|key| ~= 22.18` is `~2.2e305 < Double.MAX ~= 1.798e308` --
finite after a SINGLE capped rebase. Two or more back-to-back capped rebases
(each a `> DR_F_CAP/lambda` idle gap) while the heap is not yet full (n < k, so
nothing is evicted between the gaps) CAN drive an ancient stored key past
`-Double.MAX` to `-Infinity`. This is benign BY DESIGN, not a bound violation:
capping `F` at a common ceiling still multiplies every stored key by the SAME
factor, so the order is preserved (a finite key stays above an `-Infinity` one,
and `-Infinity` keys among themselves are the oldest items, which is correct);
there is no `NaN` (the multiply is only `-Inf * positive -> -Inf`, never
`0 * Inf`); the sampled VALUE column stays finite; and those `-Infinity`-key items
sink to the bottom of the heap (as they should after epoch-long gaps) and are
evicted first by fresh arrivals, deterministically. The invariant we rely on is
ORDER PRESERVATION + a finite VALUE column + determinism -- all of which hold; the
"stays finite" figure above bounds only the single-cap case. A witness + test lane
drives a `1e12` idle gap, resumes, and asserts the sample is well-defined (no
`NaN`, unambiguous membership, reproducible for a fixed seed).

## Surface (raw sample only)

DecayedReservoir hands back RAW values; it computes no aggregates:

- `add(now?, value?)` / `addFrom(buf, i)` -- record a value (`value` defaults to
  `1`; any finite real, signed OK). Time modes lock at the first add (EXPLICIT
  `add(now, value)` monotone `now`, or COUNT `add(undefined, value)` auto-tick),
  parity with EH / FD / SlidingDDSketch. `addFrom` is EXPLICIT-time only,
  zero-box stride-2 `[now, value]`.
- `sampleInto(buf) -> count` -- 0-alloc copy of the current sample values.
- `forEach(fn)` -- alloc-free iteration, `fn(value)`.
- `clear()` -- 0-alloc reset, unlocks the mode, replays the PRNG from its seed.
- getters `k` / `halfLife` / `lambda` / `seed` / `size` / `mode` / `bytes`.

`bytes = k*16 + 64`: two `Float64Array(k)` columns (`_val` values + `_pri` keys,
`k*8` each) plus the scalar overhead. No `_seq` column -- keys are distinct in
practice (see above) so a stable secondary order needs no extra memory.

## Rejected alternatives

- **A-ExpJ** (Efraimidis-Spirakis' faster exponential-jumps variant): O(k log(n/k))
  draws instead of one-per-item, but it carries a running threshold and a
  skip-counter whose interaction with a per-item forward-decay weight and the
  landmark rebase is far subtler to keep 0-alloc and provably correct. A-Res is
  one draw per accepted add, dead simple, and already 0-alloc; the constant-factor
  win of A-ExpJ is irrelevant at streaming rates. REJECTED for v1.6.0.
- **A hard-window sample** (uniformly sample the last W, EH-style expiry): loses
  the SMOOTH recency the family's decay members sell and needs a per-slot expiry
  sweep. The whole point of this member is a decayed, always-full sample.
  REJECTED.
- **Convenience aggregates** (`mean()` / `quantile()` over the sample): the member
  exists precisely so the caller computes WHATEVER they want over real values;
  baking in aggregates re-implements ForwardDecay / SlidingDDSketch and invites
  the caller to trust a `k`-point estimate as if it were exact. The sample is the
  product; aggregates are the caller's. REJECTED.
- **advance() / advanceFrom() (R11 idle-slide)**: EXCLUDED. A reservoir is a
  SAMPLE, not a hard window -- there is nothing to expire when idle; the decay is
  already carried in the keys and applied at the next add's rebase. Adding
  advance would imply a hard edge the member does not have. EXCLUDED (parity
  rationale documented so a future reader does not "fix" the omission).
