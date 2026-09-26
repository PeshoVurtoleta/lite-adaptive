// @zakkster/lite-adaptive -- SlidingHyperLogLog F8 differential parity (repo-only; run:
//   node --test test/differential/SHLLParity.test.mjs).
//
// The F8 hardening (1.7.0) made count() PURE -- it no longer destructively expires ring entries;
// expiry now happens in add()/addFrom() (dropping heads with stamp <= t - W before the ring-full
// check). count()'s read scan already skipped every stamp <= subCut, so on any stream the estimate
// is BIT-IDENTICAL to the committed 1.6.0 code. This replays a fixed stream whose ringCap (64) is
// large enough that NO ring ever overflows -- so the 1.6.0 DESTRUCTIVE count() and the current PURE
// count() agree at every query point -- and asserts every full-window AND sub-window count() equals
// the frozen 1.6.0 golden vectors. It also proves count() is non-destructive: 100 consecutive
// count() calls return the same value and leave the ring byte-identical.
//
// The vectors are a DATA file inside the package (shll-1.6.0-vectors.json); this test imports only
// package files. The STREAM block is a VERBATIM copy of the generator's -- the two stay in lockstep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SlidingHyperLogLog } from '../../Adaptive.js';

const VECTORS = JSON.parse(readFileSync(
    fileURLToPath(new URL('./shll-1.6.0-vectors.json', import.meta.url)), 'utf8'));

// ---- STREAM (verbatim copy of the generator's block) ---------------------------------------
const { W, p, ringCap, seed, N, stride, keyspace, subW, counts } = VECTORS;
function key(t) { return (t * 2654435761 >>> 0) % keyspace; }

test('F8 count() is bit-identical to the 1.6.0 golden on a non-overflowing stream (full + sub-window)', () => {
    const sl = new SlidingHyperLogLog(W, { p, ringCap, seed });
    let row = 0;
    for (let t = 0; t < N; t++) {
        sl.add(t, key(t));
        if (t % stride === 0) {
            assert.equal(sl.count(), counts[row++], 'full-window count row ' + (row - 1) + ' t=' + t);
            assert.equal(sl.count(subW), counts[row++], 'sub-window count row ' + (row - 1) + ' t=' + t);
        }
    }
    assert.equal(row, counts.length, 'replayed every golden vector');
    assert.equal(sl.overflows, 0, 'the golden stream never overflows the ring (bit-identity precondition)');
});

test('F8 count() is PURE: 100 consecutive calls are stable and leave the ring byte-identical', () => {
    const sl = new SlidingHyperLogLog(W, { p, ringCap, seed });
    for (let t = 0; t < 20000; t++) sl.add(t, key(t));
    const first = sl.count();
    const snapStamps = Uint8Array.from(new Uint8Array(sl._stamps.buffer.slice(0)));
    const snapRho = Uint8Array.from(sl._rho);
    const snapHead = Int32Array.from(sl._head);
    const snapLen = Int32Array.from(sl._len);
    const ov = sl.overflows;
    for (let i = 0; i < 100; i++) {
        assert.equal(sl.count(), first, 'count() drifts across calls at i=' + i);
        assert.equal(sl.overflows, ov, 'count() mutated overflows at i=' + i);
    }
    assert.deepEqual(new Uint8Array(sl._stamps.buffer), snapStamps, '_stamps mutated by count()');
    assert.deepEqual(Uint8Array.from(sl._rho), snapRho, '_rho mutated by count()');
    assert.deepEqual(Int32Array.from(sl._head), snapHead, '_head mutated by count()');
    assert.deepEqual(Int32Array.from(sl._len), snapLen, '_len mutated by count()');
});

test('F8 overflows/degraded are query-independent: a queried and an unqueried twin agree', () => {
    // small ringCap so overflows really happen; feed the SAME 200k stream, query one twin after
    // every add and never the other -- their overflows AND ring state must be byte-identical.
    function run(queryEveryAdd) {
        const s = new SlidingHyperLogLog(50, { p: 4, ringCap: 2, seed: 1 });
        for (let t = 0; t < 200000; t++) { s.add(t, (t * 2654435761 >>> 0) % 500); if (queryEveryAdd) s.count(); }
        return s;
    }
    const q = run(true), u = run(false);
    assert.equal(q.overflows, u.overflows, 'overflows depend on query frequency');
    assert.equal(q.degraded, u.degraded, 'degraded depends on query frequency');
    assert.deepEqual(new Uint8Array(q._stamps.buffer), new Uint8Array(u._stamps.buffer), '_stamps diverge');
    assert.deepEqual(Uint8Array.from(q._rho), Uint8Array.from(u._rho), '_rho diverge');
    assert.deepEqual(Int32Array.from(q._head), Int32Array.from(u._head), '_head diverge');
    assert.deepEqual(Int32Array.from(q._len), Int32Array.from(u._len), '_len diverge');
    assert.equal(q.count(), u.count(), 'final estimate diverges');
});
