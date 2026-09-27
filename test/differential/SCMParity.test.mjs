// @zakkster/lite-adaptive -- SlidingCountMin F19 differential parity (repo-only; run:
//   node --test test/differential/SCMParity.test.mjs).
//
// F19 made the SlidingCountMin hash path ARGUMENT-FREE: slRound / slFinal (and the shared hkRound /
// hkFinal / hkPos body used by the SCM cell addressing) no longer take the key low word `lo` (a
// HeapNumber for keys with bit 31 set) or the running int32 hash state as call arguments -- they read
// / write an Int32Array scratch (HK_RS). An Int32Array store applies ToInt32, identical to `| 0` and
// to Math.imul's own ToInt32, so the change is a REPRESENTATION change ONLY: every column position and
// every estimate must be BIT-IDENTICAL to the pre-fix (1.7.0) code.
//
// TEETH (the reviewer's blocker on the OLD vectors): the old stream injected a count of 2^30 heavily
// over 22 keys, saturating every touched cell, so `probeEst` had only 2 distinct values (2^32-1 or 0)
// and a mutant that shifted every SCM column consistently (`Math.imul(i + 1, HK_ODD)`) still passed.
// This stream instead adds ~4096 DISTINCT large + negative keys (2^31.., near 2^32-1, near 2^53-1,
// -2^31..) over a d=5 x w=256 sketch with mostly small counts (no cell saturates), so each key's
// collision overestimate differs key to key: `probeEst` carries 72 distinct nonzero values. The
// column-shift mutant now MISMATCHES 549/600 probes (proven in scratch); a different seed mismatches
// >= 400 (the MUST-FAIL control below asserts it, so the vectors cannot be trivially all-equal). The
// per-add `total` is computed from an INDEPENDENT running sum (1.7.0 has no total()), then checked
// BOTH against the golden and against the shipped total() -- so total() has teeth too.
//
// The vectors are a DATA file inside the package; this test imports only package files. The STREAM
// block below is a VERBATIM copy of the generator's -- the two must stay in lockstep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SlidingCountMin } from '../../Adaptive.js';

const VECTORS = JSON.parse(readFileSync(
    fileURLToPath(new URL('./scm-1.7.0-vectors.json', import.meta.url)), 'utf8'));

// ---- STREAM (verbatim copy of the generator's block) ---------------------------------------
const W = 1e12;                 // huge window: every add stays live -> estimate is exact-windowed
const OPTS = { panes: 8, w: 256, d: 5, seed: 7 };
const OPS = 60000;
const NPROBE = 600;
const NKEYS = 4096;
const SUBW = [W, W / 2, W / 4, W / 8];

function mkRng(seed) { let s = seed | 0; if (s === 0) s = 0x9e3779b1 | 0; return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; }; }

// Distinct LARGE + NEGATIVE key table (2^31.., near 2^32-1, near 2^53-1, -2^31..). j-stepped so every
// entry is distinct: the four ranges are disjoint and each bucket steps by 4, so collisions come only
// from the SKETCH (column hashing), never from duplicate keys -- overestimates then differ key to key.
const KEYTAB = new Float64Array(NKEYS);
for (let j = 0; j < NKEYS; j++) {
    const bucket = j & 3;
    if (bucket === 0) KEYTAB[j] = 2 ** 31 + j;                 // just above 2^31 (bit 31 set)
    else if (bucket === 1) KEYTAB[j] = 2 ** 32 - 1 - j;        // near 2^32-1
    else if (bucket === 2) KEYTAB[j] = 2 ** 53 - 1 - j;        // near 2^53-1 (high word set)
    else KEYTAB[j] = -(2 ** 31) - j;                           // negative large
}

// replay(opts): drive OPS adds of DISTINCT large/negative keys with mostly small counts and a few
// large-but-non-saturating counts, then NPROBE estimate(key, w) probes over seen + unseen keys x
// sub-windows. Returns the scm plus an INDEPENDENT count sum (total) so total() can be checked without
// a pre-fix total() (1.7.0 has none). All keys/counts/clock live in Float64Array slots (zero-box).
function replay(opts) {
    const scm = new SlidingCountMin(W, opts);
    const rng = mkRng(0x1234abcd);
    const buf = new Float64Array(3);
    let t = 1.75e12;
    let total = 0;
    for (let i = 0; i < OPS; i++) {
        t += 1.5;
        const ki = rng() % NKEYS;
        // mostly 1..9; ~1 in 512 a larger count (up to ~65535) for coverage -- never enough to saturate.
        const cnt = (rng() % 512) === 0 ? (1 + (rng() % 65535)) : ((rng() % 9) + 1);
        buf[0] = t;
        buf[1] = KEYTAB[ki];
        buf[2] = cnt;
        scm.addFrom(buf, 0);
        total += cnt;
    }
    const prng = mkRng(0x5eed0042);
    const probeKeys = [];
    const probeW = [];
    const probeEst = [];
    for (let p = 0; p < NPROBE; p++) {
        let key;
        const sel = prng() % 10;
        if (sel < 8) key = KEYTAB[prng() % NKEYS];             // a SEEN distinct key (collision overestimate)
        else key = 2 ** 40 + (prng() % 100000);                // an UNSEEN large key (0 or a collision ghost)
        const w = SUBW[prng() % SUBW.length];
        probeKeys.push(key);
        probeW.push(w);
        probeEst.push(scm.estimate(key, w));
    }
    return { scm, total, saturated: scm.saturated, probeKeys, probeW, probeEst };
}
// ---- END STREAM ----------------------------------------------------------------------------

test('SCM F19 parity: total + saturated + 600 distinct large/negative-key estimates bit-identical to pre-fix (1.7.0)', () => {
    const got = replay(OPTS);
    // total() has teeth: the shipped method AND the independent running sum must both equal the golden.
    assert.equal(got.total, VECTORS.total, 'independent count sum differs (stream drifted from generator)');
    assert.equal(got.scm.total(), VECTORS.total, 'SlidingCountMin.total() differs from the independent sum');
    assert.equal(got.saturated, VECTORS.saturated, 'saturated differs');
    assert.equal(got.probeEst.length, NPROBE, 'probe count differs');
    // Guard against a degenerate (all-equal / all-saturated) golden that no mutant could tell apart.
    const distinct = new Set(VECTORS.probeEst);
    assert.ok(distinct.size >= 32,
        'golden probeEst has only ' + distinct.size + ' distinct values (a saturated stream has no teeth)');
    assert.ok(!VECTORS.probeEst.includes(4294967295),
        'golden probeEst is saturated (2^32-1 present) -- the stream must stay UNSATURATED to keep teeth');
    for (let p = 0; p < NPROBE; p++) {
        assert.equal(got.probeKeys[p], VECTORS.probeKeys[p], 'probe key ' + p + ' differs');
        assert.equal(got.probeW[p], VECTORS.probeW[p], 'probe w ' + p + ' differs');
        assert.equal(got.probeEst[p], VECTORS.probeEst[p],
            'estimate ' + p + ' for key ' + got.probeKeys[p] + ' w=' + got.probeW[p] +
            ' differs (got ' + got.probeEst[p] + ', want ' + VECTORS.probeEst[p] + ')');
    }
});

test('SCM F19 parity: MUST-FAIL control -- a different seed mismatches the golden on >= 400 probes', () => {
    // Same stream, seed 7 -> 8. Every column hash changes, so the collision overestimates diverge: if
    // this did NOT diverge, the probes would be seed-independent and the parity test would have no
    // teeth. Asserting a large lower bound proves the golden actually pins the hash geometry.
    const other = replay({ ...OPTS, seed: OPTS.seed + 1 });
    let mism = 0;
    for (let p = 0; p < NPROBE; p++) if (other.probeEst[p] !== VECTORS.probeEst[p]) mism++;
    assert.ok(mism >= 400,
        'a different seed mismatched only ' + mism + '/' + NPROBE + ' probes (expected >= 400): the ' +
        'vectors do not pin the column geometry, so the parity test has no teeth');
});
