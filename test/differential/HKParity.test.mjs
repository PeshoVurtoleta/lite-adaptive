// @zakkster/lite-adaptive -- HeavyKeeper F3 differential parity (repo-only; run:
//   node --test test/differential/HKParity.test.mjs).
//
// The F3 hardening moved the HeavyKeeper hot-path numeric inputs into module scratch slots
// (HK_KIN / HK_HS) so a large key / weight never boxes at a call boundary. That is a
// REPRESENTATION change ONLY: the hash lanes, positions, decay draws, forest order and estimates
// must be BIT-IDENTICAL to the committed 1.6.0 code. This replays the exact same 200k-op stream
// against the CURRENT Adaptive.js and asserts topKInto (order included) + all 512 estimate probes
// equal the frozen 1.6.0 golden vectors, for the default seed AND seed: 0. It also pins the
// fail-closed throw messages for a bad key / weight / buf / index (unchanged by the refactor).
//
// The vectors are a DATA file inside the package (hk-1.6.0-vectors.json); this test imports only
// package files. The STREAM block below is a VERBATIM copy of the generator's -- the two must stay
// in lockstep (the generator cannot be imported here, so the logic is duplicated, not shared).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeavyKeeper } from '../../Adaptive.js';

const VECTORS = JSON.parse(readFileSync(
    fileURLToPath(new URL('./hk-1.6.0-vectors.json', import.meta.url)), 'utf8'));

// ---- STREAM (verbatim copy of the generator's block) ---------------------------------------
const D = 4, WIDTH = 1024, K = 16;
const OPS = 200000;
const NPROBE = 512;

const KEYS = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    2 ** 30, 2 ** 31, 2 ** 32 - 1, 2 ** 53 - 1, -(2 ** 31), -(2 ** 53 - 1),
];
const WP30 = 2 ** 30;

function mkRng(seed) {
    let s = seed | 0; if (s === 0) s = 0x9e3779b1 | 0;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
}

function fillPair(rng, buf) {
    const u = rng() / 4294967296;
    const idx = Math.floor(u * u * KEYS.length);
    buf[0] = KEYS[idx < KEYS.length ? idx : KEYS.length - 1];
    buf[1] = (rng() % 97) === 0 ? WP30 : 1;
}

const PROBE_POOL = KEYS.concat([
    17, 18, 19, 20, 25, 30, 35, 40,
    2 ** 30 + 12345, 2 ** 31 + 6789, 2 ** 32 - 500, 2 ** 40, -(2 ** 40),
]);

function replay(seedOpt) {
    const hk = seedOpt === undefined ? new HeavyKeeper(D, WIDTH, K) : new HeavyKeeper(D, WIDTH, K, seedOpt);
    const rng = mkRng(0x1234abcd);
    const buf = new Float64Array(2);
    for (let i = 0; i < OPS; i++) { fillPair(rng, buf); hk.addFrom(buf, 0); }

    const tk = new Float64Array(2 * K);
    const n = hk.topKInto(tk);
    const topK = [];
    for (let j = 0; j < 2 * n; j++) topK.push(tk[j]);

    const prng = mkRng(0x5eed0042);
    const probeKeys = [];
    const probeEst = [];
    for (let p = 0; p < NPROBE; p++) {
        const key = PROBE_POOL[prng() % PROBE_POOL.length];
        probeKeys.push(key);
        probeEst.push(hk.estimate(key));
    }
    return { n, topK, probeKeys, probeEst };
}
// ---- END STREAM ----------------------------------------------------------------------------

function checkParity(label, golden) {
    const got = replay(label === 'seed0' ? { seed: 0 } : undefined);
    // topKInto: entry count, then every [key, estimate] slot bit-identical (heap order included).
    assert.equal(got.n, golden.n, label + ': topKInto entry count differs');
    assert.equal(got.topK.length, golden.topK.length, label + ': topKInto length differs');
    for (let j = 0; j < golden.topK.length; j++) {
        assert.equal(got.topK[j], golden.topK[j],
            label + ': topKInto slot ' + j + ' differs (got ' + got.topK[j] + ', want ' + golden.topK[j] + ')');
    }
    // 512 estimate probes: same key sequence AND same estimate for each.
    assert.equal(got.probeEst.length, NPROBE, label + ': probe count differs');
    for (let p = 0; p < NPROBE; p++) {
        assert.equal(got.probeKeys[p], golden.probeKeys[p], label + ': probe key ' + p + ' differs');
        assert.equal(got.probeEst[p], golden.probeEst[p],
            label + ': estimate ' + p + ' for key ' + got.probeKeys[p] +
            ' differs (got ' + got.probeEst[p] + ', want ' + golden.probeEst[p] + ')');
    }
}

test('HK F3 parity: default seed -- topKInto + 512 estimates bit-identical to 1.6.0', () => {
    checkParity('default', VECTORS.defaultSeed);
});

test('HK F3 parity: seed 0 -- topKInto + 512 estimates bit-identical to 1.6.0', () => {
    checkParity('seed0', VECTORS.seed0);
});

test('HK F3 parity: fail-closed throw messages (weight text per 1.7.0 F10; estimate NaN per F12)', () => {
    const hk = new HeavyKeeper(4, 1024, 16);
    const buf = new Float64Array(2);
    const table = [
        { fn: () => hk.add(1.5), msg: '[lite-adaptive] HeavyKeeper key must be a safe integer, got 1.5' },
        { fn: () => hk.add(NaN), msg: '[lite-adaptive] HeavyKeeper key must be a safe integer, got NaN' },
        { fn: () => hk.add(5, 0), msg: '[lite-adaptive] HeavyKeeper weight must be an integer in [1, 4294967295], got 0' },
        { fn: () => hk.add(5, -2), msg: '[lite-adaptive] HeavyKeeper weight must be an integer in [1, 4294967295], got -2' },
        { fn: () => hk.add(5, 1.5), msg: '[lite-adaptive] HeavyKeeper weight must be an integer in [1, 4294967295], got 1.5' },
        { fn: () => hk.add(5, 2 ** 32), msg: '[lite-adaptive] HeavyKeeper weight must be an integer in [1, 4294967295], got 4294967296' },
        { fn: () => hk.addFrom([0, 1], 0), msg: '[lite-adaptive] HeavyKeeper.addFrom(buf, i) needs a Float64Array and an in-bounds integer index with i + 1 < buf.length, got 0,1, 0' },
        { fn: () => hk.addFrom(buf, 1), msg: '[lite-adaptive] HeavyKeeper.addFrom(buf, i) needs a Float64Array and an in-bounds integer index with i + 1 < buf.length, got ' + String(buf) + ', 1' },
        { fn: () => hk.addFrom(buf, -1), msg: '[lite-adaptive] HeavyKeeper.addFrom(buf, i) needs a Float64Array and an in-bounds integer index with i + 1 < buf.length, got ' + String(buf) + ', -1' },
    ];
    for (const t of table) {
        assert.throws(t.fn, (e) => { assert.equal(e.message, t.msg); return true; }, 'message: ' + t.msg);
    }
    // F12: a bad key on the QUERY path is NaN, never a throw.
    assert.ok(Number.isNaN(hk.estimate(1.5)));
    // a bad-key add is a byte-identical no-op: the forest stays empty.
    assert.equal(hk.size, 0, 'a rejected add must not mutate state');
});
