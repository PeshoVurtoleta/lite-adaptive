// @zakkster/lite-adaptive -- SlidingCountMin adversarial boundary-matrix suite (node:test).
// Closes gaps left by test/SlidingCountMin.test.js: the sibling windowed members (SlidingDDSketch,
// SlidingHyperLogLog) each carry an explicit "BOUNDARY MATRIX -- 0/1/N-1/N/N+1, empty, null,
// undefined, NaN, -0, duplicate dispose, re-entrant write, adversarial" section; SlidingCountMin's
// coder suite never got one. This file is that section for SlidingCountMin. Test-only: no shipped
// code in Adaptive.js is touched by this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingCountMin, VERSION } from '../Adaptive.js';

const SAT = 4294967295;               // SCM_SAT (2^32 - 1)
const MAX_SAFE = 9007199254740991;    // 2^53 - 1

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// VERSION pin
// ---------------------------------------------------------------------------
test('VERSION is 1.5.0', () => {
    assert.equal(VERSION, '1.5.0');
});

// ---------------------------------------------------------------------------
// 0 / 1 / N-1 / N / N+1 boundary matrix -- panes, d, w exact ACCEPT at both ends
// (the coder suite only proved the N-1/N+1 REJECT side; this proves the N/min ACCEPT side).
// ---------------------------------------------------------------------------
test('panes accepts the exact boundary values 2 (min) and 1024 (max)', () => {
    const lo = new SlidingCountMin(1000, { panes: 2 });
    assert.equal(lo.panes, 2);
    const hi = new SlidingCountMin(1000, { panes: 1024 });
    assert.equal(hi.panes, 1024);
});

test('d accepts the exact boundary values 1 (min) and 32 (max)', () => {
    const lo = new SlidingCountMin(1000, { d: 1 });
    assert.equal(lo.d, 1);
    const hi = new SlidingCountMin(1000, { d: 32 });
    assert.equal(hi.d, 32);
});

test('w accepts the exact boundary values 1 (min, rounds to pow2 1) and 65536 (max)', () => {
    const lo = new SlidingCountMin(1000, { w: 1 });
    assert.equal(lo.w, 1);
    const hi = new SlidingCountMin(1000, { w: 1 << 16 });
    assert.equal(hi.w, 1 << 16);
});

test('count accepts the exact boundary values 1 (min) and SAT (2^32-1, max)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7, 1);
    assert.equal(s.estimate(7), 1);
    const t = new SlidingCountMin(1000, { panes: 4 });
    t.add(1, 8, SAT);
    assert.equal(t.estimate(8), SAT);
    assert.equal(t.saturated, 0);   // exactly at the ceiling, not OVER it -- must not count as saturated
});

test('key accepts the exact safe-integer boundary +-(2^53 - 1); rejects one past it', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, MAX_SAFE, 3);
    assert.equal(s.estimate(MAX_SAFE), 3);
    s.add(1, -MAX_SAFE, 5);
    assert.equal(s.estimate(-MAX_SAFE), 5);
    assert.throws(() => s.add(1, MAX_SAFE + 1), /safe integer/);      // one past (loses precision -> still caught)
    assert.throws(() => s.add(1, -(MAX_SAFE + 1)), /safe integer/);
});

// ---------------------------------------------------------------------------
// empty window
// ---------------------------------------------------------------------------
test('empty (never-added-to) instance: estimate is 0 for any key, W or 0-key alike', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    assert.equal(s.estimate(0), 0);
    assert.equal(s.estimate(-0), 0);
    assert.equal(s.mode, 'unset');
    assert.equal(s.lastNow, 0);
    assert.equal(s.saturated, 0);
});

// ---------------------------------------------------------------------------
// null / undefined -- every new entry point, typeof-first fail-closed
// ---------------------------------------------------------------------------
test('add rejects a null key/count and treats them exactly like any other non-number (typeof-first)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    assert.throws(() => s.add(1, null), /safe integer/);
    assert.throws(() => s.add(1, 7, null), /count/);
});

test('add(now) rejects a null now once EXPLICIT mode is locked (typeof-first, not just falsy)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7);   // locks EXPLICIT
    assert.throws(() => s.add(null, 8), /finite number/);
});

test('ctor rejects a null options-bag value distinctly from an omitted (undefined) one', () => {
    // omitted options -> defaults, no throw
    assert.doesNotThrow(() => new SlidingCountMin(1000));
    assert.doesNotThrow(() => new SlidingCountMin(1000, undefined));
    // explicit null -> throws (options must be an object, null is not one)
    assert.throws(() => new SlidingCountMin(1000, null), /options must be an object/);
});

test('addFrom rejects a null/undefined buf and a null/undefined index (byte-identical no-op)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7, 2);
    const before = s.estimate(7);
    assert.throws(() => s.addFrom(null, 0), /Float64Array/);
    assert.throws(() => s.addFrom(undefined, 0), /Float64Array/);
    assert.throws(() => s.addFrom(new Float64Array([1, 2, 3]), null), /in-bounds/);
    assert.throws(() => s.addFrom(new Float64Array([1, 2, 3]), undefined), /in-bounds/);
    assert.equal(s.estimate(7), before);
});

test('advanceFrom rejects a null/undefined buf and a null/undefined index (byte-identical no-op)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7, 2);
    const beforeEnd = Array.from(s._paneEnd);
    assert.throws(() => s.advanceFrom(null, 0), /Float64Array/);
    assert.throws(() => s.advanceFrom(undefined, 0), /Float64Array/);
    assert.throws(() => s.advanceFrom(new Float64Array([5]), null), /in-bounds/);
    assert.throws(() => s.advanceFrom(new Float64Array([5]), undefined), /in-bounds/);
    assert.deepEqual(Array.from(s._paneEnd), beforeEnd);
});

// ---------------------------------------------------------------------------
// NaN -- every numeric entry point, including the one the coder suite missed (count=NaN)
// ---------------------------------------------------------------------------
test('add rejects NaN in key, count, and now (each independently, byte-identical no-op)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7, 2);
    const before = s.estimate(7);
    assert.throws(() => s.add(2, NaN, 1), /safe integer/);
    assert.throws(() => s.add(2, 8, NaN), /count/);
    assert.throws(() => s.add(NaN, 8), /finite number/);
    assert.equal(s.estimate(7), before);
    assert.equal(s.lastNow, 1);
});

test('addFrom rejects a packed NaN count distinctly from a packed NaN key', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    assert.throws(() => s.addFrom(new Float64Array([1, 7, NaN]), 0), /count/);
});

// ---------------------------------------------------------------------------
// -0 -- numeric -0 must be treated identically to 0 everywhere (not a distinct state);
// this is the one axis the coder suite never exercised for SlidingCountMin at all.
// ---------------------------------------------------------------------------
test('key = -0 hashes identically to key = 0 (numeric -0 === 0)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, -0, 3);
    assert.equal(s.estimate(0), 3);
    assert.equal(s.estimate(-0), 3);
});

test('now = -0 is accepted as the anchor time (numeric -0 === 0, no distinct state, not < lastNow 0)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(-0, 7, 5);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, -0);
    assert.equal(s.estimate(7), 5);
});

test('a sub-window w = -0 is rejected identically to w = 0 (estimate returns 0, never throws)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7, 4);
    assert.equal(s.estimate(7, -0), 0);
    assert.equal(s.estimate(7, 0), s.estimate(7, -0));
});

test('advance(now = -0) on a fresh instance anchors at -0 (treated as 0)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.advance(-0);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.lastNow, -0);
    assert.equal(s.estimate(7), 0);
});

// ---------------------------------------------------------------------------
// duplicate dispose (double clear()) -- the sibling members all carry this; SlidingCountMin's
// coder suite never did.
// ---------------------------------------------------------------------------
test('duplicate clear() (double-dispose): clearing an already-empty instance is a safe no-op', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    assert.equal(s.clear(), s);
    assert.equal(s.clear(), s);
    assert.equal(s.estimate(7), 0);
    assert.equal(s.mode, 'unset');
    assert.equal(s.saturated, 0);
});

test('duplicate clear() after fill + drain stays a clean, 0-bytes-drift reusable no-op', () => {
    const s = new SlidingCountMin(1000, { panes: 8 });
    const bytes0 = s.bytes;
    for (let t = 1; t <= 900; t++) s.add(t, 7, 2);
    s.clear();
    s.clear();   // duplicate dispose after the state is already empty
    assert.equal(s.estimate(7), 0);
    assert.equal(s.bytes, bytes0);
    assert.equal(s.mode, 'unset');
    // still fully reusable after the double-clear
    s.add(1, 7, 9);
    assert.equal(s.estimate(7), 9);
});

// ---------------------------------------------------------------------------
// dispose-during-iteration / re-entrant write -- SlidingCountMin exposes NO iteration or
// callback API (no forEach, no XInto with an aliasable caller buffer beyond addFrom/advanceFrom's
// OWN packed slots), so there is no re-entrant hazard surface of that shape (matches the same
// documented limitation on its pane-ring sibling SlidingDDSketch). The closest analogous hazard
// this class DOES expose is a caller reusing / mutating the SAME Float64Array across back-to-back
// addFrom / advanceFrom calls (no internal aliasing, but a shared external buffer) -- proven here.
// ---------------------------------------------------------------------------
test('addFrom then advanceFrom reusing the SAME Float64Array buffer object does not cross-contaminate state', () => {
    const s = new SlidingCountMin(1000, { panes: 8 });
    const buf = new Float64Array(3);
    buf[0] = 1; buf[1] = 42; buf[2] = 5;
    s.addFrom(buf, 0);
    assert.equal(s.estimate(42), 5);
    // reuse the SAME buffer object (overwritten in place) for advanceFrom -- only buf[0] is read.
    buf[0] = 2000; buf[1] = 999999; buf[2] = 999999;   // garbage in slots 1/2, advanceFrom must ignore them
    s.advanceFrom(buf, 0);
    assert.equal(s.lastNow, 2000);
    assert.equal(s.estimate(42), 0, 'the window must have slid past the original add, garbage slots ignored');
});

// ---------------------------------------------------------------------------
// ADVERSARIAL (the harness's required "not planner-anticipated" case): an astronomically small
// window W (subnormal-range) drives the derived per-pane width `_paneW = W / panes` to underflow to
// EXACT 0. Left unguarded, `_anchor`'s `Math.floor(now / pw)` would be a division-by-zero producing
// NaN paneEnd values; because every `paneEnd[p] > cut` comparison against NaN is FALSE, no pane is
// ever "live", so add() would never throw yet estimate() would SILENTLY return 0 for a key added on
// the same tick -- a silent violation of the headline one-sided LOWER bound `true(W) <= est`. Per the
// suite's "fail closed on every unverified state" Law, the ctor now GUARDS the derived pane width
// (`paneW > 0 && Number.isFinite(paneW)`) and throws at construction rather than silently degrading.
// (The same guard is on SlidingDDSketch, which shares the `W / panes` pane model.)
// ---------------------------------------------------------------------------
test('ADVERSARIAL: a subnormal W (W / panes underflows to 0) FAILS CLOSED at the ctor door (throws, ' +
    'never a silent lower-bound violation)', () => {
    const W = Number.MIN_VALUE;   // 5e-324; W/panes rounds to exactly 0 for any panes >= 2
    assert.throws(() => new SlidingCountMin(W, { panes: 2 }), /\[lite-adaptive\] SlidingCountMin W is too small/,
        'a subnormal W must throw at construction, not build a silently-broken instance');
    // a realistic tiny-but-representable W (paneW stays > 0) still constructs and works normally:
    const ok = new SlidingCountMin(1e-6, { panes: 2 });
    assert.ok(ok._paneW > 0, 'a representable small W keeps a positive pane width');
    ok.add(0, 42, 1);
    assert.ok(ok.estimate(42) >= 1, 'a representable small W counts normally');
});

// ---------------------------------------------------------------------------
// edge off-by-one at the window boundary: a key added exactly at the edge must be expired from
// estimate() after advance(itemTime + W), and must still count while inside W.
// ---------------------------------------------------------------------------
test('a key at the window edge: still counted just inside W, gone once advanced past itemTime + W', () => {
    const W = 1000, panes = 10;
    const s = new SlidingCountMin(W, { panes });
    s.add(1, 7, 1);                 // the oldest item, at t=1
    s.add(1 + W - 1, 8, 1);         // a sibling item just inside the window from t=1's perspective
    assert.ok(s.estimate(7) >= 1, 'still inside W (or the straddling pane) at t=1+W-1');
    // advance well past t=1's window edge (itemTime + W + one full pane width of slack for the
    // straddling-oldest-pane KEEP semantics) -- now it MUST be gone.
    s.advance(1 + W + (W / panes) + 1);
    assert.equal(s.estimate(7), 0, 'expired once fully outside [W, W + W/panes]');
});

// ---------------------------------------------------------------------------
// saturation clamp + `saturated` increments + estimate returns a correct DOUBLE past 2^32
// ---------------------------------------------------------------------------
test('saturation clamps a per-pane cell at 2^32-1, increments `saturated` exactly once per hit, ' +
    'and estimate sums correctly across panes past 2^32 (a true double, not a wrapped uint32)', () => {
    const s = new SlidingCountMin(1000, { panes: 2, w: 16, d: 2, seed: 21 });
    const pw = 500;
    assert.equal(s.saturated, 0);
    s.add(10, 7, SAT);            // pane A: exactly SAT, not over -> no saturation yet
    assert.equal(s.saturated, 0);
    s.add(10, 7, 1);              // pane A: SAT + 1 -> clamps, saturated++
    assert.equal(s.estimate(7, 400), SAT, 'clamped at the ceiling within pane A alone');
    assert.equal(s.saturated, 1);
    s.add(pw + 10, 7, SAT);       // pane B: a second near-max count (different pane) -> another saturation
    const est = s.estimate(7);
    assert.ok(est > 4294967295, 'the cross-pane DOUBLE sum exceeds 2^32: ' + est);
    assert.equal(est, SAT + SAT, 'exact double sum across two saturated panes');
    assert.ok(s.saturated >= 1);
});

// ---------------------------------------------------------------------------
// composite-key correctness: channelIdx*2^32 + tag -- two channels with the same tag must not
// collide; a non-safe-integer key throws on add but estimate(bad key) NEVER throws (returns 0).
// ---------------------------------------------------------------------------
test('composite key channelIdx*2^32+tag: two channels sharing a tag do not collide in estimate', () => {
    const s = new SlidingCountMin(1e9, { panes: 4, seed: 33 });
    const chan0tag5 = 0 * 4294967296 + 5;
    const chan1tag5 = 1 * 4294967296 + 5;
    const chan2tag5 = 2 * 4294967296 + 5;
    s.add(1, chan0tag5, 10);
    s.add(1, chan1tag5, 20);
    s.add(1, chan2tag5, 30);
    assert.equal(s.estimate(chan0tag5), 10);
    assert.equal(s.estimate(chan1tag5), 20);
    assert.equal(s.estimate(chan2tag5), 30);
});

test('a non-safe-integer composite key throws on add; estimate on the SAME bad key never throws (0)', () => {
    const s = new SlidingCountMin(1e9, { panes: 4 });
    const tooBig = 9007199254741 * 1e6;   // well past 2^53 - 1 once multiplied out
    assert.throws(() => s.add(1, tooBig, 1), /safe integer/);
    assert.equal(s.estimate(tooBig), 0);
    assert.equal(s.estimate(1.5), 0);
    assert.equal(s.estimate('7'), 0);
    assert.equal(s.estimate(null), 0);
    assert.equal(s.estimate(undefined), 0);
});

// ---------------------------------------------------------------------------
// conservative correctness: conservative=true <= conservative=false on a colliding stream,
// BOTH still >= true(W) (one-sided over-estimate holds for both branches independently).
// ---------------------------------------------------------------------------
test('conservative=true estimate <= conservative=false estimate on a colliding stream; both >= true(W)', () => {
    const rng = mulberry32(0xC0DED00D);
    const cons = new SlidingCountMin(1e9, { panes: 2, w: 32, d: 3, conservative: true, seed: 44 });
    const plain = new SlidingCountMin(1e9, { panes: 2, w: 32, d: 3, conservative: false, seed: 44 });
    const truth = new Map();
    let t = 0;
    for (let i = 0; i < 4000; i++) {
        t += 1;
        const key = (i % 20 === 0) ? 1 : (rng() * 3000) | 0;   // key 1 is a moderately-heavy repeat
        cons.add(t, key);
        plain.add(t, key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    for (const [key, c] of truth) {
        const ce = cons.estimate(key), pe = plain.estimate(key);
        assert.ok(ce >= c, 'conservative must never under-count key ' + key);
        assert.ok(pe >= c, 'plain must never under-count key ' + key);
        assert.ok(ce <= pe, 'conservative <= plain for key ' + key + ' (' + ce + ' vs ' + pe + ')');
    }
});

// ---------------------------------------------------------------------------
// mode-lock both ways + monotone no-op + advanceFrom bad-buffer no-op + unset locks EXPLICIT
// ---------------------------------------------------------------------------
test('mode locks EXPLICIT <-> COUNT both ways (a cross-mode add throws, byte-identical no-op)', () => {
    const e = new SlidingCountMin(1000, { panes: 4 });
    e.add(10, 1, 1);
    assert.equal(e.mode, 'explicit');
    const beforeE = e.estimate(1);
    assert.throws(() => e.add(undefined, 1), /mode is locked to explicit/);
    assert.equal(e.estimate(1), beforeE);

    const c = new SlidingCountMin(1000, { panes: 4 });
    c.add(undefined, 1, 1);
    assert.equal(c.mode, 'count');
    const beforeC = c.estimate(1);
    assert.throws(() => c.add(5, 1), /mode is locked to count/);
    assert.equal(c.estimate(1), beforeC);
});

test('monotone now: a decreasing now is rejected as a byte-identical no-op (lastNow/estimate untouched)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(100, 7, 3);
    s.add(150, 7, 2);
    const before = s.estimate(7), lastNowBefore = s.lastNow;
    assert.throws(() => s.add(149, 7), /non-decreasing/);
    assert.equal(s.estimate(7), before);
    assert.equal(s.lastNow, lastNowBefore);
    // exact equality (now === lastNow) is NOT a decrease -- must be accepted.
    assert.doesNotThrow(() => s.add(150, 7, 1));
});

test('advance rejects a non-decreasing now the same way, and a mode-locked cross-call is a no-op', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(100, 7);
    s.advance(200);
    const beforeEnd = Array.from(s._paneEnd), lastNowBefore = s.lastNow;
    assert.throws(() => s.advance(199), /non-decreasing/);
    assert.deepEqual(Array.from(s._paneEnd), beforeEnd);
    assert.equal(s.lastNow, lastNowBefore);
});

test('advanceFrom rejects a bad buffer/index as a byte-identical no-op (state fully untouched)', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.add(1, 7, 3);
    const beforeEnd = Array.from(s._paneEnd), beforeEst = s.estimate(7), lastNowBefore = s.lastNow;
    assert.throws(() => s.advanceFrom([1], 0), /Float64Array/);
    assert.throws(() => s.advanceFrom(new Float32Array([1]), 0), /Float64Array/);
    assert.throws(() => s.advanceFrom(new Float64Array([1]), 5), /in-bounds/);
    assert.throws(() => s.advanceFrom(new Float64Array([1]), -1), /in-bounds/);
    assert.throws(() => s.advanceFrom(new Float64Array([1]), 0.5), /in-bounds/);
    assert.deepEqual(Array.from(s._paneEnd), beforeEnd);
    assert.equal(s.estimate(7), beforeEst);
    assert.equal(s.lastNow, lastNowBefore);
});

test('an UNSET instance locks EXPLICIT on its first advance() (not COUNT) and anchors the ring', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    assert.equal(s.mode, 'unset');
    s.advance(500);
    assert.equal(s.mode, 'explicit');
    assert.equal(s.estimate(7), 0);
    s.add(500, 7, 6);              // must accept a matching EXPLICIT add after the advance-locked mode
    assert.equal(s.estimate(7), 6);
    assert.throws(() => s.add(undefined, 8), /mode is locked to explicit/);
});

test('an UNSET instance also locks EXPLICIT on its first advanceFrom()', () => {
    const s = new SlidingCountMin(1000, { panes: 4 });
    s.advanceFrom(new Float64Array([300]), 0);
    assert.equal(s.mode, 'explicit');
    s.add(300, 9, 4);
    assert.equal(s.estimate(9), 4);
});

// ---------------------------------------------------------------------------
// withAccuracy: sizing correctness matches the ctor-options path; bad args throw
// ---------------------------------------------------------------------------
test('withAccuracy sizes w/d identically to the equivalent {epsilon,delta} ctor across several targets', () => {
    for (const [eps, delta] of [[0.1, 0.1], [0.02, 0.05], [0.001, 0.01], [0.5, 0.5]]) {
        const viaCtor = new SlidingCountMin(1000, { epsilon: eps, delta });
        const viaWA = SlidingCountMin.withAccuracy(1000, eps, delta);
        assert.equal(viaWA.w, viaCtor.w, 'w mismatch at eps=' + eps + ' delta=' + delta);
        assert.equal(viaWA.d, viaCtor.d, 'd mismatch at eps=' + eps + ' delta=' + delta);
    }
});

test('withAccuracy rejects bad epsilon / delta / options with the SAME messages as the ctor', () => {
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0, 0.01), /epsilon/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 1, 0.01), /epsilon/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, NaN, 0.01), /epsilon/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0.01, 0), /delta/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0.01, 1), /delta/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0.01, NaN), /delta/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0.01, 0.01, null), /options must be an object/);
    assert.throws(() => SlidingCountMin.withAccuracy(1000, 0.01, 0.01, 'x'), /options must be an object/);
    assert.throws(() => SlidingCountMin.withAccuracy(0, 0.01, 0.01), /finite number > 0/);
});

test('withAccuracy passes through panes/seed/conservative and lets explicit w/d override the derived value', () => {
    const s = SlidingCountMin.withAccuracy(2000, 0.01, 0.01, { panes: 64, seed: 5, conservative: false });
    assert.equal(s.panes, 64);
    assert.equal(s.seed, 5);
    assert.equal(s.conservative, false);
    const overridden = SlidingCountMin.withAccuracy(2000, 0.01, 0.01, { w: 8, d: 2 });
    assert.equal(overridden.w, 8);
    assert.equal(overridden.d, 2);
});
