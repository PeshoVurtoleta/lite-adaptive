// @zakkster/lite-adaptive -- SlidingDDSketch differential parity (repo-only; run:
//   node --test test/differential/SDDParity.test.mjs).
//
// WHY THE LONG-STREAM WINDOWED VECTORS WERE RETIRED: F7 (1.7.0) changed the covered window span of
// SlidingDDSketch BY DESIGN -- the ring grew from B to B+1 panes so the covered span is now
// [W, W + W/B] (the straddling oldest pane is KEPT, never dropped, so count() >= true(W)). The old
// 200k-sample vectors queried a stream whose span far exceeded W, so panes expired and the windowed
// answers differ between the B (1.6.0) and B+1 (1.7.0) rings -- they are NOT expected to match, and
// pinning them would gate a fixed bug. Windowed correctness is now owned by the witness TRUE-window
// HARD gate (test/witness.mjs: count() in [true(W), true(W+W/B)] on 100% of queries, quantiles within
// alpha of the exact covered-span multiset, with a B-pane negative control that must FAIL).
//
// WHAT THIS STILL LOCKS: a SHORT stream whose total time span (50000) is < W - W/B (58125), so NO
// pane ever expires in EITHER ring. There the B and B+1 rings MUST agree bit-for-bit -- mapping,
// collapse, quantiles, count, and the collapsed flag -- which pins the DDSketch MAPPING + collapse
// math unchanged by F7. non-strict rows are the committed 1.6.0 (B-ring) golden (F7 kept the
// non-strict path byte-identical); strict rows are the pre-step-3 F2 (step2) golden, because 1.6.0
// HEAD strict semantics predate F2 and cannot anchor the strict path. Both are frozen in
// sdd-1.6.0-vectors.json (a DATA file inside the package; this test imports only package files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SlidingDDSketch } from '../../Adaptive.js';

const VECTORS = JSON.parse(readFileSync(
    fileURLToPath(new URL('./sdd-1.6.0-vectors.json', import.meta.url)), 'utf8'));

// ---- STREAM (verbatim copy of the generator's block) ---------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function nonStrictVal(rnd) {
    const u = rnd();
    if (u < 0.12) return Math.exp(-20 - rnd() * 6);
    if (u < 0.20) return Math.exp(12 + rnd() * 6);
    if (u < 0.85) return Math.exp(rnd() * 6);
    return rnd() * 5e5 + 1e4;
}
function strictVal(rnd) { return Math.exp(rnd() * 10) + 1e-3; }

function replay(opts, valFn, golden) {
    const { N, W, seed, stride } = VECTORS;
    const rnd = mulberry32(seed);
    const sd = new SlidingDDSketch(W, opts);
    const qs = Float64Array.of(0.5, 0.9, 0.99);
    const out = new Float64Array(3);
    let row = 0, now = 0;
    for (let i = 0; i < N; i++) {
        now += 1;
        sd.add(now, valFn(rnd));
        if (i % stride === 0) {
            sd.quantileInto(qs, out);
            const exp = golden[row++];
            assert.ok(Object.is(out[0], exp[0]), 'p50 row ' + (row - 1) + ' got ' + out[0] + ' want ' + exp[0]);
            assert.ok(Object.is(out[1], exp[1]), 'p90 row ' + (row - 1) + ' got ' + out[1] + ' want ' + exp[1]);
            assert.ok(Object.is(out[2], exp[2]), 'p99 row ' + (row - 1) + ' got ' + out[2] + ' want ' + exp[2]);
            assert.equal(sd.collapsed ? 1 : 0, exp[3], 'collapsed row ' + (row - 1));
            assert.equal(sd.count(), exp[4], 'count row ' + (row - 1));
        }
    }
    assert.equal(row, golden.length, 'replayed every vector row');
}

test('F7 no-expiry: non-strict SlidingDDSketch (B+1 ring) is byte-identical to the 1.6.0 (B-ring) golden', () => {
    const { alpha, panes } = VECTORS;
    replay({ alpha, panes }, nonStrictVal, VECTORS.nonStrict);
});

test('F7 no-expiry: strict SlidingDDSketch (B+1 ring) is byte-identical to the pre-step-3 F2 golden', () => {
    const { alpha, panes } = VECTORS;
    replay({ alpha, panes, strict: true }, strictVal, VECTORS.strict);
});
