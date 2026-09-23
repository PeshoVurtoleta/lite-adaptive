// @zakkster/lite-adaptive -- ADWIN behavioral + drift + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADWIN, VERSION } from '../Adaptive.js';

/** A deterministic mulberry32 PRNG so every drift/false-alarm assertion is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('VERSION is the expected string', () => {
    assert.equal(VERSION, '0.2.0');
});

test('constructor validates delta fail-closed BEFORE allocation', () => {
    for (const bad of [0, 1, 1.5, -0.1, NaN, Infinity, -Infinity, '0.1', null, undefined, {}, 10n]) {
        assert.throws(() => new ADWIN(bad), /\[lite-adaptive\]/, 'delta=' + String(bad));
    }
    assert.doesNotThrow(() => new ADWIN(0.5));
    assert.doesNotThrow(() => new ADWIN(0.001));
});

test('constructor rejects an unknown option / non-object options', () => {
    assert.throws(() => new ADWIN(0.1, { nope: 1 }), /\[lite-adaptive\].*nope/);
    assert.throws(() => new ADWIN(0.1, 42), /\[lite-adaptive\]/);
    assert.throws(() => new ADWIN(0.1, null), /\[lite-adaptive\]/);
    assert.doesNotThrow(() => new ADWIN(0.1, {}));
    assert.doesNotThrow(() => new ADWIN(0.1, undefined));
});

test('CAP / getters expose the fixed pool shape', () => {
    const ad = new ADWIN(0.1);
    assert.equal(ad.capacity, (5 + 1) * 64 + 2, 'CAP = (M+1)*levels + 2 = 386');
    assert.equal(ad.capacity, 386);
    assert.equal(ad.delta, 0.1);
    assert.equal(ad.width, 0);
    assert.equal(ad.bucketCount, 0);
});

test('getters never throw on an empty ADWIN; return 0 (null is not zero)', () => {
    const ad = new ADWIN(0.1);
    assert.equal(ad.mean, 0);
    assert.equal(ad.variance, 0);
    assert.equal(ad.width, 0);
});

test('add rejects a non-finite x fail-closed (byte-identical no-op)', () => {
    const ad = new ADWIN(0.1);
    ad.add(1); ad.add(2); ad.add(3);
    const w = ad.width, bc = ad.bucketCount, s = ad.mean;
    for (const bad of [NaN, Infinity, -Infinity, '2', null, undefined, {}, 5n]) {
        assert.throws(() => ad.add(bad), /\[lite-adaptive\]/, 'x=' + String(bad));
    }
    // nothing moved: a rejected add opened no bucket, changed no aggregate.
    assert.equal(ad.width, w, 'width unchanged after a rejected add');
    assert.equal(ad.bucketCount, bc, 'bucketCount unchanged after a rejected add');
    assert.equal(ad.mean, s, 'mean unchanged after a rejected add');
});

test('add accepts any finite real: zero, negatives, fractions', () => {
    const ad = new ADWIN(0.1);
    assert.doesNotThrow(() => { ad.add(0); ad.add(-5); ad.add(3.14159); ad.add(-2.5e9); });
    assert.equal(ad.width, 4);
});

test('a stationary run grows the window and returns false (no drift)', () => {
    const ad = new ADWIN(0.1);
    const r = mulberry32(7);
    let flags = 0;
    for (let i = 0; i < 20000; i++) if (ad.add(r() < 0.5 ? 0 : 1)) flags++;
    assert.ok(ad.width > 5000, 'a stable stream grows the window, got ' + ad.width);
    assert.ok(flags === 0, 'no false alarm on a stable stream at delta=0.1, got ' + flags);
    assert.ok(Math.abs(ad.mean - 0.5) < 0.05, 'mean tracks 0.5, got ' + ad.mean);
});

test('false-alarm rate on a stationary stream is <= delta', () => {
    for (const delta of [0.05, 0.1, 0.3]) {
        const ad = new ADWIN(delta);
        const r = mulberry32(1234);
        let flags = 0, N = 100000;
        for (let i = 0; i < N; i++) if (ad.add(r() < 0.5 ? 0 : 1)) flags++;
        const rate = flags / N;
        assert.ok(rate <= delta, 'false-alarm rate ' + rate + ' > delta ' + delta);
    }
});

test('a large abrupt shift is detected with a short latency', () => {
    const ad = new ADWIN(0.1);
    const r = mulberry32(99);
    const CP = 40000;
    let det = -1;
    for (let i = 0; i < 80000; i++) {
        const p = i < CP ? 0.2 : 0.8;
        const cut = ad.add(r() < p ? 1 : 0);
        if (i >= CP && cut && det < 0) det = i - CP;
    }
    assert.ok(det >= 0, 'a 0.2 -> 0.8 shift must be detected');
    assert.ok(det < 1000, 'detection latency ' + det + ' should be short for a large shift');
});

test('after a cut the window reflects the NEW concept only (adapted-window correctness)', () => {
    const ad = new ADWIN(0.05);
    const r = mulberry32(2024);
    const CP = 30000, END = 60000;
    for (let i = 0; i < END; i++) {
        const mu = i < CP ? 0 : 100;
        ad.add(mu + (r() - 0.5));   // tight noise around the mean
    }
    // the old regime (mean 0) must be dropped: the window mean is ~100 and the width is
    // far below the whole stream length (only the post-change items survive).
    assert.ok(Math.abs(ad.mean - 100) < 1, 'window mean should reflect the new concept ~100, got ' + ad.mean);
    assert.ok(ad.width <= CP, 'the old regime (mean 0) must be dropped: width ' + ad.width + ' should be <= ' + CP);
    assert.ok(ad.width < END, 'the window must not span the whole stream: width ' + ad.width + ' < ' + END);
});

test('a tiny shift is (eventually) detected but takes longer than a large shift', () => {
    function latency(p1, p2, seed) {
        const ad = new ADWIN(0.1);
        const r = mulberry32(seed);
        const CP = 60000;
        for (let i = 0; i < CP; i++) ad.add(r() < p1 ? 1 : 0);
        for (let j = 0; j < 200000; j++) if (ad.add(r() < p2 ? 1 : 0)) return j;
        return Infinity;
    }
    const small = latency(0.5, 0.6, 11);
    const large = latency(0.5, 0.9, 11);
    assert.ok(Number.isFinite(small), 'a 0.1 shift is eventually detected, got ' + small);
    assert.ok(Number.isFinite(large), 'a 0.4 shift is detected, got ' + large);
    assert.ok(large <= small, 'a larger shift should detect no slower: large ' + large + ' vs small ' + small);
});

test('mean and variance track the current window', () => {
    const ad = new ADWIN(0.01);
    for (let i = 0; i < 1000; i++) ad.add(5);   // constant -> variance 0
    assert.ok(Math.abs(ad.mean - 5) < 1e-9, 'mean of a constant stream is the constant');
    assert.ok(ad.variance < 1e-9, 'variance of a constant stream is 0');
});

test('clear resets to the empty window; pool reused and usable again', () => {
    const ad = new ADWIN(0.1);
    const r = mulberry32(5);
    for (let i = 0; i < 5000; i++) ad.add(r());
    assert.ok(ad.width > 0 && ad.bucketCount > 0);
    ad.clear();
    assert.equal(ad.width, 0);
    assert.equal(ad.bucketCount, 0);
    assert.equal(ad.mean, 0);
    // usable again
    ad.add(1); ad.add(2);
    assert.equal(ad.width, 2);
});

test('the bucket pool never overflows across long drifting streams', () => {
    for (const delta of [0.05, 0.1, 0.3]) {
        const ad = new ADWIN(delta);
        const r = mulberry32(321);
        for (let i = 0; i < 200000; i++) {
            const mu = (i >> 12) & 1 ? 1000 : 0;   // alternate the mean every 4096 items
            ad.add(mu + r());
            assert.ok(ad.bucketCount <= ad.capacity,
                'overflow delta=' + delta + ' at i=' + i + ' (' + ad.bucketCount + '/' + ad.capacity + ')');
        }
    }
});
