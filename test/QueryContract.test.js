// @zakkster/lite-adaptive -- F12 query-contract table (node:test).
// One contract across the sliding members: a query NEVER throws on a bad VALUE (a bad quantile q,
// a bad sub-window w, or an out-of-domain key -> NaN, never a silent 0), but a WRONG CONTAINER TYPE
// (a non-Float64Array passed to an `*Into` reader) still throws (a programming error, not data).
// Every asserted call leaves the instance state BYTE-IDENTICAL (a query is pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SlidingDDSketch, SlidingHyperLogLog, SlidingCountMin, HeavyKeeper,
} from '../Adaptive.js';

/** A stable structural snapshot of an instance's own state (typed arrays -> arrays, scalars verbatim). */
function snap(o) {
    const out = {};
    for (const k of Object.keys(o)) {
        const v = o[k];
        if (ArrayBuffer.isView(v)) out[k] = Array.from(v);
        else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    }
    return JSON.stringify(out);
}

/** Run `fn`, asserting it returns NaN and left `inst` byte-identical. */
function assertNaNPure(inst, fn, label) {
    const before = snap(inst);
    const r = fn();
    assert.ok(Number.isNaN(r), label + ' -> NaN');
    assert.equal(snap(inst), before, label + ' left state byte-identical');
}

/** Run `fn`, asserting it throws [lite-adaptive] and left `inst` byte-identical. */
function assertThrowsPure(inst, fn, label) {
    const before = snap(inst);
    assert.throws(fn, /\[lite-adaptive\]/, label + ' throws tagged');
    assert.equal(snap(inst), before, label + ' left state byte-identical');
}

test('F12 SlidingDDSketch: bad q / bad w -> NaN; wrong container -> throw; no key axis', () => {
    const sdd = new SlidingDDSketch(1000);
    for (let i = 0; i < 50; i++) sdd.add(i, 1 + i * 0.01);
    // bad q (a data VALUE) -> NaN
    assertNaNPure(sdd, () => sdd.quantile(2), 'SDD quantile(2)');
    assertNaNPure(sdd, () => sdd.quantile(NaN), 'SDD quantile(NaN)');
    // bad w -> NaN
    assertNaNPure(sdd, () => sdd.count(-1), 'SDD count(-1)');
    assertNaNPure(sdd, () => sdd.quantile(0.5, 1e9), 'SDD quantile(.5, >W)');
    // bad key: N/A (SDD keys nothing) -- skipped explicitly.
    // wrong container TYPE (a programming error) -> throw
    const out = new Float64Array(2);
    assertThrowsPure(sdd, () => sdd.quantileInto([0.5, 0.9], out), 'SDD quantileInto(non-F64, out)');
    assertThrowsPure(sdd, () => sdd.quantileInto(new Float64Array([0.5]), [0]), 'SDD quantileInto(qs, non-F64)');
});

test('F12 SlidingHyperLogLog: bad w -> NaN; no q / key / container axis', () => {
    const shll = new SlidingHyperLogLog(1000);
    for (let i = 0; i < 200; i++) shll.add(i, i);
    // bad w -> NaN (was a throw before 1.7.0)
    assertNaNPure(shll, () => shll.count(-1), 'SHLL count(-1)');
    assertNaNPure(shll, () => shll.count(NaN), 'SHLL count(NaN)');
    assertNaNPure(shll, () => shll.count(1e9), 'SHLL count(>W)');
    assertNaNPure(shll, () => shll.count('x'), 'SHLL count(non-number)');
    // bad q: N/A; bad key: N/A; wrong container: N/A -- skipped explicitly.
});

test('F12 SlidingCountMin: bad key / bad w -> NaN; unseen valid key -> 0; no q / container axis', () => {
    const scm = new SlidingCountMin(1000);
    for (let i = 0; i < 200; i++) scm.add(i, i % 20, 1);
    // bad w -> NaN (was a fail-open 0)
    assertNaNPure(scm, () => scm.estimate(5, -1), 'SCM estimate(k, -1)');
    assertNaNPure(scm, () => scm.estimate(5, 1e9), 'SCM estimate(k, >W)');
    // out-of-domain KEY -> NaN (was 0)
    assertNaNPure(scm, () => scm.estimate(1.5), 'SCM estimate(non-integer)');
    assertNaNPure(scm, () => scm.estimate(NaN), 'SCM estimate(NaN)');
    assertNaNPure(scm, () => scm.estimate('x'), 'SCM estimate(non-number)');
    // an UNSEEN but VALID key stays 0 (a legitimate miss, distinct from NaN)
    const before = snap(scm);
    assert.equal(scm.estimate(999999), 0, 'SCM unseen valid key -> 0');
    assert.equal(snap(scm), before, 'SCM unseen-key query left state byte-identical');
    // bad q: N/A; wrong container: N/A -- skipped explicitly.
});

test('F12 HeavyKeeper: bad key -> NaN; unseen valid key -> 0; wrong container -> throw; no q / w axis', () => {
    const hk = new HeavyKeeper(4, 64, 8);
    for (let i = 0; i < 200; i++) hk.add(i % 30, 1);
    // bad key -> NaN (was a throw before 1.7.0)
    assertNaNPure(hk, () => hk.estimate(1.5), 'HK estimate(non-integer)');
    assertNaNPure(hk, () => hk.estimate(NaN), 'HK estimate(NaN)');
    assertNaNPure(hk, () => hk.estimate('x'), 'HK estimate(non-number)');
    // an UNSEEN but VALID key stays 0
    const before = snap(hk);
    assert.equal(hk.estimate(9999999), 0, 'HK unseen valid key -> 0');
    assert.equal(snap(hk), before, 'HK unseen-key query left state byte-identical');
    // wrong container TYPE (topKInto) -> throw
    assertThrowsPure(hk, () => hk.topKInto([0, 0]), 'HK topKInto(non-F64)');
    assertThrowsPure(hk, () => hk.topKInto(new Float64Array(1)), 'HK topKInto(too short)');
    // bad q: N/A; bad w: N/A -- skipped explicitly.
});
