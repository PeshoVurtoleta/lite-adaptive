// @zakkster/lite-adaptive -- DecayedReservoir behavioral + fail-closed suite (node:test).
// Closes the reviewer's BLOCKER: DecayedReservoir shipped with no dedicated test file, so `npm test`
// never actually exercised it. Style mirrors test/SlidingCountMin.test.js + .boundary.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecayedReservoir, VERSION } from '../Adaptive.js';

/** A deterministic mulberry32 PRNG so every assertion is reproducible (matches sibling suites). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const DEFAULT_SEED = 0x9e3779b1;

/** Snapshot every observable that a rejected op must NOT move. */
function snapshotState(r) {
    return { rng: r._rng, L: r._L, tick: r._tick, lastNow: r._lastNow, n: r._n, mode: r._mode };
}
function assertUnchanged(before, r) {
    assert.equal(r._rng, before.rng, 'PRNG state must not advance on a rejected op');
    assert.equal(r._L, before.L, 'landmark must not move on a rejected op');
    assert.equal(r._tick, before.tick, 'count-mode tick must not advance on a rejected op');
    assert.equal(r._lastNow, before.lastNow, 'lastNow must not advance on a rejected op');
    assert.equal(r._n, before.n, 'sample size must not change on a rejected op');
    assert.equal(r._mode, before.mode, 'mode must not change on a rejected op');
}
function twins(k, halfLife, seed) {
    return [new DecayedReservoir(k, halfLife, { seed }), new DecayedReservoir(k, halfLife, { seed })];
}
function feedFrom(r, t, v) {
    const buf = new Float64Array(2);
    buf[0] = t; buf[1] = v;
    r.addFrom(buf, 0);
}

// ---------------------------------------------------------------------------
// 1. VERSION pin (the 9th pin)
// ---------------------------------------------------------------------------
test('VERSION is 1.6.0', () => {
    assert.equal(VERSION, '1.6.0');
});

// ---------------------------------------------------------------------------
// 2. ctor: fail-closed BEFORE allocation (typeof-first)
// ---------------------------------------------------------------------------
test('ctor rejects a non-integer / non-positive / non-finite k (typeof-first, before allocation)', () => {
    assert.throws(() => new DecayedReservoir(0, 100), /k must be an integer >= 1/);
    assert.throws(() => new DecayedReservoir(-1, 100), /k must be an integer >= 1/);
    assert.throws(() => new DecayedReservoir(1.5, 100), /k must be an integer >= 1/);
    assert.throws(() => new DecayedReservoir(NaN, 100), /k must be an integer >= 1/);
    assert.throws(() => new DecayedReservoir('4', 100), /k must be an integer >= 1/);
    assert.throws(() => new DecayedReservoir(Infinity, 100), /k must be an integer >= 1/);
    assert.throws(() => new DecayedReservoir(-0, 100), /k must be an integer >= 1/);   // -0 < 1 -> rejected like 0
});

test('ctor rejects a non-finite / non-positive halfLife', () => {
    assert.throws(() => new DecayedReservoir(8, 0), /halfLife must be a finite number > 0/);
    assert.throws(() => new DecayedReservoir(8, -1), /halfLife must be a finite number > 0/);
    assert.throws(() => new DecayedReservoir(8, NaN), /halfLife must be a finite number > 0/);
    assert.throws(() => new DecayedReservoir(8, Infinity), /halfLife must be a finite number > 0/);
    assert.throws(() => new DecayedReservoir(8, '100'), /halfLife must be a finite number > 0/);
});

test('ctor rejects a bad seed / a non-object options / an unknown option key', () => {
    assert.throws(() => new DecayedReservoir(8, 100, { seed: 1.5 }), /seed must be a uint32/);
    assert.throws(() => new DecayedReservoir(8, 100, { seed: -1 }), /seed must be a uint32/);
    assert.throws(() => new DecayedReservoir(8, 100, { seed: 2 ** 32 }), /seed must be a uint32/);
    assert.throws(() => new DecayedReservoir(8, 100, { seed: '0' }), /seed must be a uint32/);
    assert.throws(() => new DecayedReservoir(8, 100, 5), /options must be an object/);
    assert.throws(() => new DecayedReservoir(8, 100, null), /options must be an object/);
    assert.throws(() => new DecayedReservoir(8, 100, { foo: 1 }), /unknown option/);
});

test('ctor accepts an omitted / undefined options bag (defaults, no throw)', () => {
    assert.doesNotThrow(() => new DecayedReservoir(8, 100));
    assert.doesNotThrow(() => new DecayedReservoir(8, 100, undefined));
});

test('ctor accepts seed = 0 as a VALID distinct seed (null is not zero / undefined is the real guard)', () => {
    const zero = new DecayedReservoir(8, 100, { seed: 0 });
    const dflt = new DecayedReservoir(8, 100);
    assert.equal(zero.seed, 0);
    assert.equal(dflt.seed, DEFAULT_SEED);
    assert.notEqual(zero.seed, dflt.seed);
    for (let t = 1; t <= 20; t++) { zero.add(t, t); dflt.add(t, t); }
    const bz = new Float64Array(8), bd = new Float64Array(8);
    zero.sampleInto(bz); dflt.sampleInto(bd);
    assert.notDeepEqual(Array.from(bz), Array.from(bd), 'seed=0 must yield a working, distinct-from-default stream');
});

// ---------------------------------------------------------------------------
// 3. mode lock both directions + monotone violation
// ---------------------------------------------------------------------------
test('mode locks EXPLICIT at the first add(now, v); a count-mode add then throws', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(10, 1);
    assert.equal(r.mode, 'explicit');
    assert.throws(() => r.add(undefined, 2), /mode is locked to explicit/);
});

test('mode locks COUNT at the first add(undefined, v); an explicit add then throws', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(undefined, 1);
    assert.equal(r.mode, 'count');
    assert.throws(() => r.add(5, 2), /mode is locked to count/);
});

test('a monotone violation (now decreases) throws', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(5, 1);
    assert.throws(() => r.add(3, 2), /non-decreasing/);
});

// ---------------------------------------------------------------------------
// 4. value domain: default 1, any finite real (signed OK), non-finite / non-number rejected
// ---------------------------------------------------------------------------
test('value defaults to 1 when omitted', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(1);
    const buf = new Float64Array(4);
    const n = r.sampleInto(buf);
    assert.equal(n, 1);
    assert.equal(buf[0], 1);
});

test('any finite real value is accepted, including negative and zero (signed OK)', () => {
    const r = new DecayedReservoir(8, 100, { seed: 1 });
    const values = [10, -5, 0, -0, 3.25, -99.5];
    for (let i = 0; i < values.length; i++) r.add(i + 1, values[i]);
    const buf = new Float64Array(8);
    const n = r.sampleInto(buf);
    assert.ok(Array.from(buf.subarray(0, n)).some((v) => v < 0), 'a negative value must be able to appear in the sample');
});

test('a non-finite / non-number value is rejected (throws) and is a no-op', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(1, 5);
    const before = snapshotState(r);
    assert.throws(() => r.add(2, NaN), /add value must be a finite number/);
    assert.throws(() => r.add(2, Infinity), /add value must be a finite number/);
    assert.throws(() => r.add(2, -Infinity), /add value must be a finite number/);
    assert.throws(() => r.add(2, '7'), /add value must be a finite number/);
    assert.throws(() => r.add(2, null), /add value must be a finite number/);
    assertUnchanged(before, r);
});

test('add rejects a null/undefined-typed now once explicit mode is locked (typeof-first, not just falsy)', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(1, 5);
    assert.throws(() => r.add(null, 6), /add now must be a finite number/);
});

// ---------------------------------------------------------------------------
// 5. sampleInto: type / length guard, true count, copy semantics, empty
// ---------------------------------------------------------------------------
test('sampleInto throws on a non-Float64Array buf and on buf.length < k', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(1, 5);
    assert.throws(() => r.sampleInto([1, 2, 3, 4]), /sampleInto\(buf\) needs a Float64Array/);
    assert.throws(() => r.sampleInto(new Float64Array(3)), /sampleInto\(buf\) needs a Float64Array of length >= k/);
    assert.throws(() => r.sampleInto(null), /sampleInto\(buf\) needs a Float64Array/);
    assert.throws(() => r.sampleInto(undefined), /sampleInto\(buf\) needs a Float64Array/);
});

test('sampleInto: N-1 (too small) rejects, N (exact k) and N+1 (larger) both accept', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    for (let t = 1; t <= 10; t++) r.add(t, t);
    assert.throws(() => r.sampleInto(new Float64Array(3)), /length >= k/);   // N-1
    assert.equal(r.sampleInto(new Float64Array(4)), 4);                      // N
    assert.equal(r.sampleInto(new Float64Array(5)), 4);                      // N+1 (only n written)
});

test('sampleInto returns the true count (= size, <= k); an empty reservoir returns 0', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    const buf = new Float64Array(4);
    assert.equal(r.sampleInto(buf), 0);
    for (let t = 1; t <= 2; t++) r.add(t, t * 10);
    assert.equal(r.sampleInto(buf), 2);
    assert.equal(r.sampleInto(buf), r.size);
    for (let t = 3; t <= 20; t++) r.add(t, t * 10);   // overflow past k
    assert.equal(r.sampleInto(buf), r.k);
    assert.ok(r.sampleInto(buf) <= r.k);
});

test('sampleInto copies VALUES, not references: mutating the returned buf does not change internal state', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    for (let t = 1; t <= 4; t++) r.add(t, t * 100);
    const buf1 = new Float64Array(4);
    r.sampleInto(buf1);
    const snapshot = Array.from(buf1);
    buf1[0] = -999999;   // mutate the caller's copy
    const buf2 = new Float64Array(4);
    r.sampleInto(buf2);
    assert.deepEqual(Array.from(buf2), snapshot, 'a second sampleInto must still return the real, untouched sample');
});

// ---------------------------------------------------------------------------
// 6. forEach: throws on non-function, calls exactly size times, matches sampleInto
// ---------------------------------------------------------------------------
test('forEach throws on a non-function fn', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(1, 5);
    assert.throws(() => r.forEach(null), /forEach\(fn\) needs a function/);
    assert.throws(() => r.forEach(42), /forEach\(fn\) needs a function/);
    assert.throws(() => r.forEach(undefined), /forEach\(fn\) needs a function/);
});

test('forEach on an empty reservoir calls fn zero times', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    let calls = 0;
    r.forEach(() => calls++);
    assert.equal(calls, 0);
});

test('forEach calls fn exactly size times, with values matching sampleInto', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    for (let t = 1; t <= 10; t++) r.add(t, t * 7);
    let calls = 0;
    const seen = [];
    r.forEach((v) => { calls++; seen.push(v); });
    assert.equal(calls, r.size);
    const buf = new Float64Array(4);
    const n = r.sampleInto(buf);
    assert.deepEqual(seen, Array.from(buf.subarray(0, n)));
});

// ---------------------------------------------------------------------------
// 7. clear(): resets size, unlocks mode, replays the PRNG deterministically; duplicate dispose
// ---------------------------------------------------------------------------
test('clear() resets size to 0 and unlocks the mode (can switch explicit<->count after clear)', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(1, 5);
    assert.equal(r.mode, 'explicit');
    r.clear();
    assert.equal(r.size, 0);
    assert.equal(r.mode, 'unset');
    r.add(undefined, 9);   // switch to count mode -- must be allowed post-clear
    assert.equal(r.mode, 'count');
});

test('clear() replays the PRNG deterministically: fresh vs cleared+refed with the identical stream match', () => {
    const stream = [];
    for (let t = 1; t <= 50; t++) stream.push([t, (t * 37) % 101 - 50]);
    const fresh = new DecayedReservoir(8, 200, { seed: 42 });
    for (const [t, v] of stream) fresh.add(t, v);

    const cleared = new DecayedReservoir(8, 200, { seed: 42 });
    for (const [t, v] of stream) cleared.add(t, v);   // pre-pollute
    cleared.clear();
    for (const [t, v] of stream) cleared.add(t, v);   // replay identically

    const bf = new Float64Array(8), bc = new Float64Array(8);
    const nf = fresh.sampleInto(bf), nc = cleared.sampleInto(bc);
    assert.equal(nf, nc);
    assert.deepEqual(Array.from(bf), Array.from(bc));
});

test('duplicate clear() (double-dispose) is a safe no-op', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    assert.equal(r.clear(), r);
    assert.equal(r.clear(), r);
    assert.equal(r.size, 0);
    assert.equal(r.mode, 'unset');
    r.add(1, 5);
    assert.equal(r.size, 1);
});

// ---------------------------------------------------------------------------
// 8. THE REVIEWER'S KEY ASSERTION -- reject is a byte-identical no-op that does NOT advance the
// PRNG or the landmark, for BOTH add and addFrom.
// ---------------------------------------------------------------------------
test('reject-is-no-op (add): a rejected NaN value does not advance the PRNG/landmark; A and B end identical', () => {
    const [a, b] = twins(6, 300, 7);
    const prefix = [[1, 10], [2, -5], [3, 0], [4, 22.5], [5, -8]];
    for (const [t, v] of prefix) { a.add(t, v); b.add(t, v); }
    const before = snapshotState(a);
    assert.throws(() => a.add(6, NaN), /add value must be a finite number/);
    assertUnchanged(before, a);
    const cont = [[6, 1], [7, 2], [8, -3], [9, 44], [10, -5]];
    for (const [t, v] of cont) { a.add(t, v); b.add(t, v); }
    const bufA = new Float64Array(6), bufB = new Float64Array(6);
    const nA = a.sampleInto(bufA), nB = b.sampleInto(bufB);
    assert.equal(nA, nB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
    assert.equal(a.size, b.size);
    assert.equal(a.mode, b.mode);
});

test('reject-is-no-op (add): a backwards now does not advance the PRNG/landmark; A and B end identical', () => {
    const [a, b] = twins(6, 300, 11);
    const prefix = [[1, 10], [2, -5], [3, 0], [4, 22.5], [5, -8]];
    for (const [t, v] of prefix) { a.add(t, v); b.add(t, v); }
    const before = snapshotState(a);
    assert.throws(() => a.add(3, 999), /non-decreasing/);
    assertUnchanged(before, a);
    const cont = [[6, 1], [7, 2], [8, -3], [9, 44], [10, -5]];
    for (const [t, v] of cont) { a.add(t, v); b.add(t, v); }
    const bufA = new Float64Array(6), bufB = new Float64Array(6);
    const nA = a.sampleInto(bufA), nB = b.sampleInto(bufB);
    assert.equal(nA, nB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
    assert.equal(a.size, b.size);
    assert.equal(a.mode, b.mode);
});

test('reject-is-no-op (add): a mode-switch attempt does not advance the PRNG/landmark; A and B end identical', () => {
    const [a, b] = twins(6, 300, 13);
    const prefix = [[1, 10], [2, -5], [3, 0], [4, 22.5], [5, -8]];
    for (const [t, v] of prefix) { a.add(t, v); b.add(t, v); }
    assert.equal(a.mode, 'explicit');
    const before = snapshotState(a);
    assert.throws(() => a.add(undefined, 999), /mode is locked to explicit/);
    assertUnchanged(before, a);
    const cont = [[6, 1], [7, 2], [8, -3], [9, 44], [10, -5]];
    for (const [t, v] of cont) { a.add(t, v); b.add(t, v); }
    const bufA = new Float64Array(6), bufB = new Float64Array(6);
    const nA = a.sampleInto(bufA), nB = b.sampleInto(bufB);
    assert.equal(nA, nB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
    assert.equal(a.size, b.size);
    assert.equal(a.mode, b.mode);
});

test('reject-is-no-op (addFrom): a non-Float64Array buf does not advance the PRNG/landmark; A and B end identical', () => {
    const [a, b] = twins(6, 300, 17);
    const prefix = [[1, 10], [2, -5], [3, 0], [4, 22.5], [5, -8]];
    for (const [t, v] of prefix) { feedFrom(a, t, v); feedFrom(b, t, v); }
    const before = snapshotState(a);
    assert.throws(() => a.addFrom([6, 999], 0), /Float64Array/);
    assertUnchanged(before, a);
    const cont = [[6, 1], [7, 2], [8, -3], [9, 44], [10, -5]];
    for (const [t, v] of cont) { feedFrom(a, t, v); feedFrom(b, t, v); }
    const bufA = new Float64Array(6), bufB = new Float64Array(6);
    const nA = a.sampleInto(bufA), nB = b.sampleInto(bufB);
    assert.equal(nA, nB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
    assert.equal(a.size, b.size);
    assert.equal(a.mode, b.mode);
});

test('reject-is-no-op (addFrom): an out-of-range i does not advance the PRNG/landmark; A and B end identical', () => {
    const [a, b] = twins(6, 300, 19);
    const prefix = [[1, 10], [2, -5], [3, 0], [4, 22.5], [5, -8]];
    for (const [t, v] of prefix) { feedFrom(a, t, v); feedFrom(b, t, v); }
    const before = snapshotState(a);
    const bad = new Float64Array([6, 999]);   // length 2: i=1 -> i+1=2 >= length -> out of range
    assert.throws(() => a.addFrom(bad, 1), /in-bounds/);
    assert.throws(() => a.addFrom(bad, -1), /in-bounds/);
    assertUnchanged(before, a);
    const cont = [[6, 1], [7, 2], [8, -3], [9, 44], [10, -5]];
    for (const [t, v] of cont) { feedFrom(a, t, v); feedFrom(b, t, v); }
    const bufA = new Float64Array(6), bufB = new Float64Array(6);
    const nA = a.sampleInto(bufA), nB = b.sampleInto(bufB);
    assert.equal(nA, nB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
    assert.equal(a.size, b.size);
    assert.equal(a.mode, b.mode);
});

test('reject-is-no-op (addFrom): a backwards now in the packed buf does not advance the PRNG/landmark; A/B identical', () => {
    const [a, b] = twins(6, 300, 23);
    const prefix = [[1, 10], [2, -5], [3, 0], [4, 22.5], [5, -8]];
    for (const [t, v] of prefix) { feedFrom(a, t, v); feedFrom(b, t, v); }
    const before = snapshotState(a);
    assert.throws(() => feedFrom(a, 3, 999), /non-decreasing/);
    assertUnchanged(before, a);
    const cont = [[6, 1], [7, 2], [8, -3], [9, 44], [10, -5]];
    for (const [t, v] of cont) { feedFrom(a, t, v); feedFrom(b, t, v); }
    const bufA = new Float64Array(6), bufB = new Float64Array(6);
    const nA = a.sampleInto(bufA), nB = b.sampleInto(bufB);
    assert.equal(nA, nB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
    assert.equal(a.size, b.size);
    assert.equal(a.mode, b.mode);
});

test('addFrom rejects a null/undefined buf and a null/undefined index (byte-identical no-op)', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    assert.throws(() => r.addFrom(null, 0), /Float64Array/);
    assert.throws(() => r.addFrom(undefined, 0), /Float64Array/);
    assert.throws(() => r.addFrom(new Float64Array([1, 2]), null), /in-bounds/);
    assert.throws(() => r.addFrom(new Float64Array([1, 2]), undefined), /in-bounds/);
    assert.equal(r.size, 0);
});

// ---------------------------------------------------------------------------
// 9. determinism / seed distinctness
// ---------------------------------------------------------------------------
test('same seed + same stream -> identical sample (deterministic)', () => {
    const stream = [];
    const rng = mulberry32(555);
    for (let t = 1; t <= 200; t++) stream.push([t, rng() * 200 - 100]);
    const a = new DecayedReservoir(10, 400, { seed: 99 });
    const b = new DecayedReservoir(10, 400, { seed: 99 });
    for (const [t, v] of stream) { a.add(t, v); b.add(t, v); }
    const bufA = new Float64Array(10), bufB = new Float64Array(10);
    a.sampleInto(bufA); b.sampleInto(bufB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
});

test('a different seed generally yields a different sample; seed=0 is distinct from the default seed', () => {
    const stream = [];
    const rng = mulberry32(777);
    for (let t = 1; t <= 200; t++) stream.push([t, rng() * 200 - 100]);
    const a = new DecayedReservoir(10, 400, { seed: 1 });
    const b = new DecayedReservoir(10, 400, { seed: 2 });
    const c = new DecayedReservoir(10, 400, { seed: 0 });
    const d = new DecayedReservoir(10, 400);   // default seed
    for (const [t, v] of stream) { a.add(t, v); b.add(t, v); c.add(t, v); d.add(t, v); }
    const bufA = new Float64Array(10), bufB = new Float64Array(10), bufC = new Float64Array(10), bufD = new Float64Array(10);
    a.sampleInto(bufA); b.sampleInto(bufB); c.sampleInto(bufC); d.sampleInto(bufD);
    assert.notDeepEqual(Array.from(bufA), Array.from(bufB));
    assert.notDeepEqual(Array.from(bufC), Array.from(bufD));
});

// ---------------------------------------------------------------------------
// 10. long-idle-then-resume (guards the double-rebase nit)
// ---------------------------------------------------------------------------
test('long-idle-then-resume: a huge time jump keeps the sample well-defined and deterministic', () => {
    function runOnce() {
        const r = new DecayedReservoir(8, 500, { seed: 31 });
        for (let t = 1; t <= 50; t++) r.add(t, t * 3 - 20);
        r.add(1e12, 999999);            // ~1e12 later -- forces a landmark rebase
        for (let t = 1e12 + 1; t <= 1e12 + 50; t++) r.add(t, t % 17 - 8);
        const buf = new Float64Array(8);
        const n = r.sampleInto(buf);
        return { n, values: Array.from(buf.subarray(0, n)), size: r.size };
    }
    const run1 = runOnce();
    const run2 = runOnce();
    assert.ok(run1.size <= 8);
    for (const v of run1.values) assert.ok(Number.isFinite(v), 'no NaN in the sample after a long idle gap');
    assert.deepEqual(run1, run2, 'deterministic for a fixed seed across two runs');
});

// ---------------------------------------------------------------------------
// -0 axis (numeric -0 must be treated identically to 0 everywhere, not a distinct state)
// ---------------------------------------------------------------------------
test('seed = -0 behaves identically to seed = 0 (numeric -0 === 0)', () => {
    const a = new DecayedReservoir(4, 100, { seed: -0 });
    const b = new DecayedReservoir(4, 100, { seed: 0 });
    assert.equal(a.seed, 0);
    assert.equal(b.seed, 0);
    for (let t = 1; t <= 10; t++) { a.add(t, t); b.add(t, t); }
    const bufA = new Float64Array(4), bufB = new Float64Array(4);
    a.sampleInto(bufA); b.sampleInto(bufB);
    assert.deepEqual(Array.from(bufA), Array.from(bufB));
});

test('now = -0 is accepted as the anchor time (numeric -0 === 0, not a distinct state)', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(-0, 7);
    assert.equal(r.mode, 'explicit');
    assert.equal(r._lastNow, -0);
    r.add(0, 8);   // 0 is not < -0 numerically -- must be accepted, not a monotone violation
    assert.equal(r.size, 2);
});

test('value = -0 is accepted and treated as a normal finite value (not a distinct rejected state)', () => {
    const r = new DecayedReservoir(4, 100, { seed: 1 });
    r.add(1, -0);
    const buf = new Float64Array(4);
    const n = r.sampleInto(buf);
    assert.equal(n, 1);
    assert.ok(buf[0] === 0, 'stored value must be numerically 0 (== -0), got ' + buf[0]);   // avoid
    // assert.equal's Object.is-based strict comparison, which treats -0 !== 0.
});

// ---------------------------------------------------------------------------
// boundary matrix: k = 1 (single-slot reservoir)
// ---------------------------------------------------------------------------
test('k = 1 (a single-slot reservoir): admits/evicts correctly, never over- or under-fills', () => {
    const r = new DecayedReservoir(1, 100, { seed: 5 });
    for (let t = 1; t <= 20; t++) r.add(t, t);
    assert.equal(r.size, 1);
    const buf = new Float64Array(1);
    assert.equal(r.sampleInto(buf), 1);
    assert.ok(Number.isFinite(buf[0]));
});

// ---------------------------------------------------------------------------
// ADVERSARIAL (the case not called out by the numbered spec): a re-entrant add() fired from
// INSIDE a forEach callback. forEach captures `n` once and reads `val[i]` in a tight loop; add()
// mutates `_val` / `_pri` in place (either an in-place insert while n < k, or an in-place root
// replace once full). This proves the class stays well-defined (no crash, no NaN, no size
// over/under-flow) under a re-entrant write during iteration, rather than merely asserting the
// alloc-free contract that torture.mjs already covers.
// ---------------------------------------------------------------------------
test('ADVERSARIAL: a re-entrant add() from inside forEach does not crash and stays well-defined', () => {
    const r = new DecayedReservoir(4, 100, { seed: 9 });
    for (let t = 1; t <= 4; t++) r.add(t, t);   // fill to capacity
    let reentered = false;
    assert.doesNotThrow(() => {
        r.forEach((v) => {
            if (!reentered) {
                reentered = true;
                r.add(5, 999);   // re-entrant write DURING iteration (mutates _val/_pri in place)
            }
        });
    });
    assert.ok(reentered);
    assert.equal(r.size, r.k);   // size stays sample-capped
    const buf = new Float64Array(r.k);
    const n = r.sampleInto(buf);
    for (let i = 0; i < n; i++) assert.ok(Number.isFinite(buf[i]), 'every sampled value stays finite after a re-entrant write');
});
