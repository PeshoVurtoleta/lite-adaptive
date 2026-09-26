// @zakkster/lite-adaptive -- ForwardDecay behavioral + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForwardDecay, VERSION } from '../Adaptive.js';

const LN2 = Math.LN2;

test('VERSION is the expected string', () => {
    assert.equal(VERSION, '1.7.0');
});

test('constructor validates halfLife fail-closed BEFORE any field init', () => {
    for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, '10', null, undefined, {}, 10n]) {
        assert.throws(() => new ForwardDecay(bad), /\[lite-adaptive\]/, 'halfLife=' + String(bad));
    }
    assert.doesNotThrow(() => new ForwardDecay(1000));
    assert.doesNotThrow(() => new ForwardDecay(1.5));   // fractional half-life is legal
});

test('F14: a subnormal halfLife that overflows lambda to Infinity throws tagged BEFORE any query', () => {
    // lambda = ln2 / halfLife = Infinity for a subnormal halfLife (e.g. 1e-320); it must be
    // rejected at construction (naming halfLife + the floor), not fail late at query time.
    assert.throws(() => new ForwardDecay(1e-320),
        /\[lite-adaptive\] ForwardDecay halfLife .* lambda .* is not finite; halfLife must be >=/);
    // The smallest halfLife that still yields a FINITE lambda is accepted (lambda = Number.MAX_VALUE).
    const floor = Math.LN2 / Number.MAX_VALUE;
    assert.ok(Math.LN2 / floor < Infinity);
    const fd = new ForwardDecay(floor);
    assert.ok(Number.isFinite(fd.lambda));
    // A tiny-but-normal halfLife works end to end (no NaN / non-finite accumulator).
    const fd2 = new ForwardDecay(2.3e-308);
    fd2.add(0, 1);
    assert.ok(Number.isFinite(fd2.count()));
});

test('constructor rejects an unknown option / non-object options', () => {
    assert.throws(() => new ForwardDecay(100, { nope: 1 }), /\[lite-adaptive\].*nope/);
    assert.throws(() => new ForwardDecay(100, 42), /\[lite-adaptive\]/);
    assert.throws(() => new ForwardDecay(100, null), /\[lite-adaptive\]/);
    assert.doesNotThrow(() => new ForwardDecay(100, {}));
    assert.doesNotThrow(() => new ForwardDecay(100, undefined));
});

test('getters expose the decay parameters; lambda = ln2 / halfLife', () => {
    const fd = new ForwardDecay(100);
    assert.equal(fd.halfLife, 100);
    assert.ok(Math.abs(fd.lambda - LN2 / 100) < 1e-15);
    assert.equal(fd.mode, 'unset');
    assert.equal(fd.landmark, 0);
});

test('getters never throw on an empty ForwardDecay; return 0 (null is not zero)', () => {
    const fd = new ForwardDecay(100);
    assert.equal(fd.count(), 0);
    assert.equal(fd.sum(), 0);
    assert.equal(fd.mean(), 0);
    assert.equal(fd.rate(), 0);
});

test('mode locks to explicit; a later count-mode add throws', () => {
    const fd = new ForwardDecay(100);
    fd.add(1);
    assert.equal(fd.mode, 'explicit');
    assert.throws(() => fd.add(), /\[lite-adaptive\].*locked to explicit/);
});

test('mode locks to count; a later explicit add throws', () => {
    const fd = new ForwardDecay(100);
    fd.add();
    assert.equal(fd.mode, 'count');
    assert.throws(() => fd.add(5), /\[lite-adaptive\].*locked to count/);
});

test('monotone now enforced: a decreasing now throws, a non-finite now throws', () => {
    const fd = new ForwardDecay(100);
    fd.add(10);
    fd.add(10);            // equal is allowed (non-decreasing)
    fd.add(20);
    assert.throws(() => fd.add(19), /\[lite-adaptive\].*non-decreasing/);
    assert.throws(() => fd.add(NaN), /\[lite-adaptive\]/);
    assert.throws(() => fd.add(Infinity), /\[lite-adaptive\]/);
});

test('add accepts any finite real value including signed + zero + fractional', () => {
    const fd = new ForwardDecay(100);
    assert.doesNotThrow(() => { fd.add(1, 0); fd.add(2, -5); fd.add(3, 3.14159); fd.add(4, -2.5e9); });
    // 4 events -> decayed count is 4 at the landmark-ish scale (all near-fresh, small lambda)
    assert.ok(fd.count() > 0);
});

test('add rejects a non-finite / non-number value fail-closed', () => {
    const fd = new ForwardDecay(100);
    for (const bad of [NaN, Infinity, -Infinity, '2', {}, 5n]) {
        assert.throws(() => fd.add(1, bad), /\[lite-adaptive\]/, 'value=' + String(bad));
    }
});

test('a signed value contributes to sum / mean but still counts as ONE decayed event', () => {
    // Two adds at the SAME time (no decay between them): count = 2, sum = 10 + (-4) = 6, mean = 3.
    const fd = new ForwardDecay(100);
    fd.add(0, 10);
    fd.add(0, -4);
    assert.ok(Math.abs(fd.count(0) - 2) < 1e-9, 'two events -> decayed count 2, got ' + fd.count(0));
    assert.ok(Math.abs(fd.sum(0) - 6) < 1e-9, 'sum = 10 + (-4) = 6, got ' + fd.sum(0));
    assert.ok(Math.abs(fd.mean(0) - 3) < 1e-9, 'mean = 6/2 = 3, got ' + fd.mean(0));
});

test('mean is landmark- and now-invariant (the age factor cancels)', () => {
    const fd = new ForwardDecay(50);
    fd.add(0, 2);
    fd.add(10, 8);
    const m0 = fd.mean(10);
    const m1 = fd.mean(10000);   // far-future query time
    assert.ok(Math.abs(m0 - m1) < 1e-9, 'mean must not depend on the query time');
});

test('decay: an old element weighs half as much after one half-life', () => {
    const H = 100;
    const fd = new ForwardDecay(H);
    fd.add(0, 1);           // one event at t=0
    fd.add(H, 1);           // one event exactly one half-life later
    // at query time t=H, the old event decayed by 1/2, the new one is full -> count = 1.5.
    assert.ok(Math.abs(fd.count(H) - 1.5) < 1e-9, 'decayed count = 0.5 + 1 = 1.5, got ' + fd.count(H));
});

test('a query time before the last add throws (can not un-decay)', () => {
    const fd = new ForwardDecay(100);
    fd.add(10);
    fd.add(20);
    assert.throws(() => fd.count(15), /\[lite-adaptive\].*query time/);
    assert.throws(() => fd.sum(19), /\[lite-adaptive\]/);
    assert.throws(() => fd.rate(0), /\[lite-adaptive\]/);
    assert.throws(() => fd.count(NaN), /\[lite-adaptive\]/);
    // a future query time is fine
    assert.doesNotThrow(() => fd.count(100));
});

test('count-mode auto-ticks; queries with no arg use the internal tick', () => {
    const fd = new ForwardDecay(1000);
    for (let i = 0; i < 10; i++) fd.add();   // count mode
    assert.equal(fd.mode, 'count');
    // all 10 events are recent relative to a 1000-tick half-life -> decayed count near 10.
    assert.ok(fd.count() > 9 && fd.count() <= 10, 'decayed count ~ 10, got ' + fd.count());
});

test('rate() ~ steady arrival rate for a long steady count-mode stream', () => {
    // one event per tick, half-life 100 -> lambda = ln2/100; decayedCount -> ~1/lambda,
    // so rate = decayedCount * lambda -> ~1 event/tick.
    const fd = new ForwardDecay(100);
    for (let i = 0; i < 20000; i++) fd.add();
    assert.ok(Math.abs(fd.rate() - 1) < 0.02, 'steady rate ~ 1/tick, got ' + fd.rate());
});

test('rebase over a long increasing-t stream keeps the aggregate finite + correct', () => {
    // drive t so lambda*(t-L) crosses FD_EXP_CAP many times; the accumulator must not
    // overflow and the decayed mean must stay exact.
    const H = 10;                            // lambda = ln2/10 ~ 0.0693; cap hit every ~577 t
    const fd = new ForwardDecay(H);
    let t = 0;
    for (let i = 0; i < 200000; i++) { t += 5; fd.add(t, 7); }
    assert.ok(Number.isFinite(fd.count()), 'count stays finite across rebases, got ' + fd.count());
    assert.ok(Number.isFinite(fd.sum()), 'sum stays finite across rebases');
    assert.ok(Math.abs(fd.mean() - 7) < 1e-9, 'constant value -> mean 7 exactly, got ' + fd.mean());
});

test('an ordinary large value at a large time does NOT overflow (the old FD_EXP_CAP=700 bug)', () => {
    // Regression: with cap 700, `add(0,1); add(700, 2e4)` overflowed Sv to Infinity because
    // arg=700 does not trip `> 700` and exp(700)*2e4 > Double.MAX. With cap 40 it stays finite.
    const fd = new ForwardDecay(Math.LN2);   // lambda = 1, so arg = (t - L) directly
    fd.add(0, 1);
    fd.add(700, 2e4);                        // arg would be 700 at the old cap
    assert.ok(Number.isFinite(fd.sum(700)), 'sum stays finite, got ' + fd.sum(700));
    assert.ok(Number.isFinite(fd.count(700)), 'count stays finite, got ' + fd.count(700));
    assert.ok(Number.isFinite(fd.mean(700)), 'mean stays finite, got ' + fd.mean(700));
    // the recent 2e4 dominates the decayed mean; the old 1 has decayed to ~0.
    assert.ok(Math.abs(fd.mean(700) - 2e4) < 1, 'decayed mean ~ 2e4, got ' + fd.mean(700));
});

test('a value near Double.MAX overflows the accumulator -> queries FAIL CLOSED (throw, not Infinity)', () => {
    // The pathological tail no cap can defend: a single term within exp(cap) of Double.MAX.
    // The query guard must THROW [lite-adaptive], never silently return Infinity / NaN.
    const fd = new ForwardDecay(100);
    fd.add(0, 1e308);
    assert.ok(Number.isFinite(fd.sum(0)), 'one 1e308 term is still finite');
    fd.add(0, 1e308);                        // 1e308 + 1e308 -> Infinity in Sv
    assert.throws(() => fd.sum(0), /\[lite-adaptive\].*non-finite/, 'sum() fails closed on overflow');
    assert.throws(() => fd.count(0), /\[lite-adaptive\].*non-finite/, 'count() fails closed on overflow');
    assert.throws(() => fd.mean(0), /\[lite-adaptive\].*non-finite/, 'mean() fails closed on overflow');
    assert.throws(() => fd.rate(0), /\[lite-adaptive\].*non-finite/, 'rate() fails closed on overflow');
    // clear() recovers the instance.
    fd.clear();
    assert.equal(fd.sum(), 0);
});

test('clear resets the accumulators + landmark and UNLOCKS the mode', () => {
    const fd = new ForwardDecay(100);
    fd.add(5, 3);
    fd.add(6, 4);
    assert.ok(fd.count(6) > 0);
    fd.clear();
    assert.equal(fd.count(), 0);
    assert.equal(fd.sum(), 0);
    assert.equal(fd.mean(), 0);
    assert.equal(fd.mode, 'unset');
    assert.equal(fd.landmark, 0);
    // usable again in a DIFFERENT mode after clear (mode was unlocked)
    assert.doesNotThrow(() => fd.add());
    assert.equal(fd.mode, 'count');
});

// --- addFrom: the zero-box packed [now, value] entry -------------------------------------

test('addFrom(buf, i) produces state IDENTICAL to add(now, value) across a stream (parity)', () => {
    const H = 50;
    const a = new ForwardDecay(H);   // driven by add(now, value)
    const b = new ForwardDecay(H);   // driven by addFrom(buf, i)
    const buf = new Float64Array(2);
    let now = 0;
    for (let i = 1; i <= 5000; i++) {
        now += 1.5;                              // fractional monotone time
        const v = i * 0.5 - 1234.75;             // fractional signed value
        a.add(now, v);
        buf[0] = now; buf[1] = v;
        b.addFrom(buf, 0);
    }
    assert.equal(b.landmark, a.landmark, 'landmark parity');
    assert.equal(b.count(now), a.count(now), 'decayed count parity');
    assert.equal(b.sum(now), a.sum(now), 'decayed sum parity');
    assert.equal(b.mean(now), a.mean(now), 'decayed mean parity');
    assert.equal(b.mode, a.mode);
});

test('addFrom parity holds through the landmark rebase (large exponent stream)', () => {
    const H = 0.01;   // lambda ~ 69.3 -> rebase fires often
    const a = new ForwardDecay(H);
    const b = new ForwardDecay(H);
    const buf = new Float64Array(2);
    let now = 0;
    for (let i = 1; i <= 4000; i++) {
        now += 11.5;                             // fractional step that crosses FD_EXP_CAP each add
        const v = (i & 7) + 0.5;
        a.add(now, v);
        buf[0] = now; buf[1] = v;
        b.addFrom(buf, 0);
    }
    assert.equal(b.landmark, a.landmark, 'landmark parity through rebase');
    assert.equal(b.count(now), a.count(now), 'count parity through rebase');
    assert.equal(b.sum(now), a.sum(now), 'sum parity through rebase');
});

test('addFrom reads the pair at an arbitrary in-bounds base index (batch layout)', () => {
    const a = new ForwardDecay(100);
    const b = new ForwardDecay(100);
    const buf = new Float64Array([0, 0, 3.5, -2.5, 4.0, 1.5]);   // pairs at i = 2, 4
    a.add(3.5, -2.5); a.add(4.0, 1.5);
    b.addFrom(buf, 2); b.addFrom(buf, 4);
    assert.equal(b.sum(4.0), a.sum(4.0));
    assert.equal(b.count(4.0), a.count(4.0));
});

test('addFrom rejects a non-Float64Array buf fail-closed', () => {
    const fd = new ForwardDecay(100);
    for (const bad of [[1, 2], new Float32Array([1, 2]), null, undefined, {}, 'x', new ArrayBuffer(16)]) {
        assert.throws(() => fd.addFrom(bad, 0), /\[lite-adaptive\]/, 'buf=' + String(bad));
    }
    assert.equal(fd.count(), 0, 'a rejected addFrom accumulated nothing');
    assert.equal(fd.mode, 'unset', 'a rejected addFrom did not lock the mode');
});

test('addFrom rejects a bad index (negative, non-integer, i+1 >= length) fail-closed', () => {
    const fd = new ForwardDecay(100);
    const buf = new Float64Array([1, 2]);
    for (const bad of [-1, 1.5, NaN, '0', 1, 2, 100]) {
        assert.throws(() => fd.addFrom(buf, bad), /\[lite-adaptive\]/, 'i=' + String(bad));
    }
    assert.equal(fd.count(), 0);
    assert.equal(fd.mode, 'unset');
});

test('addFrom accepts a signed / zero value at buf[i+1] (any finite real)', () => {
    const fd = new ForwardDecay(100);
    const buf = new Float64Array([0, 0]);
    // two adds at the same time: value 0 then -4 -> count 2, sum -4, mean -2.
    assert.doesNotThrow(() => fd.addFrom(buf, 0));   // value 0 is legal for FD
    buf[1] = -4;
    assert.doesNotThrow(() => fd.addFrom(buf, 0));
    assert.ok(Math.abs(fd.count(0) - 2) < 1e-9, 'two events -> decayed count 2');
    assert.ok(Math.abs(fd.sum(0) - (-4)) < 1e-9, 'sum = 0 + (-4) = -4');
    assert.ok(Math.abs(fd.mean(0) - (-2)) < 1e-9, 'mean = -4 / 2 = -2');
});

test('addFrom with NaN / Infinity in buf[i] or buf[i+1] is a byte-identical no-op', () => {
    const fd = new ForwardDecay(100);
    const buf = new Float64Array([5, 3]);
    fd.addFrom(buf, 0);                     // one good add -> explicit, _lastNow = 5
    const c = fd.count(5), s = fd.sum(5), lm = fd.landmark;
    // bad value (buf[i+1])
    for (const bad of [NaN, Infinity, -Infinity]) {
        buf[0] = 6; buf[1] = bad;
        assert.throws(() => fd.addFrom(buf, 0), /\[lite-adaptive\]/, 'value=' + String(bad));
    }
    // bad now (buf[i])
    for (const bad of [NaN, Infinity, -Infinity]) {
        buf[0] = bad; buf[1] = 3;
        assert.throws(() => fd.addFrom(buf, 0), /\[lite-adaptive\]/, 'now=' + String(bad));
    }
    assert.equal(fd.count(5), c, 'decayed count (C) unchanged');
    assert.equal(fd.sum(5), s, 'decayed sum (Sv) unchanged');
    assert.equal(fd.landmark, lm, 'landmark unchanged');
    // _lastNow not advanced: a valid now = 5 is still accepted
    buf[0] = 5; buf[1] = 1;
    assert.doesNotThrow(() => fd.addFrom(buf, 0), 'monotone guard not advanced by a rejected addFrom');
});

test('addFrom enforces monotone now: a decreasing buf[i] throws', () => {
    const fd = new ForwardDecay(100);
    const buf = new Float64Array([10, 1]);
    fd.addFrom(buf, 0);
    buf[0] = 10; fd.addFrom(buf, 0);        // equal is allowed
    buf[0] = 9.5;
    assert.throws(() => fd.addFrom(buf, 0), /\[lite-adaptive\].*non-decreasing/);
});

test('a rejected FIRST addFrom does not lock the mode', () => {
    const fd = new ForwardDecay(100);
    const buf = new Float64Array([5, NaN]);   // bad value on the very first addFrom
    assert.throws(() => fd.addFrom(buf, 0), /\[lite-adaptive\]/);
    assert.equal(fd.mode, 'unset', 'a rejected first addFrom must not lock the mode');
    assert.doesNotThrow(() => fd.add());
    assert.equal(fd.mode, 'count');
});

test('addFrom is explicit-time only: a count-locked instance rejects it, an addFrom-locked instance rejects count add()', () => {
    const counted = new ForwardDecay(100);
    counted.add();                           // locks COUNT mode
    const buf = new Float64Array([5, 1]);
    assert.throws(() => counted.addFrom(buf, 0), /\[lite-adaptive\].*locked to count/);

    const explicit = new ForwardDecay(100);
    explicit.addFrom(buf, 0);                // locks EXPLICIT mode via addFrom -> landmark = 5
    assert.equal(explicit.mode, 'explicit');
    assert.equal(explicit.landmark, 5, 'first addFrom sets the landmark to buf[i]');
    assert.throws(() => explicit.add(), /\[lite-adaptive\].*locked to explicit/);
});

test('addFrom returns this (chainable)', () => {
    const fd = new ForwardDecay(100);
    const buf = new Float64Array([1, 2]);
    assert.equal(fd.addFrom(buf, 0), fd);
});

// --- the M1 no-op regressions: a rejected add must be a BYTE-IDENTICAL no-op ----------

test('a rejected bad-value FIRST add does NOT lock the mode', () => {
    const fd = new ForwardDecay(100);
    assert.throws(() => fd.add(1, NaN), /\[lite-adaptive\]/);
    assert.equal(fd.mode, 'unset', 'a rejected first add must not lock the mode');
    // still free to choose count mode
    assert.doesNotThrow(() => fd.add());
    assert.equal(fd.mode, 'count');
});

test('a rejected add does NOT advance _lastNow (explicit mode)', () => {
    const fd = new ForwardDecay(100);
    fd.add(10);
    fd.add(20);
    // a bad value at t=25 must NOT record 25 as the last now
    assert.throws(() => fd.add(25, Infinity), /\[lite-adaptive\]/);
    // 21 is still a valid non-decreasing now (proving the guard was not advanced to 25)
    assert.doesNotThrow(() => fd.add(21));
});

test('a rejected add does NOT advance the count-mode tick or touch C/Sv', () => {
    const fd = new ForwardDecay(1000);
    fd.add(); fd.add(); fd.add();
    const c = fd.count(), s = fd.sum();
    assert.throws(() => fd.add(undefined, NaN), /\[lite-adaptive\]/);
    // the tick did not advance: the same three events, same decayed aggregates
    assert.equal(fd.count(), c, 'count unchanged after a rejected add');
    assert.equal(fd.sum(), s, 'sum unchanged after a rejected add');
    // a mode switch attempt is also a no-op
    assert.throws(() => fd.add(5), /\[lite-adaptive\]/);
    assert.equal(fd.count(), c, 'count unchanged after a rejected mode switch');
});

test('empty-summary query validates `now` fail-closed BEFORE the empty early-exit (T2)', () => {
    // A freshly-constructed summary is empty (C === 0) with the default query time _now = 0.
    // An invalid query-time argument must THROW, not be swallowed by the empty-state 0 return.
    const empty = new ForwardDecay(1000);
    for (const q of ['count', 'sum', 'mean', 'rate']) {
        for (const bad of [-1, NaN, Infinity, -Infinity, 'x', null, {}]) {
            assert.throws(() => empty[q](bad), /\[lite-adaptive\]/, q + '(' + String(bad) + ') on empty');
        }
        // valid use on empty still returns 0 (no arg, or a valid finite now >= _now === 0)
        assert.equal(empty[q](), 0, q + '() on empty is 0');
        assert.equal(empty[q](0), 0, q + '(0) on empty is 0');
        assert.equal(empty[q](5), 0, q + '(5) on empty is 0');
        // -0 is a valid finite number and -0 < 0 is false, so it is NOT rejected (-0 >= _now === 0).
        assert.equal(empty[q](-0), 0, q + '(-0) on empty is 0 (not thrown)');
        // undefined explicitly (as opposed to omitted) must resolve identically to omitted.
        assert.equal(empty[q](undefined), 0, q + '(undefined) on empty is 0');
    }
    // The same holds after clear() re-empties the summary.
    const cleared = new ForwardDecay(1000);
    cleared.add(); cleared.add();
    cleared.clear();
    assert.throws(() => cleared.count(-1), /\[lite-adaptive\]/, 'count(-1) after clear throws');
    assert.equal(cleared.count(), 0, 'count() after clear is 0');
});
