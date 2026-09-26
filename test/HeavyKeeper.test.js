// @zakkster/lite-adaptive -- HeavyKeeper behavioral + fail-closed suite (node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { HeavyKeeper, ADWIN, VERSION } from '../Adaptive.js';

/** A deterministic mulberry32 PRNG so every assertion is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A faithful Zipfian(s) sampler: map u in [0,1) to a rank via the normalized CDF (cached by n:s). */
const _zipfCache = new Map();
function zipfKey(u, n, s, base) {
    const ck = n + ':' + s;
    let cdf = _zipfCache.get(ck);
    if (cdf === undefined) {
        cdf = new Float64Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) { sum += 1 / Math.pow(i + 1, s); cdf[i] = sum; }
        for (let i = 0; i < n; i++) cdf[i] /= sum;
        _zipfCache.set(ck, cdf);
    }
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
    return base + lo;
}

test('VERSION is the expected string', () => {
    assert.equal(VERSION, '1.7.0');
});

test('constructor validates d / w / k fail-closed BEFORE allocation', () => {
    for (const bad of [0, -1, 1.5, 65, NaN, Infinity, '4', null, {}, 4n]) {
        assert.throws(() => new HeavyKeeper(bad, 256, 8), /\[lite-adaptive\]/, 'd=' + String(bad));
    }
    for (const bad of [0, -1, 1.5, NaN, Infinity, '256', null, 256n]) {
        assert.throws(() => new HeavyKeeper(4, bad, 8), /\[lite-adaptive\]/, 'w=' + String(bad));
    }
    for (const bad of [0, -1, 1.5, NaN, Infinity, '8', null, 8n]) {
        assert.throws(() => new HeavyKeeper(4, 256, bad), /\[lite-adaptive\]/, 'k=' + String(bad));
    }
    assert.doesNotThrow(() => new HeavyKeeper(4, 256, 8));
    assert.doesNotThrow(() => new HeavyKeeper(1, 1, 1));
    assert.doesNotThrow(() => new HeavyKeeper(64, 1024, 100));
});

test('constructor rejects an unknown option / non-object options / bad seed / bad b', () => {
    assert.throws(() => new HeavyKeeper(4, 256, 8, { nope: 1 }), /\[lite-adaptive\].*nope/);
    assert.throws(() => new HeavyKeeper(4, 256, 8, 42), /\[lite-adaptive\]/);
    assert.throws(() => new HeavyKeeper(4, 256, 8, null), /\[lite-adaptive\]/);
    for (const bad of [-1, 1.5, 2 ** 32, NaN, '7', {}, 7n]) {
        assert.throws(() => new HeavyKeeper(4, 256, 8, { seed: bad }), /\[lite-adaptive\]/, 'seed=' + String(bad));
    }
    for (const bad of [1, 0.5, 0, -1, NaN, Infinity, '1.08', {}]) {
        assert.throws(() => new HeavyKeeper(4, 256, 8, { b: bad }), /\[lite-adaptive\]/, 'b=' + String(bad));
    }
    assert.doesNotThrow(() => new HeavyKeeper(4, 256, 8, {}));
    assert.doesNotThrow(() => new HeavyKeeper(4, 256, 8, { seed: 0 }));   // seed=0 is valid (null is not zero)
    assert.doesNotThrow(() => new HeavyKeeper(4, 256, 8, { b: 1.001 }));
});

test('getters expose the fixed shape; seed=0 is a distinct valid seed', () => {
    const hk = new HeavyKeeper(6, 512, 10, { seed: 12345, b: 1.05 });
    assert.equal(hk.d, 6);
    assert.equal(hk.w, 512);
    assert.equal(hk.k, 10);
    assert.equal(hk.b, 1.05);
    assert.equal(hk.seed, 12345);
    assert.equal(hk.size, 0);
    assert.ok(hk.bytes > 0);
    const def = new HeavyKeeper(4, 256, 8);
    assert.equal(def.seed, 0x9e3779b1, 'default seed is a fixed nonzero constant');
    assert.equal(def.b, 1.08, 'default decay base ~1.08');
    const zero = new HeavyKeeper(4, 256, 8, { seed: 0 });
    assert.equal(zero.seed, 0);
});

test('withAccuracy derives d / w from k + targetError', () => {
    const hk = HeavyKeeper.withAccuracy(8, 0.001);
    assert.equal(hk.d, 4);
    assert.equal(hk.k, 8);
    assert.ok(hk.w >= 1000, 'w >= ceil(1/targetError), got ' + hk.w);
    assert.ok(hk.w >= 2 * 8, 'w >= 2k');
    for (const badK of [0, -1, 1.5, NaN]) {
        assert.throws(() => HeavyKeeper.withAccuracy(badK, 0.01), /\[lite-adaptive\]/);
    }
    for (const badE of [0, 1, 1.5, -0.1, NaN, '0.01']) {
        assert.throws(() => HeavyKeeper.withAccuracy(8, badE), /\[lite-adaptive\]/);
    }
});

test('add rejects a non-safe-integer key / bad weight fail-closed (byte-identical no-op)', () => {
    const hk = new HeavyKeeper(4, 256, 8);
    hk.add(10); hk.add(20); hk.add(10);
    const before = JSON.stringify(hk.topK());
    for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, '10', null, undefined, {}, 10n]) {
        assert.throws(() => hk.add(bad), /\[lite-adaptive\]/, 'key=' + String(bad));
    }
    for (const bad of [0, -1, 1.5, NaN, Infinity, '2', null, {}, 2n]) {
        assert.throws(() => hk.add(10, bad), /\[lite-adaptive\]/, 'weight=' + String(bad));
    }
    assert.equal(JSON.stringify(hk.topK()), before, 'a rejected add is a byte-identical no-op');
});

test('add accepts weight default 1 and large positive integer weights', () => {
    const hk = new HeavyKeeper(4, 256, 8);
    hk.add(5);            // default weight 1
    assert.equal(hk.estimate(5), 1);
    hk.add(5, 1000000);   // integer microseconds
    assert.equal(hk.estimate(5), 1000001);
    assert.equal(hk.estimate(999), 0, 'unseen key -> 0');
});

test('add accepts safe-integer keys across the full range incl. large u32 and negatives', () => {
    const hk = new HeavyKeeper(4, 512, 8);
    for (const key of [0, 1, 2 ** 31, 2 ** 31 - 1, 4294967295, -5, Number.MAX_SAFE_INTEGER]) {
        assert.doesNotThrow(() => hk.add(key, 3));
        assert.equal(hk.estimate(key), 3, 'estimate for key ' + key);
    }
});

test('estimate returns 0 for an unseen valid key; NaN (never a throw) on a bad key (T3, F12)', () => {
    const hk = new HeavyKeeper(4, 256, 8);
    hk.add(7, 5);
    assert.equal(hk.estimate(7), 5);
    assert.equal(hk.estimate(999999), 0, 'unseen but valid key -> 0');
    // F12: one contract -- queries never throw on a bad value. A non-safe-integer key -> NaN
    // (an invalid key was never "seen 0 times"), distinct from a legitimate miss (0).
    for (const bad of [1.5, NaN, Infinity, '7', null, undefined, {}, 7n]) {
        assert.ok(Number.isNaN(hk.estimate(bad)), 'bad key=' + String(bad) + ' -> NaN');
    }
});

test('a heavy hitter dominates a stream of light keys (top-1 recall)', () => {
    const hk = new HeavyKeeper(4, 1024, 8, { seed: 1 });
    const r = mulberry32(42);
    const HEAVY = 777777;
    for (let i = 0; i < 100000; i++) {
        if (r() < 0.3) hk.add(HEAVY);
        else hk.add(Math.floor(r() * 50000));
    }
    const top = hk.topK();
    assert.equal(top[0].key, HEAVY, 'the heavy hitter is ranked #1');
    assert.ok(top[0].count > 25000, 'its estimate is near its true count ~30000, got ' + top[0].count);
});

test('recall of the true top-k above N/k on a Zipfian stream is 100%', () => {
    const K = 8;
    const hk = new HeavyKeeper(5, 2048, K, { seed: 9 });
    const truth = new Map();
    const r = mulberry32(2024);
    const N = 300000;
    for (let i = 0; i < N; i++) {
        const key = zipfKey(r(), 20000, 1.1, 1000000000);
        hk.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    const trueTop = [...truth.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map((e) => e[0]);
    const got = new Set(hk.topK().map((e) => e.key));
    let hit = 0;
    for (const key of trueTop) if (got.has(key)) hit++;
    assert.equal(hit, trueTop.length, 'recall of the true top-' + K + ' should be 100%, got ' + hit + '/' + trueTop.length);
});

test('overestimate is bounded: estimate in [true - err, true] for the leaders', () => {
    const hk = new HeavyKeeper(5, 4096, 10, { seed: 3 });
    const truth = new Map();
    const r = mulberry32(55);
    const N = 200000;
    for (let i = 0; i < N; i++) {
        const key = zipfKey(r(), 10000, 1.1, 0);
        hk.add(key);
        truth.set(key, (truth.get(key) || 0) + 1);
    }
    for (const e of hk.topK()) {
        const t = truth.get(e.key) || 0;
        assert.ok(e.count <= t, 'HeavyKeeper never overestimates a leader: est ' + e.count + ' <= true ' + t);
        assert.ok(e.count >= t - N / hk.w, 'underestimate bounded by ~N/w for key ' + e.key);
    }
});

test('seeded determinism: same seed + same stream -> identical topK', () => {
    function run(seed) {
        const hk = new HeavyKeeper(4, 512, 8, { seed });
        const r = mulberry32(101);
        for (let i = 0; i < 80000; i++) hk.add(zipfKey(r(), 5000, 1.1, 3000000000));
        return JSON.stringify(hk.topK());
    }
    assert.equal(run(7), run(7), 'identical seed + stream -> identical topK');
    // the seed drives the decay draws; two DIFFERENT seeds run distinct PRNG streams.
    const a = new HeavyKeeper(4, 512, 8, { seed: 7 });
    const c = new HeavyKeeper(4, 512, 8, { seed: 8 });
    assert.notEqual(a._rand32(), c._rand32(), 'a different seed yields a different PRNG stream');
});

test('addFrom reads key + weight UNBOXED from a Float64Array (large u32 keys)', () => {
    const hk = new HeavyKeeper(4, 512, 8);
    const buf = new Float64Array(4);
    buf[0] = 4294967295; buf[1] = 7;   // 2^32-1
    buf[2] = 2 ** 31;     buf[3] = 4;   // 2^31
    hk.addFrom(buf, 0);
    hk.addFrom(buf, 2);
    assert.equal(hk.estimate(4294967295), 7);
    assert.equal(hk.estimate(2 ** 31), 4);
    // add() and addFrom() agree
    const a = new HeavyKeeper(4, 512, 8, { seed: 5 });
    const b = new HeavyKeeper(4, 512, 8, { seed: 5 });
    const scratch = new Float64Array(2);
    for (let i = 0; i < 20000; i++) {
        const key = (i * 2654435761) % 100000;
        a.add(key, (i % 5) + 1);
        scratch[0] = key; scratch[1] = (i % 5) + 1;
        b.addFrom(scratch, 0);
    }
    assert.equal(JSON.stringify(a.topK()), JSON.stringify(b.topK()), 'add and addFrom agree');
});

test('addFrom rejects a bad buffer / index / key / weight fail-closed (byte-identical no-op)', () => {
    const hk = new HeavyKeeper(4, 256, 8);
    hk.add(1); hk.add(2);
    const before = JSON.stringify(hk.topK());
    const buf = new Float64Array(4);
    buf[0] = 1.5; buf[1] = 1;        // non-integer key
    assert.throws(() => hk.addFrom(buf, 0), /\[lite-adaptive\]/);
    buf[0] = 10; buf[1] = -1;        // non-positive weight
    assert.throws(() => hk.addFrom(buf, 0), /\[lite-adaptive\]/);
    buf[0] = NaN; buf[1] = 1;        // NaN key
    assert.throws(() => hk.addFrom(buf, 0), /\[lite-adaptive\]/);
    for (const badBuf of [[1, 2], null, undefined, {}, new Uint32Array(4)]) {
        assert.throws(() => hk.addFrom(badBuf, 0), /\[lite-adaptive\]/, 'buf=' + String(badBuf));
    }
    for (const badI of [-1, 1.5, 3, 4, NaN, '0', null]) {   // i+1 must be < length (4)
        assert.throws(() => hk.addFrom(buf, badI), /\[lite-adaptive\]/, 'i=' + String(badI));
    }
    assert.equal(JSON.stringify(hk.topK()), before, 'a rejected addFrom is a byte-identical no-op');
});

test('forEach matches topK (same key/estimate set, alloc-free contract)', () => {
    const hk = new HeavyKeeper(4, 512, 8, { seed: 2 });
    const r = mulberry32(88);
    for (let i = 0; i < 50000; i++) hk.add(zipfKey(r(), 3000, 1.1, 0));
    const fromForEach = new Map();
    hk.forEach((key, est) => fromForEach.set(key, est));
    const fromTopK = new Map(hk.topK().map((e) => [e.key, e.count]));
    assert.equal(fromForEach.size, fromTopK.size);
    for (const [key, est] of fromTopK) assert.equal(fromForEach.get(key), est, 'forEach agrees for key ' + key);
    assert.throws(() => hk.forEach(42), /\[lite-adaptive\]/);
});

test('topKInto writes packed [key, estimate] pairs and returns the count', () => {
    const hk = new HeavyKeeper(4, 512, 5, { seed: 4 });
    const r = mulberry32(13);
    for (let i = 0; i < 40000; i++) hk.add(zipfKey(r(), 2000, 1.1, 0));
    const buf = new Float64Array(2 * hk.k);
    const n = hk.topKInto(buf);
    assert.equal(n, hk.size);
    const seen = new Map();
    for (let i = 0; i < n; i++) seen.set(buf[i * 2], buf[i * 2 + 1]);
    const fromTopK = new Map(hk.topK().map((e) => [e.key, e.count]));
    for (const [key, est] of fromTopK) assert.equal(seen.get(key), est);
    // fail closed: a buffer smaller than 2*k throws -- no silent truncation
    const small = new Float64Array(4);
    assert.throws(() => hk.topKInto(small), /\[lite-adaptive\]/);
    assert.throws(() => hk.topKInto([1, 2]), /\[lite-adaptive\]/);
});

test('topKInto boundary: exactly 2k-1 throws, exactly 2k and 2k+1 both work (T4)', () => {
    const hk = new HeavyKeeper(4, 512, 6, { seed: 41 });
    const r = mulberry32(17);
    for (let i = 0; i < 30000; i++) hk.add(zipfKey(r(), 2000, 1.1, 0));
    const K = hk.k;
    // N-1: one Float64 short of 2*k -- must throw, never silently truncate.
    assert.throws(() => hk.topKInto(new Float64Array(2 * K - 1)), /\[lite-adaptive\]/,
        'length 2k-1 must throw');
    // N: exactly 2*k -- must work and return the full entry count with [key,estimate] pairs.
    const bufN = new Float64Array(2 * K);
    const nAtN = hk.topKInto(bufN);
    assert.equal(nAtN, hk.size, 'length 2k returns the entry count');
    const fromTopK = new Map(hk.topK().map((e) => [e.key, e.count]));
    for (let i = 0; i < nAtN; i++) assert.equal(bufN[i * 2 + 1], fromTopK.get(bufN[i * 2]));
    // N+1: one Float64 more than 2*k -- must also work identically (the extra slot is untouched).
    const bufN1 = new Float64Array(2 * K + 1);
    const nAtN1 = hk.topKInto(bufN1);
    assert.equal(nAtN1, nAtN, 'length 2k+1 returns the same entry count');
    for (let i = 0; i < nAtN1 * 2; i++) assert.equal(bufN1[i], bufN[i], 'identical pairs written');
    assert.equal(bufN1[2 * K], 0, 'the trailing extra slot is left untouched (fresh buffer default 0)');
    // a non-Float64Array of otherwise-sufficient length is still rejected (type, not just size).
    assert.throws(() => hk.topKInto(new Array(2 * K).fill(0)), /\[lite-adaptive\]/,
        'a plain Array of sufficient length must still throw (not a Float64Array)');
});

test('clear resets to empty; arrays reused; PRNG replays identically', () => {
    const hk = new HeavyKeeper(4, 512, 8, { seed: 6 });
    const r1 = mulberry32(31);
    for (let i = 0; i < 30000; i++) hk.add(zipfKey(r1(), 4000, 1.1, 0));
    const first = JSON.stringify(hk.topK());
    assert.ok(hk.size > 0);
    hk.clear();
    assert.equal(hk.size, 0);
    assert.equal(hk.estimate(0), 0);
    // replay the SAME stream -> identical result (deterministic reset of hash + PRNG state)
    const r2 = mulberry32(31);
    for (let i = 0; i < 30000; i++) hk.add(zipfKey(r2(), 4000, 1.1, 0));
    assert.equal(JSON.stringify(hk.topK()), first, 'clear + replay is identical');
});

test('the top-k forest never exceeds k across a long drifting stream', () => {
    const hk = new HeavyKeeper(4, 1024, 12, { seed: 21 });
    const r = mulberry32(321);
    for (let i = 0; i < 300000; i++) {
        const regime = (i >> 15) & 3;   // shift the popular key set every 32768 items
        hk.add(zipfKey(r(), 8000, 1.1, regime * 100000));
        assert.ok(hk.size <= hk.k, 'forest size ' + hk.size + ' must stay <= k=' + hk.k);
    }
});

// ---------------------------------------------------------------------------
// ADWIN.addFrom -- parity with add(x), fail-closed, returns the drift boolean.
// ---------------------------------------------------------------------------

test('ADWIN.addFrom mirrors add(x) exactly (incl. a detected drift)', () => {
    const a = new ADWIN(0.1);
    const b = new ADWIN(0.1);
    const r = mulberry32(4242);
    const buf = new Float64Array(1);
    let adds = 0, aCuts = 0, bCuts = 0;
    for (let i = 0; i < 120000; i++) {
        const p = i < 60000 ? 0.2 : 0.8;
        const x = r() < p ? 1 : 0;
        if (a.add(x)) aCuts++;
        buf[0] = x;
        if (b.addFrom(buf, 0)) bCuts++;
        adds++;
    }
    assert.equal(a.width, b.width, 'width parity');
    assert.equal(a.bucketCount, b.bucketCount, 'bucketCount parity');
    assert.equal(a.mean, b.mean, 'mean parity');
    assert.equal(aCuts, bCuts, 'drift-flag parity');
    assert.ok(aCuts > 0, 'the 0.2 -> 0.8 shift is detected via addFrom, got ' + aCuts);
    assert.ok(adds === 120000);
});

test('ADWIN.addFrom returns the boolean drift flag', () => {
    const ad = new ADWIN(0.1);
    const buf = new Float64Array(1);
    for (let i = 0; i < 40000; i++) { buf[0] = 0; ad.add(0); }
    let cut = false;
    for (let i = 0; i < 40000 && !cut; i++) { buf[0] = 100; cut = ad.addFrom(buf, 0); }
    assert.equal(typeof cut, 'boolean');
    assert.ok(cut, 'a large abrupt shift via addFrom must be detected');
});

test('ADWIN.addFrom rejects a bad buffer / index / value fail-closed (byte-identical no-op)', () => {
    const ad = new ADWIN(0.1);
    ad.add(1); ad.add(2); ad.add(3);
    const w = ad.width, bc = ad.bucketCount, m = ad.mean;
    const buf = new Float64Array(2);
    buf[0] = NaN;
    assert.throws(() => ad.addFrom(buf, 0), /\[lite-adaptive\]/);
    buf[0] = Infinity;
    assert.throws(() => ad.addFrom(buf, 0), /\[lite-adaptive\]/);
    for (const badBuf of [[1, 2], null, undefined, {}, new Uint32Array(2)]) {
        assert.throws(() => ad.addFrom(badBuf, 0), /\[lite-adaptive\]/, 'buf=' + String(badBuf));
    }
    for (const badI of [-1, 1.5, 2, 3, NaN, '0', null]) {   // i must be < length (2)
        assert.throws(() => ad.addFrom(buf, badI), /\[lite-adaptive\]/, 'i=' + String(badI));
    }
    assert.equal(ad.width, w, 'width unchanged');
    assert.equal(ad.bucketCount, bc, 'bucketCount unchanged');
    assert.equal(ad.mean, m, 'mean unchanged');
});

test('ADWIN.addFrom rejects a FINITE square-overflowing buf[i] -- no silent drift freeze (T7)', () => {
    // Mirrors add()'s T7 guard, but through the zero-box addFrom entry: buf[i] itself is finite
    // (a real Float64 that survives being STORED in a Float64Array), yet the CENTRED (buf[i] - c)^2
    // would overflow to Infinity and poison _wsumSq if accepted. Since 1.7.0 (F9) the sums are
    // centred, so the accepted bound HALVED to sqrt(MAX_VALUE)/2 (|x - c| <= 2*XMAX -> square <= MAX).
    const XMAX = Math.sqrt(Number.MAX_VALUE) / 2;   // ~6.7e153
    const ad = new ADWIN(0.1);
    ad.add(1); ad.add(2);
    const w = ad.width, bc = ad.bucketCount, m = ad.mean;
    const buf = new Float64Array(1);
    for (const bad of [1e160, -1e160, XMAX * 1.0000001, -(XMAX * 1.0000001), Number.MAX_VALUE, -Number.MAX_VALUE]) {
        buf[0] = bad;
        assert.throws(() => ad.addFrom(buf, 0), /\[lite-adaptive\]/, 'buf[0]=' + String(bad));
    }
    // a rejected addFrom is a byte-identical no-op: nothing squared, nothing accumulated.
    assert.equal(ad.width, w, 'width unchanged after a rejected addFrom');
    assert.equal(ad.bucketCount, bc, 'bucketCount unchanged after a rejected addFrom');
    assert.equal(ad.mean, m, 'mean unchanged after a rejected addFrom');
    // the domain edge holds through addFrom too: |x| == sqrt(MAX_VALUE)/2 is accepted, not rejected.
    buf[0] = XMAX;
    assert.doesNotThrow(() => ad.addFrom(buf, 0), 'boundary |x| == sqrt(MAX_VALUE)/2 is in-domain via addFrom');
    buf[0] = -XMAX;
    assert.doesNotThrow(() => ad.addFrom(buf, 0), 'boundary -sqrt(MAX_VALUE)/2 is in-domain via addFrom');
});

// --- 1.7.0 step-2 QA boundary case (F3 shared scratch slots) ---

test('F3 re-entrancy: another instance used inside forEach does not disturb this instance', () => {
    const keys = [3, 2 ** 31 + 5, -(2 ** 31) - 7, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 32 - 1, 12345];
    const feed = (h) => { for (let i = 0; i < 20000; i++) h.add(keys[(i * 7 + (i >> 3)) % keys.length], 1 + (i % 3)); };
    const a = new HeavyKeeper(4, 256, 8, { seed: 1 });
    const ref = new HeavyKeeper(4, 256, 8, { seed: 1 });
    const b = new HeavyKeeper(4, 256, 8, { seed: 2 });
    feed(a); feed(ref); feed(b);
    const buf = new Float64Array([2 ** 31 + 9, 2 ** 30]);
    a.forEach(() => {                                    // user code runs between A's reads
        b.add(-(2 ** 53 - 1), 7); b.addFrom(buf, 0); b.estimate(2 ** 32 - 1);
    });
    assert.deepEqual(a.topK(), ref.topK(), 'A top-k unchanged by re-entrant B calls');
    for (const k of keys) assert.ok(Object.is(a.estimate(k), ref.estimate(k)), 'estimate(' + k + ')');
    a.add(2 ** 31 + 5, 3); ref.add(2 ** 31 + 5, 3);     // and A keeps evolving identically
    assert.deepEqual(a.topK(), ref.topK());
});

// --- F10: weight bound [1, 2^32-1] -- a single weight above 2^32-1 is REJECTED (byte-identical
//     no-op), while an ACCUMULATED cell SATURATES at 2^32-1 (the two rules are distinct). ---

/** A structural snapshot of the HK table + forest (for the byte-identical no-op assertion). */
function hkSnap(hk) {
    return JSON.stringify({
        fp: Array.from(hk._fp), cnt: Array.from(hk._cnt),
        key: Array.from(hk._hkKey), est: Array.from(hk._hkEst),
        n: hk._hkN, rng: hk._rng,
    });
}

test('F10 add(key, 2^32) / (key, 2^33) throw tagged with a byte-identical table+forest', () => {
    const hk = new HeavyKeeper(4, 64, 8);
    for (let i = 0; i < 50; i++) hk.add(i % 10, 3);
    const before = hkSnap(hk);
    for (const w of [2 ** 32, 2 ** 33]) {
        assert.throws(() => hk.add(7, w), /\[lite-adaptive\].*\[1, 4294967295\]/, 'add(7, ' + w + ') throws');
        assert.equal(hkSnap(hk), before, 'add(7, ' + w + ') left state byte-identical');
    }
    // addFrom too (packed [key, weight])
    const buf = new Float64Array(2);
    for (const w of [2 ** 32, 2 ** 33]) {
        buf[0] = 7; buf[1] = w;
        assert.throws(() => hk.addFrom(buf, 0), /\[lite-adaptive\].*\[1, 4294967295\]/, 'addFrom weight ' + w + ' throws');
        assert.equal(hkSnap(hk), before, 'addFrom(7, ' + w + ') left state byte-identical');
    }
});

test('F10 weight 4294967295 is accepted, then a second add saturates at 4294967295', () => {
    const hk = new HeavyKeeper(4, 64, 8);
    hk.add(7, 4294967295);
    assert.equal(hk.estimate(7), 4294967295, 'estimate == 2^32-1');
    assert.equal(hk.topK()[0].count, 4294967295, 'topK count == 2^32-1');
    assert.equal(hk.estimate(7), hk.topK()[0].count, 'estimate === topK()[0].count');
    hk.add(7, 1);   // an accumulated cell SATURATES (never wraps)
    assert.equal(hk.estimate(7), 4294967295, 'a second add saturates at 2^32-1');
});

// --- F11: the ctor cells caps throw a tagged RangeError in-process (1.6.0 aborted with exit 133
//     via a V8 fatal). Verified in a SUBPROCESS: the child catches the throw and exits 0. ---

test('F11 HeavyKeeper(64, 2^30, 1) throws tagged in a subprocess (no process abort)', () => {
    const src =
        "import('" + new URL('../Adaptive.js', import.meta.url).href + "').then(m=>{" +
        "try{new m.HeavyKeeper(64, 2**30, 1);console.log('NO_THROW');}" +
        "catch(e){console.log(/\\[lite-adaptive\\]/.test(e.message)&&e instanceof RangeError?'TAGGED':'WRONG:'+e.message);}});";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'child exits 0, stderr=' + r.stderr);
    assert.match(r.stdout, /TAGGED/, 'child caught a tagged RangeError, got ' + r.stdout);
});
