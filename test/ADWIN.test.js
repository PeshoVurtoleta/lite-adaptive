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
    assert.equal(VERSION, '1.7.0');
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

test('add accepts any finite real whose square is finite: zero, negatives, fractions, boundary', () => {
    const ad = new ADWIN(0.1);
    assert.doesNotThrow(() => { ad.add(0); ad.add(-5); ad.add(3.14159); ad.add(-2.5e9); });
    assert.equal(ad.width, 4);
    // the domain edge (F9): the sums are CENTRED (x - c), so the quantity that must stay finite is
    // (x - c)^2, not x^2. With |x|, |c| <= sqrt(MAX)/2 the worst centred square is (2*XMAX)^2 = MAX
    // (finite), so the accepted bound HALVED to sqrt(MAX_VALUE)/2.
    const XMAX = Math.sqrt(Number.MAX_VALUE) / 2;
    assert.doesNotThrow(() => { ad.add(XMAX); ad.add(-XMAX); }, 'boundary |x| == sqrt(MAX_VALUE)/2 is in-domain');
});

test('add rejects a FINITE x whose centred square would overflow -- no silent drift freeze (T7)', () => {
    // A finite x with |x| > sqrt(MAX_VALUE)/2 makes the CENTRED (x - c)*(x - c) overflow to Infinity
    // (F9: |x - c| can reach 2*|x|), which poisons _sumSq/_wsumSq: variance would silently read 0 and
    // every cut-scan's epsCut would be Inf/NaN, permanently freezing drift detection to false with no
    // throw. The guard rejects such x fail-closed instead.
    const XMAX = Math.sqrt(Number.MAX_VALUE) / 2;   // ~6.7e153
    const ad = new ADWIN(0.1);
    ad.add(1); ad.add(2);
    const w = ad.width, bc = ad.bucketCount, s = ad.mean;
    for (const bad of [1e160, -1e160, XMAX * 1.0000001, -(XMAX * 1.0000001), Number.MAX_VALUE, -Number.MAX_VALUE]) {
        assert.throws(() => ad.add(bad), /\[lite-adaptive\]/, 'x=' + String(bad));
    }
    // a rejected add is a byte-identical no-op: nothing squared, nothing accumulated.
    assert.equal(ad.width, w);
    assert.equal(ad.bucketCount, bc);
    assert.equal(ad.mean, s);
    // and the guard does NOT suppress legitimate drift: an abrupt real shift still cuts.
    const drift = new ADWIN(0.1);
    let cuts = 0;
    for (let i = 0; i < 40000; i++) if (drift.add(i < 20000 ? 0 : 1000)) cuts++;
    assert.ok(cuts >= 1, 'the value guard must not suppress a real drift, got cuts=' + cuts);
});

test('mean / variance throw fail-closed if the window accumulator overflows to non-finite', () => {
    // Defense-in-depth (mirrors ForwardDecay._guardFinite). Since 1.7.0 (F9) the sums are CENTRED
    // (x - c), so an equal-value stream centres to 0 and the accumulator no longer overflows through
    // the public API on any realistic stream -- the guard is only reachable on an astronomically long
    // centred-square accumulation. Poison the accumulator directly to prove the getters THROW (never
    // silently return 0 / NaN).
    const ad = new ADWIN(0.1);
    for (let i = 0; i < 10; i++) ad.add(i);
    ad._wsumSq = Infinity;   // a centred-square sum that overflowed on an unbounded stream
    assert.throws(() => ad.variance, /\[lite-adaptive\]/, 'variance on a poisoned accumulator throws');
    assert.throws(() => ad.mean, /\[lite-adaptive\]/, 'mean on a poisoned accumulator throws');
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

// ---------------------------------------------------------------------------
// F9 (1.7.0): CENTRED sums -- offset-invariant variance + re-centring on a cut
// ---------------------------------------------------------------------------

/** A Box-Muller N(0,1) sample from a mulberry32 stream. */
function gauss(rnd) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

test('F9: variance at a 1.7e12 offset is within 1e-6 relative of the offset-0 variance', () => {
    // A KNOWN, exactly-representable integer sequence fed at offset 0 and at 1.7e12 (offset + v is a
    // safe integer, so the INPUT is not itself rounded -- the test isolates ADWIN's own arithmetic).
    // Pre-F9 (variance = E[x^2] - mean^2) the huge offset cancels catastrophically -> variance reads
    // ~0. Centred sums make it offset-invariant: here it is EXACT (centred xc = v - v0, an integer).
    function varOf(offset) {
        const ad = new ADWIN(0.5);   // high delta -> no cut fires on this stationary run
        for (let i = 0; i < 500; i++) ad.add(offset + ((i * 2654435761 >>> 0) % 1000));   // ints 0..999
        return { v: ad.variance, w: ad.width };
    }
    const base = varOf(0);
    const hi = varOf(1.7e12);
    assert.equal(hi.w, base.w, 'same window width at both offsets (no spurious cut)');
    assert.ok(base.v > 5e4 && base.v < 1e5, 'sanity: uniform(0..999) variance ~83k, got ' + base.v);
    const rel = Math.abs(hi.v - base.v) / base.v;
    assert.ok(rel < 1e-6, 'variance at 1.7e12 within 1e-6 rel of offset 0, got rel=' + rel +
        ' (base=' + base.v + ', hi=' + hi.v + ')');
});

test('F9: mean includes the centring offset', () => {
    const ad = new ADWIN(0.5);
    for (const x of [10, 20, 30]) ad.add(1.7e12 + x);   // true mean 1.7e12 + 20
    assert.ok(Math.abs(ad.mean - (1.7e12 + 20)) < 1e-3, 'mean tracks the offset, got ' + ad.mean);
    // variance of {10,20,30} = 200/3 ~ 66.667 -- offset-invariant.
    assert.ok(Math.abs(ad.variance - 200 / 3) < 1e-6, 'variance offset-invariant, got ' + ad.variance);
});

test('F9: _recentre after a fired cut leaves mean/variance unchanged (within 1e-9 rel)', () => {
    // Drive a shift that FIRES a cut (so _recentre runs), snapshot mean/variance across the cut add,
    // then verify the re-centring did not perturb the reported summary of the surviving window.
    const ad = new ADWIN(0.05);
    const r = mulberry32(7);
    for (let i = 0; i < 5000; i++) ad.add(1e9 + gauss(r));       // regime A around 1e9
    let cutAt = -1, meanAfter = 0, varAfter = 0, cAfter = 0;
    for (let j = 0; j < 5000; j++) {
        const fired = ad.add(1e9 + 50 + gauss(r));               // regime B (shift +50)
        if (fired) { cutAt = j; meanAfter = ad.mean; varAfter = ad.variance; cAfter = ad._c; break; }
    }
    assert.ok(cutAt >= 0, 'a cut must fire on this shift');
    // after the fired cut, c has been re-anchored to the surviving window mean (|mean - c| small).
    assert.ok(Math.abs(meanAfter - cAfter) < Math.abs(meanAfter) * 1e-6 + 1e3,
        're-centred: c tracks the window mean after the cut (c=' + cAfter + ', mean=' + meanAfter + ')');
    // the summary is self-consistent (re-centring is a pure representation shift): re-reading the
    // getters yields the same numbers, and variance stays a sane, finite, non-negative value.
    assert.ok(Number.isFinite(varAfter) && varAfter >= 0, 'variance finite/non-negative after recentre');
    const relV = Math.abs(ad.variance - varAfter) / (varAfter || 1);
    const relM = Math.abs(ad.mean - meanAfter) / (Math.abs(meanAfter) || 1);
    assert.ok(relV < 1e-9 && relM < 1e-9, 'mean/variance stable when re-read after the recentred cut');
});

test('F9: _c initializes to -0 on construction (before any add)', () => {
    const ad = new ADWIN(0.1);
    assert.ok(Object.is(ad._c, -0), '_c is -0 (double representation) immediately after construction, got ' +
        ad._c);
});

test('F9: new ADWIN(.01).add(sqrt(MAX)/2) is accepted; ' +
    'add(sqrt(MAX)/2 * 1.0000001) throws byte-identically', () => {
    const XMAX = Math.sqrt(Number.MAX_VALUE) / 2;
    const ad = new ADWIN(.01);
    assert.doesNotThrow(() => ad.add(XMAX), 'exact boundary sqrt(MAX_VALUE)/2 accepted');
    const w = ad.width, bc = ad.bucketCount, m = ad.mean, c = ad._c;
    assert.throws(() => ad.add(XMAX * 1.0000001), /\[lite-adaptive\]/,
        'just past the boundary throws');
    assert.equal(ad.width, w, 'width byte-identical after the rejected add');
    assert.equal(ad.bucketCount, bc, 'bucketCount byte-identical after the rejected add');
    assert.ok(Object.is(ad.mean, m) || ad.mean === m, 'mean byte-identical after the rejected add');
    assert.ok(Object.is(ad._c, c), '_c byte-identical after the rejected add');
});

// ---------------------------------------------------------------------------
// 1.7.0 QA adversarial (b): a stream that jumps between offsets 0 and 1.7e12
// (a genuine regime shift, not just a scale change) -- ADWIN must DETECT it,
// and after the fired cut the variance of the surviving (new) regime must be
// finite and non-negative (re-centre correctness at an astronomical offset jump).
// ---------------------------------------------------------------------------
test('ADVERSARIAL (b): a stream jumping between offset 0 and offset 1.7e12 is detected, ' +
    'and post-cut variance is finite and non-negative', () => {
    const ad = new ADWIN(0.05);
    const r = mulberry32(4242);
    const CP = 6000, END = 12000;
    let cutAt = -1;
    for (let i = 0; i < END; i++) {
        const offset = i < CP ? 0 : 1.7e12;      // genuine jump: regime A near 0, regime B near 1.7e12
        const fired = ad.add(offset + gauss(r));
        if (i >= CP && fired && cutAt < 0) cutAt = i - CP;
    }
    assert.ok(cutAt >= 0, 'the 0 -> 1.7e12 shift must be detected');
    assert.ok(cutAt < END - CP, 'detection happens within the post-shift run, got +' + cutAt);
    // after settling on the new regime, the reported window must reflect ~1.7e12 and a finite,
    // non-negative variance (re-centre correctness: no NaN / Infinity / negative from the offset jump).
    assert.ok(Math.abs(ad.mean - 1.7e12) < 10, 'mean tracks the new regime ~1.7e12, got ' + ad.mean);
    assert.ok(Number.isFinite(ad.variance), 'post-cut variance is finite, got ' + ad.variance);
    assert.ok(ad.variance >= 0, 'post-cut variance is non-negative, got ' + ad.variance);
});

test('F9: clear() resets the centring offset _c', () => {
    const ad = new ADWIN(0.5);
    for (let i = 0; i < 100; i++) ad.add(1.7e12 + i);
    assert.ok(ad._c !== 0, 'c anchored to the offset after adds, got ' + ad._c);
    ad.clear();
    assert.ok(Object.is(ad._c, -0), 'clear() resets _c to -0 (double representation)');
    assert.equal(ad.mean, 0, 'empty mean is 0');
    // a fresh window re-anchors c to its first value.
    ad.add(-42);
    assert.equal(ad._c, -42, 'first add of a cleared instance re-anchors c');
    assert.equal(ad.mean, -42);
});

// ---------------------------------------------------------------------------
// F18 (1.7.0): R is the range of the CURRENT window (live buckets EXCLUDING the
// globally-oldest bucket), NOT a running global min/max over all raw x ever seen.
// Pre-F18 R never shrank after a level shift, so the Bernstein range term stayed
// inflated for the instance's life and ADWIN went DEAF to later shifts (and a
// straddling mixed bucket survived, leaving the window variance ~2.7e8 after a 1e6 jump).
// ---------------------------------------------------------------------------

/** A Box-Muller N(0,1) sample from a mulberry32 stream (shared by the F18 lanes). */
function gaussF18(rnd) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

test('F18: a settled 0 -> 1e6 jump leaves a CLEAN window (variance ~1, mean ~1e6), not a straddle', () => {
    // Pre-F18 a straddling bucket kept one prior-regime value alive, pinning R at ~1e6 and the
    // window variance at ~2.7e8. With R = range excluding the oldest bucket, the straddle is dropped.
    for (const seed of [1, 2, 3, 4, 5]) {
        const ad = new ADWIN(0.002);
        const r = mulberry32(seed + 123);
        for (let i = 0; i < 3000; i++) ad.add(gaussF18(r));
        for (let i = 0; i < 30000; i++) ad.add(1e6 + gaussF18(r));
        assert.ok(ad.variance >= 0.8 && ad.variance <= 1.25,
            'seed ' + seed + ': clean-window variance ~1, got ' + ad.variance);
        assert.ok(Math.abs(ad.mean - 1e6) < 1, 'seed ' + seed + ': mean ~1e6, got ' + ad.mean);
    }
});

test('F18: a later +1 shift is detected fast even after a large prior level shift (deafness fixed)', () => {
    // The detection delay of a +1 shift after a settled prior jump J must stay close to the
    // no-prior-jump delay for every J in {100, 1e4, 1e6}. Pre-F18: 921-988 at J=100 and NEVER at
    // J >= 1e4 (vs ~90 with no prior jump). Gate: within 1.5x + 10 of the same-seed baseline.
    function baselineDelay(seed) {
        const ad = new ADWIN(0.002), r = mulberry32(seed + 7000);
        for (let i = 0; i < 3000; i++) ad.add(gaussF18(r));
        for (let i = 0; i < 20000; i++) ad.add(gaussF18(r));
        for (let j = 0; j < 20000; j++) if (ad.add(1 + gaussF18(r))) return j;
        return Infinity;
    }
    function priorDelay(J, seed) {
        const ad = new ADWIN(0.002), r = mulberry32(seed + 7000);
        for (let i = 0; i < 3000; i++) ad.add(gaussF18(r));
        for (let i = 0; i < 20000; i++) ad.add(J + gaussF18(r));
        for (let j = 0; j < 20000; j++) if (ad.add(J + 1 + gaussF18(r))) return j;
        return Infinity;
    }
    for (const seed of [1, 2, 3, 4, 5]) {
        const base = baselineDelay(seed);
        assert.ok(Number.isFinite(base), 'seed ' + seed + ': baseline +1 shift must be detected');
        const budget = base * 1.5 + 10;
        for (const J of [100, 1e4, 1e6]) {
            const d = priorDelay(J, seed);
            assert.ok(Number.isFinite(d) && d <= budget,
                'seed ' + seed + ' J=' + J + ': delay ' + d + ' must be <= ' + budget + ' (baseline ' + base + ')');
        }
    }
});

test('F18: R is derived from the live window, not a running global -- a dropped extreme stops inflating it', () => {
    // Feed a huge value, let the window shrink past it, then run a stationary low-variance stream.
    // With the OLD running-global R the huge value would keep the range term inflated forever and
    // suppress detection; with the live-window range the small drift is still detected.
    const ad = new ADWIN(0.05);
    const r = mulberry32(2024);
    for (let i = 0; i < 2000; i++) ad.add(0 + (r() - 0.5) * 0.01);   // tiny-variance regime near 0
    for (let i = 0; i < 4000; i++) ad.add(1e6 + (r() - 0.5) * 0.01); // big jump; window moves to ~1e6
    assert.ok(Math.abs(ad.mean - 1e6) < 1, 'window settled near 1e6, got ' + ad.mean);
    // now a small +0.5 shift on top of 1e6 -- must be detected (R is ~0.01 now, not 1e6).
    let det = -1;
    for (let j = 0; j < 4000; j++) if (ad.add(1e6 + 0.5 + (r() - 0.5) * 0.01)) { det = j; break; }
    assert.ok(det >= 0, 'a +0.5 shift on a settled 1e6 window must be detected once R has shrunk, got MISS');
});

test('F18: _bmin/_bmax columns exist, are RAW (not centred), and survive clear()', () => {
    const ad = new ADWIN(0.1);
    assert.ok(ad._bmin instanceof Float64Array && ad._bmax instanceof Float64Array, 'per-bucket min/max columns exist');
    assert.equal(ad._bmin.length, ad.capacity, '_bmin sized like the pool');
    assert.equal(ad._bmax.length, ad.capacity, '_bmax sized like the pool');
    ad.add(1e12 + 5);   // a large-offset value: the RAW x (not the centred x - c) is stored
    const head0 = ad._head[0];
    assert.equal(ad._bmin[head0], 1e12 + 5, 'a size-1 bucket stores the RAW value as its min');
    assert.equal(ad._bmax[head0], 1e12 + 5, 'a size-1 bucket stores the RAW value as its max');
    ad.clear();
    assert.equal(ad.width, 0, 'clear resets the window');
    ad.add(-7);
    assert.equal(ad._bmin[ad._head[0]], -7, 'reused pool stores the RAW value after clear');
});

// ---------------------------------------------------------------------------
// F18 boundary matrix (1.7.0 QA): empty / 1 / 2 items, the N-1 / N / N+1 adds around
// the first level-1 bucket, clear() reuse bit-for-bit vs a fresh instance, rejected
// inputs as byte-identical no-ops, and the alternating +-1e6 adversarial regime.
// ---------------------------------------------------------------------------

/** Snapshot every mutable ADWIN field (typed columns + scalars) for byte-identity checks. */
function snapF18(ad) {
    const cols = ['_sum', '_sumSq', '_bmin', '_bmax', '_bcount', '_next', '_prev', '_lvl', '_head', '_tail', '_lcount'];
    const out = [];
    for (const k of cols) out.push(k + ':' + Array.from(ad[k], (v) => (Object.is(v, -0) ? '-0' : String(v))).join(','));
    for (const k of ['_freeHead', '_maxLevel', '_count', '_total', '_c', '_wsum', '_wsumSq']) {
        out.push(k + ':' + (Object.is(ad[k], -0) ? '-0' : String(ad[k])));
    }
    return out.join('|');
}

test('F18 boundary: EMPTY ADWIN -- getters are 0, no NaN, no crash, no cut possible', () => {
    const ad = new ADWIN(0.002);
    assert.equal(ad.width, 0);
    assert.equal(ad.bucketCount, 0);
    assert.equal(ad.mean, 0);
    assert.equal(ad.variance, 0);
    assert.equal(ad._scanCut(), false, 'an empty window has no split');
    ad.clear();                                  // clear on empty is a no-op
    ad.clear();                                  // duplicate clear
    assert.equal(ad.width, 0);
    assert.equal(snapF18(ad), snapF18(new ADWIN(0.002)), 'double clear on empty == fresh');
});

test('F18 boundary: ONE item -- single bucket (R = 0 path), finite getters, no cut', () => {
    for (const x of [0, -0, 5, -1e150, 1e150]) {
        const ad = new ADWIN(0.002);
        assert.equal(ad.add(x), false, 'x=' + x + ': one item never cuts');
        assert.equal(ad.width, 1);
        assert.equal(ad.bucketCount, 1);
        assert.ok(Number.isFinite(ad.mean) && Number.isFinite(ad.variance), 'x=' + x + ': finite getters');
        assert.equal(ad.variance, 0);
        assert.ok(ad.mean === x, 'x=' + x + ': mean ' + ad.mean);   // -0 in -> +0 or -0 out, both === 0
        assert.equal(ad._scanCut(), false, 'width 1 -> no split (guards ln(width))');
    }
});

test('F18 boundary: TWO items -- R excludes the oldest (range of one bucket = 0), finite, no cut', () => {
    for (const [a, b] of [[0, 0], [0, 1e6], [-1e150, 1e150], [7, -0]]) {
        const ad = new ADWIN(0.002);
        ad.add(a);
        const cut = ad.add(b);
        assert.equal(cut, false, a + ',' + b + ': two items never cut at delta=0.002');
        assert.equal(ad.width, 2);
        assert.ok(Number.isFinite(ad.mean) && Number.isFinite(ad.variance), a + ',' + b + ': finite getters');
        assert.ok(ad.variance >= 0);
    }
});

test('F18 boundary: N-1 / N / N+1 adds around the FIRST level-1 bucket carry the union range', () => {
    // M = 5: the 6th add pushes level 0 to M+1 buckets and merges the two OLDEST into level 1.
    const ad = new ADWIN(0.002);
    const xs = [3, -9, 4, 11, 2, 8, 1];
    for (let i = 0; i < 5; i++) assert.equal(ad.add(xs[i]), false);
    assert.equal(ad._maxLevel, 0, 'N-1 (5 adds): still level 0 only');
    assert.equal(ad.bucketCount, 5);
    assert.equal(ad.add(xs[5]), false, 'N (6th add): merge, no cut');
    assert.equal(ad._maxLevel, 1, 'the 6th add creates the first level-1 bucket');
    assert.equal(ad._lcount[1], 1);
    assert.equal(ad._lcount[0], 4);
    const l1 = ad._head[1];
    assert.equal(ad._bcount[l1], 2);
    assert.equal(ad._bmin[l1], -9, 'merged bucket min = min(3, -9) RAW');
    assert.equal(ad._bmax[l1], 3, 'merged bucket max = max(3, -9) RAW');
    assert.equal(ad.add(xs[6]), false, 'N+1 (7th add): no cut');
    assert.equal(ad._lcount[0], 5);
    assert.equal(ad.width, 7);
    const m = xs.reduce((s, v) => s + v, 0) / 7;
    assert.ok(Math.abs(ad.mean - m) < 1e-12, 'mean exact across the merge');
});

test('F18 boundary: clear() after HUGE values then 10k small adds == a FRESH instance bit-for-bit', () => {
    const used = new ADWIN(0.002);
    for (let i = 0; i < 5000; i++) used.add((i & 1 ? -1 : 1) * 1e150 * (1 + (i % 7)));
    used.clear();
    used.clear();                                // duplicate clear is idempotent
    const fresh = new ADWIN(0.002);
    assert.equal(snapF18(used).replace(/_(bmin|bmax|sum|sumSq|bcount|lvl|prev):[^|]*\|/g, ''),
        snapF18(fresh).replace(/_(bmin|bmax|sum|sumSq|bcount|lvl|prev):[^|]*\|/g, ''),
        'list / free-list / scalar state identical after clear (dead slots may differ)');
    const r1 = mulberry32(99), r2 = mulberry32(99);
    for (let i = 0; i < 10000; i++) {
        const scale = i < 5000 ? 1 : 3;          // a mid-stream shift so cuts fire on both
        const ca = used.add(r1() * scale), cb = fresh.add(r2() * scale);
        assert.equal(ca, cb, 'add() return differs at ' + i);
        if (!Object.is(used.mean, fresh.mean) || !Object.is(used.variance, fresh.variance) ||
            used.width !== fresh.width) {
            assert.fail('state diverged at ' + i + ': mean ' + used.mean + ' vs ' + fresh.mean +
                ', var ' + used.variance + ' vs ' + fresh.variance + ', width ' + used.width + ' vs ' + fresh.width);
        }
    }
});

test('F18 boundary: null / undefined / NaN / Infinity / bigint / valueOf-reentrant are byte-identical no-ops', () => {
    const ad = new ADWIN(0.002);
    for (let i = 0; i < 40; i++) ad.add(i % 3);
    const before = snapF18(ad);
    // adversarial: an object whose valueOf RE-ENTERS add() -- the typeof-first guard must reject it
    // without ever coercing (so the re-entrant write never happens).
    let reentered = 0;
    const evil = { valueOf() { reentered++; ad.add(1e6); return 1; } };
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, 1e300, '1', 1n, evil]) {
        assert.throws(() => ad.add(bad), /\[lite-adaptive\]/, 'add(' + String(typeof bad) + ')');
    }
    const buf = new Float64Array([NaN, Infinity, 1e300]);
    for (let i = 0; i < 3; i++) assert.throws(() => ad.addFrom(buf, i), /\[lite-adaptive\]/);
    for (const i of [-1, 3, 0.5, NaN, null, undefined, -0 - 1]) {
        assert.throws(() => ad.addFrom(buf, i), /\[lite-adaptive\]/, 'addFrom index ' + String(i));
    }
    assert.equal(reentered, 0, 'valueOf never invoked');
    assert.equal(snapF18(ad), before, 'every rejected input left the state byte-identical');
    // -0 is a valid finite value: accepted, and addFrom(buf, -0) is index 0.
    assert.equal(ad.add(-0), false);
    assert.doesNotThrow(() => ad.addFrom(new Float64Array([2]), -0));
    assert.equal(ad.width, 42);
});

test('F18 adversarial: alternating +1e6 / -1e6 every 500 items (20 switches, N(0,1) noise) -- >= 95% detected, 0 late alarms', () => {
    let switches = 0, detected = 0, late = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
        const ad = new ADWIN(0.002), r = mulberry32(seed * 977 + 1);
        for (let s = 0; s <= 20; s++) {          // 21 segments -> 20 switches
            const level = (s & 1) ? -1e6 : 1e6;
            let hit = false;
            for (let i = 0; i < 500; i++) {
                const cut = ad.add(level + gaussF18(r));
                if (cut) {
                    if (i < 250) hit = true;
                    else late++;                 // an alarm in the SECOND half of a segment
                }
            }
            if (s > 0) { switches++; if (hit) detected++; }
            assert.ok(Math.abs(ad.mean - level) < 1, 'seed ' + seed + ' seg ' + s + ': window settled, mean ' + ad.mean);
        }
    }
    assert.equal(switches, 100);
    assert.ok(detected / switches >= 0.95, 'detected ' + detected + '/' + switches);
    assert.equal(late, 0, 'alarms in the second half of a segment: ' + late);
});
