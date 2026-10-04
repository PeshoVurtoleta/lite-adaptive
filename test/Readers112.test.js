// @zakkster/lite-adaptive -- v1.12.0 SlidingCountMin.totalInto(out, w?) -> 1 contract (ROADMAP 14).
//   node --test test/Readers112.test.js
//
// totalInto is the 0-alloc render sibling of total(): it writes total(w) into out[0] (Object.is-
// identical) and returns 1, under the same S1 / S2 COLD-reader contract as SlidingHyperLogLog.countInto
// (T-S1). The allocation side (0 B/op with N >= 2^31 even under --no-turbo-inlining, with a total()
// must-box control) is gated in test/perf/AllocMatrix.test.mjs (queryLanes + noInlineLargeKey) and in
// test/torture.mjs. ASCII-only; node:test only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingCountMin } from '../Adaptive.js';

const SAT = 4294967295;

// a deterministic LCG in [0, 1)
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
}

// an explicit-time SCM over a live, rotating window (epoch-ms clock, fractional steps)
function makeExplicit(W, panes, n, seed) {
    const scm = new SlidingCountMin(W, { panes, w: 128, d: 4, seed });
    const rnd = lcg(seed);
    let clk = 1.75e12;
    for (let k = 0; k < n; k++) { clk += 0.25 + rnd() * 3; scm.add(clk, (k * 2654435761) >>> 0, 1 + ((k * 7) & 15)); }
    return scm;
}

/** Assert totalInto(out, w) writes exactly total(w) into out[0], returns 1, and touches no other slot. */
function checkParity(scm, w, out, tag) {
    out[1] = 7.5;                                       // a sentinel: only slot 0 may be written
    const expect = w === undefined ? scm.total() : scm.total(w);
    const ret = w === undefined ? scm.totalInto(out) : scm.totalInto(out, w);
    assert.equal(ret, 1, tag + ': totalInto must return 1');
    assert.ok(Object.is(out[0], expect), tag + ': out[0] (' + out[0] + ') !== total(' + w + ') (' + expect + ')');
    assert.ok(Object.is(out[1], 7.5), tag + ': slot 1 was written');
}

test('SCM totalInto: out[0] Object.is total(w) over 10k queries on a live explicit-time window (full / in-range incl. w < pane width / bad w)', () => {
    const W = 1000, panes = 16, pw = W / panes;
    const scm = makeExplicit(W, panes, 5000, 11);
    const rnd = lcg(0x2545f491);
    const out = new Float64Array(2);
    for (let i = 0; i < 10000; i++) {
        const r = rnd();
        let w;
        if (r < 0.15) w = undefined;                   // full window
        else if (r < 0.25) w = -rnd() * W;             // <= 0 -> NaN
        else if (r < 0.35) w = W * (1 + rnd());        // > W -> NaN
        else if (r < 0.40) w = NaN;                    // NaN -> NaN
        else if (r < 0.60) w = rnd() * pw;             // inside one (straddling) pane
        else w = rnd() * W;                            // in range
        checkParity(scm, w, out, 'q' + i + ' w=' + w);
    }
    // the exact pane-boundary sub-windows
    for (let k = 1; k <= panes; k++) checkParity(scm, k * pw, out, 'w = ' + k + ' panes');
    checkParity(scm, W, out, 'w = W');
});

test('SCM totalInto: N >= 2^31 (the heavy case total() boxes on) and saturated cells -- out[0] is the EXACT Float64 total, Object.is total()', () => {
    const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 });
    let clk = 1.75e12;
    for (let k = 0; k < 40; k++) { clk += 1.5; scm.add(clk, 12345, SAT); }       // the cells saturate; N does not
    for (let k = 0; k < 400; k++) { clk += 1.5; scm.add(clk, (k & 511) + 1, (k & 7) + 1); }
    const out = new Float64Array(2);
    checkParity(scm, undefined, out, 'heavy full');
    assert.ok(out[0] > 2 ** 31 && out[0] > 40 * SAT - 1, 'the heavy total is beyond 2^31 and exact past the cell saturation, got ' + out[0]);
    assert.ok(scm.saturated > 0, 'the cells did saturate (the total must not)');
    for (const w of [1, 62.5, 125, 500, 999.5, 1000]) checkParity(scm, w, out, 'heavy w=' + w);
});

test('SCM totalInto: COUNT-mode instances, idle advance() to empty, clear() back to unset -- Object.is total() at every step', () => {
    const out = new Float64Array(2);
    // count mode (no clock): every add is one tick
    const c = new SlidingCountMin(64, { panes: 8, w: 64, d: 3, seed: 5 });
    for (let k = 0; k < 500; k++) {
        c.add(undefined, k % 37, 1 + (k & 3));
        if ((k & 15) === 0) { checkParity(c, undefined, out, 'count k=' + k); checkParity(c, 9, out, 'count k=' + k + ' w=9'); }
    }
    assert.equal(c.mode, 'count');
    // explicit: an idle advance() rotates every pane out -> 0, still Object.is total()
    const e = makeExplicit(1000, 16, 2000, 3);
    checkParity(e, undefined, out, 'before idle');
    assert.ok(out[0] > 0);
    e.advance(e.lastNow + 500);
    checkParity(e, undefined, out, 'half-window idle');
    e.advance(e.lastNow + 5000);
    checkParity(e, undefined, out, 'fully idle');
    assert.ok(Object.is(out[0], 0), 'a fully slid window reads +0');
    // clear() -> unset -> 0
    e.clear();
    checkParity(e, undefined, out, 'after clear');
    assert.ok(Object.is(out[0], 0));
});

test('SCM totalInto: a bad sub-window writes NaN and returns 1 (never a throw), on a live AND an UNSET instance (the w check precedes the unset return)', () => {
    const live = makeExplicit(1000, 16, 500, 9);
    const unset = new SlidingCountMin(1000, { panes: 16 });
    const out = new Float64Array(1);
    for (const bad of [0, -0, -1, Infinity, -Infinity, NaN, 1000.0001, 1e18, 'x', null, true, {}]) {
        for (const [scm, tag] of [[live, 'live'], [unset, 'unset']]) {
            out[0] = 123;
            assert.equal(scm.totalInto(out, bad), 1, tag + ' bad w=' + String(bad) + ' must return 1');
            assert.ok(Number.isNaN(out[0]), tag + ' bad w=' + String(bad) + ' must write NaN, got ' + out[0]);
            assert.ok(Object.is(out[0], scm.total(bad)), tag + ' bad w=' + String(bad) + ': != total(bad)');
        }
    }
    // an UNSET instance with a good / omitted w writes +0
    out[0] = 123;
    assert.equal(unset.totalInto(out), 1);
    assert.ok(Object.is(out[0], 0), 'unset must write +0');
    out[0] = 123;
    unset.totalInto(out, 500);
    assert.ok(Object.is(out[0], 0), 'unset with a good w must write +0');
});

test('SCM totalInto: container rejects per S2 (Proxy / non-F64 / DataView / prototype-swapped Uint8Array -> TypeError; length 0 -> RangeError; out untouched on a throw; a lying-length subclass over a valid backing is accepted and its getter never runs)', () => {
    const scm = makeExplicit(1000, 16, 500, 13);
    const bad = [
        new Proxy(new Float64Array(1), {}), new Float32Array(1), [0], new DataView(new ArrayBuffer(8)),
        null, undefined, 1, 'x',
    ];
    const swapped = new Uint8Array(8).fill(7);           // 7s, not 0s: a stray NaN / 0 write would show
    Object.setPrototypeOf(swapped, Float64Array.prototype);
    bad.push(swapped);
    for (const b of bad) {
        assert.throws(() => scm.totalInto(b), (e) => e instanceof TypeError && /\[lite-adaptive\] SlidingCountMin\.totalInto/.test(e.message),
            'container ' + Object.prototype.toString.call(b) + ' must throw the tagged TypeError');
    }
    assert.throws(() => scm.totalInto(swapped, -1), TypeError, 'swapped + bad w: still the container TypeError');
    assert.ok(swapped.every((x) => x === 7), 'the prototype-swapped Uint8Array is untouched (also with a bad w)');
    assert.throws(() => scm.totalInto(new Float64Array(0)), (e) => e instanceof RangeError && /totalInto/.test(e.message), 'length 0 -> RangeError');
    // review N4: a rejected container is NEVER written -- not even the bad-w NaN (no write-then-throw), for
    // every bad-w form and the good-w path, on a live AND an unset instance
    const unset = new SlidingCountMin(1000, { panes: 16 });
    for (const inst of [scm, unset]) {
        for (const w of [undefined, 500, -1, NaN, 'x']) {
            const f32 = new Float32Array(2).fill(7);
            assert.throws(() => inst.totalInto(f32, w), TypeError, 'Float32Array w=' + String(w));
            assert.ok(f32[0] === 7 && f32[1] === 7, 'Float32Array w=' + String(w) + ' was written before the throw: ' + Array.from(f32));
            const plain = [7, 7];
            assert.throws(() => inst.totalInto(plain, w), TypeError, 'plain array w=' + String(w));
            assert.deepEqual(plain, [7, 7], 'plain array w=' + String(w) + ' was written before the throw');
        }
    }
    // a lying-length subclass over a VALID length-1 backing: the intrinsic length sees 1 -> accepted
    const flag = { touched: false };
    class Lie extends Float64Array { get length() { flag.touched = true; return NaN; } }
    const v = new Lie(1);
    assert.equal(scm.totalInto(v), 1);
    assert.ok(Object.is(v[0], scm.total()), 'lying-length backing: slot 0 holds total()');
    assert.equal(flag.touched, false, 'the OWN length getter must never run (intrinsic TA_LEN)');
});
