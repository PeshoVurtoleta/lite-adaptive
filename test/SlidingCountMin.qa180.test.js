// @zakkster/lite-adaptive -- QA boundary matrix for the 1.8.0 SlidingCountMin readers total(w?) and
// estimateInto(keys, out, w?) (node:test). 0 / 1 / N-1 / N / N+1, empty, null, undefined, NaN, -0,
// duplicate clear, clear-during-iteration, re-entrant write, and adversarial cases (detached buffers,
// disjoint views of one buffer, saturated cells with an exact total). Oracles use the TRUE grid
// geometry recomputed from raw item times (never the sketch's own paneEnd ring), plus the true
// (now - w, now] window as a two-sided bound. Test-only: Adaptive.js is not touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingCountMin } from '../Adaptive.js';

const SAT = 4294967295;
const MAX_SAFE = 9007199254740991;
const W = 800, PANES = 8, PW = W / PANES;   // PW = 100, exact

function mk(opts) { return new SlidingCountMin(W, { panes: PANES, w: 64, d: 4, seed: 9, ...opts }); }

// ---------------------------------------------------------------------------
// total(w?) -- the w axis: undefined / N-1 / N / N+1 / 0 / -0 / NaN / null / +-Infinity / non-number
// ---------------------------------------------------------------------------
test('total(w) w-axis boundary matrix on a populated instance', () => {
    const s = mk();
    for (let t = 0; t < 2000; t += 3) s.add(t, t % 17, 1 + (t % 4));
    const full = s.total();
    assert.ok(full > 0 && Number.isInteger(full));
    assert.equal(s.total(undefined), full, 'undefined == omitted');
    assert.equal(s.total(W), full, 'w = W (N) == full window');
    assert.ok(Number.isFinite(s.total(W - 1e-9)), 'w = W - eps (N-1) valid');
    assert.ok(Number.isNaN(s.total(W + 1e-9)), 'w = W + eps (N+1) NaN');
    assert.ok(Number.isNaN(s.total(W * 2)), 'w = 2W NaN');
    for (const bad of [0, -0, -1, NaN, null, Infinity, -Infinity, '100', true, {}, [], 10n]) {
        assert.ok(Number.isNaN(s.total(bad)), 'bad w ' + String(bad) + ' -> NaN');
    }
    const tiny = s.total(Number.MIN_VALUE);
    assert.ok(Number.isFinite(tiny) && tiny >= 0 && tiny <= full, 'w = MIN_VALUE is a valid (current-pane) window');
});

test('total(w) on an UNSET instance: 0 for a valid/omitted w, NaN for every bad w (fail closed)', () => {
    const s = mk();
    assert.equal(s.total(), 0);
    assert.equal(s.total(W), 0);
    assert.equal(s.total(1), 0);
    for (const bad of [0, -0, NaN, null, W + 1, Infinity, 'x']) assert.ok(Number.isNaN(s.total(bad)), String(bad));
});

// TRUE-geometry oracle: an item at time t sits in the grid pane ending at (floor(t/PW)+1)*PW; the
// covered span for w is every pane whose end > now - w. Also bounded by the TRUE window counts:
// true(now - w, now] <= total(w) <= true(now - w - PW, now].
test('total(w) == the grid-geometry oracle and is bounded by the TRUE window, at w = PW, 2PW, W/4, W/2, W, and odd w', () => {
    const s = mk();
    const times = [], counts = [];
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    let now = 0, viol = 0, checks = 0;
    for (let i = 0; i < 4000; i++) {
        now += Math.floor(rnd() * 4) * 0.5;               // 0 .. 1.5, exact halves (some same-time adds)
        const c = 1 + Math.floor(rnd() * 9);
        s.add(now, i % 31, c);
        times.push(now); counts.push(c);
        if (i % 97 === 0) {
            for (const w of [PW, 2 * PW, W / 4, W / 2, W, 137.5, Number.MIN_VALUE]) {
                let geo = 0, lo = 0, hi = 0;
                for (let k = 0; k < times.length; k++) {
                    const t = times[k];
                    if ((Math.floor(t / PW) + 1) * PW > now - w) geo += counts[k];
                    if (t > now - w) lo += counts[k];
                    if (t > now - w - PW) hi += counts[k];
                }
                const got = s.total(w);
                checks++;
                if (got !== geo || got < lo || got > hi) viol++;
            }
        }
    }
    assert.ok(checks > 250);
    assert.equal(viol, 0, 'total(w) violations over ' + checks + ' checks');
});

test('total() is EXACT past cell saturation: 2^32-1 in one pane plus more adds (cells clip, total does not)', () => {
    const s = mk();
    s.add(10, 42, SAT);
    s.add(10, 42, 5);                   // same pane, same key: the cells stay clipped at SAT
    s.add(11, 43, SAT);
    assert.equal(s.estimate(42), SAT, 'the cell saturates');
    assert.ok(s.saturated >= 1);
    assert.equal(s.total(), SAT + 5 + SAT, 'total exact: 2*(2^32-1) + 5');
    // many saturating adds: still exact well past 2^32 (and below 2^53)
    const b = mk();
    for (let i = 0; i < 1000; i++) b.add(5, i, SAT);
    assert.equal(b.total(), 1000 * SAT);
    assert.equal(b.total(PW), 1000 * SAT, 'w = one pane width covers the single live pane');
});

test('total() slides with advance(): exact at w = PW after a partial slide, 0 after >= W + PW idle', () => {
    const s = mk();
    s.add(50, 1, 7);      // pane [0,100)
    s.add(150, 2, 11);    // pane [100,200)
    s.advance(250);       // current pane [200,300)
    assert.equal(s.total(PW), 11, 'w = PW at now=250 covers panes ending > 150 -> [100,200) + current');
    assert.equal(s.total(), 18);
    s.advance(250 + W + PW);
    assert.equal(s.total(), 0);
    assert.equal(s.total(Number.MIN_VALUE), 0);
});

test('total(): duplicate clear() -> 0 and NaN for bad w; re-populate afterwards is exact', () => {
    const s = mk();
    s.add(1, 1, 3); s.clear(); s.clear();
    assert.equal(s.total(), 0);
    assert.ok(Number.isNaN(s.total(-0)));
    s.add(1000, 5, 4);
    assert.equal(s.total(), 4, 'no leftover total from before clear()');
});

test('total() in COUNT mode (W measured in items) is exact over the covered item span', () => {
    const s = new SlidingCountMin(64, { panes: 4, w: 32, d: 2, seed: 1 });
    for (let i = 0; i < 64; i++) s.add(undefined, i, 2);
    assert.equal(s.total(), 128, 'first W items all live');
    for (let i = 0; i < 1000; i++) s.add(undefined, i, 1);
    const t = s.total();
    assert.ok(t >= 64 && t <= 64 + 16, 'covered span in [W, W + W/B] items -> ' + t);
});

// ---------------------------------------------------------------------------
// estimateInto -- n axis, containers, keys, w, aliasing, re-entrancy, adversarial
// ---------------------------------------------------------------------------
function populated() {
    const s = mk();
    for (let i = 0; i < 3000; i++) s.add(i * 0.25, (i * 7) % 50 - 25 + (i % 5 === 0 ? 2 ** 40 : 0), 1 + (i % 3));
    return s;
}

test('estimateInto n = 0 (empty Float64Arrays): returns 0, never throws, also with a bad w and on an unset instance', () => {
    const s = populated();
    const e = new Float64Array(0);
    assert.equal(s.estimateInto(e, e), 0);
    assert.equal(s.estimateInto(e, new Float64Array(0), NaN), 0);
    assert.equal(mk().estimateInto(e, e), 0);
    assert.equal(s.estimateInto(e, new Float64Array(5)), 0, 'n = 0 with a longer out');
});

test('estimateInto out.length at N-1 / N / N+1 of keys.length: RangeError (untouched) / ok / ok with the tail untouched', () => {
    const s = populated();
    const keys = new Float64Array([1, 2, 3, 2 ** 40 + 5]);
    const short = new Float64Array(3).fill(-7);
    assert.throws(() => s.estimateInto(keys, short), RangeError);
    assert.deepEqual(Array.from(short), [-7, -7, -7], 'a rejected call writes nothing');
    const exact = new Float64Array(4);
    assert.equal(s.estimateInto(keys, exact), 4);
    const long = new Float64Array(5).fill(-7);
    assert.equal(s.estimateInto(keys, long), 4);
    assert.equal(long[4], -7, 'the slot past n is untouched');
    for (let j = 0; j < 4; j++) { assert.equal(exact[j], s.estimate(keys[j])); assert.equal(long[j], exact[j]); }
    // n = 1
    const one = new Float64Array(1);
    assert.equal(s.estimateInto(new Float64Array([2]), one), 1);
    assert.equal(one[0], s.estimate(2));
});

test('estimateInto container door: null / undefined / Array / Float32Array / DataView keys or out throw TypeError, nothing written', () => {
    const s = populated();
    const ok = new Float64Array(2), out = new Float64Array(2).fill(-3);
    for (const bad of [null, undefined, [1, 2], new Float32Array(2), new DataView(new ArrayBuffer(16)), 0, 'x']) {
        assert.throws(() => s.estimateInto(bad, out), TypeError);
        assert.throws(() => s.estimateInto(ok, bad), TypeError);
    }
    assert.deepEqual(Array.from(out), [-3, -3]);
    assert.throws(() => s.estimateInto(), TypeError);
});

test('estimateInto key axis: NaN / +-Infinity / 1.5 / +-2^53 -> NaN; -0 == 0; +-(2^53-1) valid -- each == estimate()', () => {
    const s = populated();
    s.add(1000, 0, 4); s.add(1000, MAX_SAFE, 2); s.add(1000, -MAX_SAFE, 3);
    const keys = new Float64Array([NaN, Infinity, -Infinity, 1.5, 2 ** 53, -(2 ** 53), -0, 0, MAX_SAFE, -MAX_SAFE, 7]);
    const out = new Float64Array(keys.length);
    s.estimateInto(keys, out);
    for (let j = 0; j < 6; j++) assert.ok(Number.isNaN(out[j]), 'slot ' + j + ' NaN');
    assert.equal(out[6], out[7], '-0 key reads as key 0');
    assert.ok(out[7] >= 4);
    for (let j = 0; j < keys.length; j++) assert.ok(Object.is(out[j], s.estimate(keys[j])), 'slot ' + j + ' == estimate');
});

test('estimateInto w axis: undefined ok; null / 0 / -0 / NaN / W+eps / Infinity / "5" fill ALL slots NaN and return n; == estimate(key, w)', () => {
    const s = populated();
    const keys = new Float64Array([1, 2, 2 ** 40, NaN]);
    const out = new Float64Array(4);
    for (const bad of [null, 0, -0, NaN, W + 1e-9, Infinity, -Infinity, '5', -5]) {
        out.fill(123);
        assert.equal(s.estimateInto(keys, out, bad), 4);
        for (let j = 0; j < 4; j++) {
            assert.ok(Number.isNaN(out[j]), 'w=' + String(bad) + ' slot ' + j);
            assert.ok(Number.isNaN(s.estimate(keys[j], bad)), 'estimate parity w=' + String(bad));
        }
    }
    for (const w of [undefined, W, W - 1e-9, PW, Number.MIN_VALUE]) {
        s.estimateInto(keys, out, w);
        for (let j = 0; j < 4; j++) assert.ok(Object.is(out[j], s.estimate(keys[j], w)), 'w=' + w + ' slot ' + j);
    }
});

test('estimateInto keys === out (same array): each slot == estimate of the ORIGINAL key', () => {
    const s = populated();
    const orig = [1, -3, 2 ** 40 + 5, NaN, -0, 999999, 2 ** 40];
    const buf = new Float64Array(orig);
    assert.equal(s.estimateInto(buf, buf), orig.length);
    for (let j = 0; j < orig.length; j++) assert.ok(Object.is(buf[j], s.estimate(orig[j])), 'slot ' + j);
});

test('ADVERSARIAL: DISJOINT views of ONE ArrayBuffer (keys = [0,n), out = [n,2n)) are correct (only partial overlap is unsupported)', () => {
    const s = populated();
    const ab = new Float64Array(16);
    const keys = ab.subarray(0, 8), out = ab.subarray(8, 16);
    for (let j = 0; j < 8; j++) keys[j] = j * 3 - 9 + (j & 1 ? 2 ** 40 : 0);
    s.estimateInto(keys, out);
    for (let j = 0; j < 8; j++) assert.ok(Object.is(out[j], s.estimate(keys[j])));
    // out BEFORE keys in the same buffer, offset views
    const out2 = ab.subarray(0, 8), keys2 = ab.subarray(8, 16);
    const snap = Array.from(keys2);
    s.estimateInto(keys2, out2);
    for (let j = 0; j < 8; j++) assert.ok(Object.is(out2[j], s.estimate(snap[j])));
});

test('ADVERSARIAL: a DETACHED keys buffer reads as n = 0; a DETACHED out buffer is a RangeError (fail closed, no write)', () => {
    const s = populated();
    const kab = new ArrayBuffer(8 * 4);
    const keys = new Float64Array(kab);
    structuredClone(kab, { transfer: [kab] });          // detach
    assert.equal(keys.length, 0);
    assert.equal(s.estimateInto(keys, new Float64Array(4)), 0);
    const oab = new ArrayBuffer(8 * 4);
    const out = new Float64Array(oab);
    structuredClone(oab, { transfer: [oab] });
    assert.throws(() => s.estimateInto(new Float64Array([1, 2]), out), RangeError);
});

test('estimateInto on an UNSET instance: valid keys 0, invalid keys NaN, bad w all NaN (== estimate)', () => {
    const s = mk();
    const keys = new Float64Array([0, -0, 1, NaN, 1.5, MAX_SAFE]);
    const out = new Float64Array(6);
    s.estimateInto(keys, out);
    assert.deepEqual(Array.from(out).map((v) => (Number.isNaN(v) ? 'NaN' : v)), [0, 0, 0, 'NaN', 'NaN', 0]);
    s.estimateInto(keys, out, 0);
    assert.ok(Array.from(out).every(Number.isNaN));
    for (let j = 0; j < 6; j++) assert.ok(Number.isNaN(s.estimate(keys[j], 0)));
});

// 1.10.0 H2-4: a re-entrant clear() through the keys get trap can no longer race the read loop -- a
// Proxy container is rejected at the door, before any element (hence any trap) is read.
test('estimateInto: a Proxy keys whose get trap calls clear() is rejected (1.10.0 H2-4)', () => {
    const s = populated();
    const raw = new Float64Array([1, 2, 3, 4, 5, 6]);
    let traps = 0;
    const keys = new Proxy(raw, { get(tgt, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) { traps++; s.clear(); s.clear(); }
        const v = Reflect.get(tgt, prop); return typeof v === 'function' ? v.bind(tgt) : v; } });
    const out = new Float64Array(6).fill(-7);
    const snap = (o) => { const t = {}; for (const k of Object.keys(o)) { const v = o[k]; t[k] = ArrayBuffer.isView(v) ? Array.from(v) : v; } return t; };
    const before = snap(s);
    assert.throws(() => s.estimateInto(keys, out),
        (e) => e instanceof TypeError && /^\[lite-adaptive\] SlidingCountMin\.estimateInto\(keys, out, w\?\) keys must be a Float64Array/.test(e.message));
    assert.equal(traps, 0, 'the get trap never ran -- rejection precedes the first read');
    assert.deepEqual(snap(s), before, 'instance state is byte-identical after the rejection');
    for (let j = 0; j < 6; j++) assert.equal(out[j], -7, 'out slot ' + j + ' untouched');
});

// 1.10.0 H2-4: the sharpest re-entrancy -- a same-instance add() in the get trap -- is now impossible:
// the Proxy keys is rejected before the loop, so the write can never interleave a half-written read.
test('estimateInto: a Proxy keys whose get trap re-enters add() on the SAME instance is rejected (1.10.0 H2-4)', () => {
    const s = mk();
    s.add(10, 1, 1);
    const raw = new Float64Array([5, 5, 5]);
    let traps = 0;
    const keys = new Proxy(raw, { get(tgt, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) { traps++; s.add(10, 5, 100); }
        const v = Reflect.get(tgt, prop); return typeof v === 'function' ? v.bind(tgt) : v; } });
    const out = new Float64Array(3).fill(-7);
    const snap = (o) => { const t = {}; for (const k of Object.keys(o)) { const v = o[k]; t[k] = ArrayBuffer.isView(v) ? Array.from(v) : v; } return t; };
    const before = snap(s);
    assert.throws(() => s.estimateInto(keys, out),
        (e) => e instanceof TypeError && /^\[lite-adaptive\] SlidingCountMin\.estimateInto\(keys, out, w\?\) keys must be a Float64Array/.test(e.message));
    assert.equal(traps, 0, 'the get trap never ran -- no re-entrant write could interleave the read');
    assert.deepEqual(snap(s), before, 'instance state is byte-identical after the rejection');
    for (let j = 0; j < 3; j++) assert.equal(out[j], -7, 'out slot ' + j + ' untouched');
    assert.equal(s.total(), 1, 'the re-entrant add(10, 5, 100) never happened');
});

test('estimateInto == estimate on 100% of (key, w) incl. unset + bad w, across fill/slide/clear (randomized, >= 5000 pairs)', () => {
    let seed = 777;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const pool = [0, -0, 1, -1, 2 ** 31 - 1, 2 ** 31, 2 ** 32, -(2 ** 31) - 1, MAX_SAFE, -MAX_SAFE, NaN, 1.5, Infinity, 2 ** 53];
    const WS = [undefined, W, W / 2, W / 4, PW, 1, Number.MIN_VALUE, 0, -0, NaN, null, W + 1, -1];
    const s = mk({ conservative: false });
    const keys = new Float64Array(pool.length), out = new Float64Array(pool.length);
    let pairs = 0, bad = 0, now = 0;
    for (let round = 0; round < 40; round++) {
        if (round === 20) s.clear();
        if (round % 7 !== 0) for (let i = 0; i < 200; i++) { now += rnd() * 3; s.add(now, pool[(rnd() * 10) | 0], 1 + ((rnd() * 5) | 0)); }
        if (round % 5 === 4) { now += W * rnd() * 2; s.advance(now); }
        for (let j = 0; j < pool.length; j++) keys[j] = pool[(rnd() * pool.length) | 0];
        for (const w of WS) {
            s.estimateInto(keys, out, w);
            for (let j = 0; j < pool.length; j++) { pairs++; if (!Object.is(out[j], s.estimate(keys[j], w))) bad++; }
        }
    }
    // the unset + bad-w corner explicitly
    const u = mk();
    for (const w of WS) { u.estimateInto(keys, out, w); for (let j = 0; j < pool.length; j++) { pairs++; if (!Object.is(out[j], u.estimate(keys[j], w))) bad++; } }
    assert.ok(pairs >= 5000, 'pairs ' + pairs);
    assert.equal(bad, 0, 'mismatches ' + bad + ' / ' + pairs);
});
