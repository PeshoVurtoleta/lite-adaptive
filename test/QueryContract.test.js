// @zakkster/lite-adaptive -- F12 query-contract table (node:test).
// One contract across the sliding members: a query NEVER throws on a bad VALUE (a bad quantile q,
// a bad sub-window w, or an out-of-domain key -> NaN, never a silent 0), but a WRONG CONTAINER TYPE
// (a non-Float64Array passed to an `*Into` reader) still throws (a programming error, not data).
// Every asserted call leaves the instance state BYTE-IDENTICAL (a query is pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SlidingDDSketch, SlidingHyperLogLog, SlidingCountMin, HeavyKeeper, SlidingAggregate,
    DriftDetector, DRIFT_PH,
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

test('F12 SlidingHyperLogLog: bad w -> NaN; countInto bad w -> NaN slot; wrong container -> throw; no q / key axis', () => {
    const shll = new SlidingHyperLogLog(1000);
    for (let i = 0; i < 200; i++) shll.add(i, i);
    // bad w -> NaN (was a throw before 1.7.0)
    assertNaNPure(shll, () => shll.count(-1), 'SHLL count(-1)');
    assertNaNPure(shll, () => shll.count(NaN), 'SHLL count(NaN)');
    assertNaNPure(shll, () => shll.count(1e9), 'SHLL count(>W)');
    assertNaNPure(shll, () => shll.count('x'), 'SHLL count(non-number)');
    // countInto (v1.11.0): a bad w VALUE fills out[0] with NaN and returns 1, never a throw; pure.
    const out = new Float64Array(1);
    for (const bad of [-1, 0, NaN, Infinity, -Infinity, 1e9, 'x']) {
        const before = snap(shll);
        assert.equal(shll.countInto(out, bad), 1, 'SHLL countInto(bad w=' + String(bad) + ') -> returns 1');
        assert.ok(Number.isNaN(out[0]), 'SHLL countInto(bad w=' + String(bad) + ') -> NaN slot');
        assert.equal(snap(shll), before, 'SHLL countInto(bad w) left state byte-identical');
    }
    // countInto WRONG CONTAINER TYPE (a programming error) -> throw, state byte-identical
    assertThrowsPure(shll, () => shll.countInto([0]), 'SHLL countInto(non-F64)');
    assertThrowsPure(shll, () => shll.countInto(new Float32Array(1)), 'SHLL countInto(Float32Array)');
    assertThrowsPure(shll, () => shll.countInto(new Proxy(new Float64Array(1), {})), 'SHLL countInto(Proxy)');
    assertThrowsPure(shll, () => shll.countInto(new Float64Array(0)), 'SHLL countInto(length 0)');
    // bad q: N/A; bad key: N/A -- skipped explicitly.
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
    // total(w): bad w -> NaN, pure (1.8.0, parity with estimate's w axis)
    assertNaNPure(scm, () => scm.total(-1), 'SCM total(-1)');
    assertNaNPure(scm, () => scm.total(1e9), 'SCM total(>W)');
    assertNaNPure(scm, () => scm.total('x'), 'SCM total(non-number)');
    // estimateInto: WRONG CONTAINER TYPE -> throw, state byte-identical (1.8.0)
    const scmOut = new Float64Array(2);
    assertThrowsPure(scm, () => scm.estimateInto([5, 6], scmOut), 'SCM estimateInto(non-F64 keys)');
    assertThrowsPure(scm, () => scm.estimateInto(new Float64Array([5]), [0]), 'SCM estimateInto(non-F64 out)');
    assertThrowsPure(scm, () => scm.estimateInto(new Float64Array(3), scmOut), 'SCM estimateInto(out too short)');
    // estimateInto: a bad w fills every out slot with NaN (parity with estimate); scm state pure
    const bw = snap(scm);
    const keysW = new Float64Array([5, 6]); const outW = new Float64Array(2);
    assert.equal(scm.estimateInto(keysW, outW, -1), 2, 'SCM estimateInto bad w -> returns n');
    assert.ok(Number.isNaN(outW[0]) && Number.isNaN(outW[1]), 'SCM estimateInto bad w -> all NaN slots');
    assert.equal(snap(scm), bw, 'SCM estimateInto(bad w) left scm state byte-identical');
    // UNSET + bad w: fail closed to NaN on every reader (the w check precedes the unset return; 1.8.0).
    // An unset instance must NOT fail-OPEN to 0 for a bad w while estimateInto returns NaN.
    const scmU = new SlidingCountMin(1000);
    assertNaNPure(scmU, () => scmU.total(-1), 'SCM unset total(-1) -> NaN');
    assertNaNPure(scmU, () => scmU.total('x'), 'SCM unset total(non-number) -> NaN');
    assertNaNPure(scmU, () => scmU.estimate(5, -1), 'SCM unset estimate(k, -1) -> NaN');
    assertNaNPure(scmU, () => scmU.estimate(5, NaN), 'SCM unset estimate(k, NaN) -> NaN');
    const uKeys = new Float64Array([5, 6]); const uOut = new Float64Array(2);
    assert.equal(scmU.estimateInto(uKeys, uOut, -1), 2, 'SCM unset estimateInto bad w -> returns n');
    assert.ok(Number.isNaN(uOut[0]) && Number.isNaN(uOut[1]), 'SCM unset estimateInto bad w -> all NaN slots');
    assert.equal(scmU.total(), 0, 'SCM unset total() (good w) still 0');
    assert.equal(scmU.estimate(5), 0, 'SCM unset estimate() (good w) still 0');
    // bad q: N/A -- skipped explicitly.
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

test('F12 SlidingAggregate: bad w -> NaN on all 5 readers; into wrong container / short -> throw; ' +
    'into bad w -> 5 NaN slots; unset + bad w -> NaN; no q / key axis', () => {
    const sa = new SlidingAggregate(1000, { panes: 8 });
    for (let i = 0; i < 200; i++) sa.add(i, (i % 13) - 6);
    // bad w (a data VALUE) -> NaN on EVERY scalar reader, pure
    for (const bad of [-1, 0, NaN, Infinity, -Infinity, 1e9, 'x']) {
        assertNaNPure(sa, () => sa.count(bad), 'SA count(' + String(bad) + ')');
        assertNaNPure(sa, () => sa.sum(bad), 'SA sum(' + String(bad) + ')');
        assertNaNPure(sa, () => sa.mean(bad), 'SA mean(' + String(bad) + ')');
        assertNaNPure(sa, () => sa.min(bad), 'SA min(' + String(bad) + ')');
        assertNaNPure(sa, () => sa.max(bad), 'SA max(' + String(bad) + ')');
    }
    // WRONG CONTAINER TYPE (into) -> throw, state byte-identical
    const saOut = new Float64Array(5);
    assertThrowsPure(sa, () => sa.into([0, 0, 0, 0, 0]), 'SA into(non-F64)');
    assertThrowsPure(sa, () => sa.into(new Float64Array(4)), 'SA into(out too short)');
    // into: a bad w fills all 5 out slots with NaN (parity with the scalar readers); sa state pure
    const bw = snap(sa);
    const outW = new Float64Array(5);
    assert.equal(sa.into(outW, -1), 5, 'SA into bad w -> returns 5');
    assert.ok([...outW].every(Number.isNaN), 'SA into bad w -> all 5 NaN slots');
    assert.equal(snap(sa), bw, 'SA into(bad w) left sa state byte-identical');
    // UNSET + bad w: fail closed to NaN on every reader (the w check precedes the empty return).
    const saU = new SlidingAggregate(1000, { panes: 8 });
    assertNaNPure(saU, () => saU.count(-1), 'SA unset count(-1) -> NaN');
    assertNaNPure(saU, () => saU.mean('x'), 'SA unset mean(non-number) -> NaN');
    const uOut = new Float64Array(5);
    assert.equal(saU.into(uOut, -1), 5, 'SA unset into bad w -> returns 5');
    assert.ok([...uOut].every(Number.isNaN), 'SA unset into bad w -> all 5 NaN slots');
    // UNSET + good w: count 0 / sum 0, mean / min / max NaN (empty, never fail-open)
    assert.equal(saU.count(), 0, 'SA unset count() -> 0');
    assert.equal(saU.sum(), 0, 'SA unset sum() -> 0');
    assert.ok(Number.isNaN(saU.mean()) && Number.isNaN(saU.min()) && Number.isNaN(saU.max()), 'SA unset mean/min/max NaN');
    // bad q: N/A; bad key: N/A -- skipped explicitly.
});

test('F12 DriftDetector: into wrong container / short -> throw pure; non-finite accumulator -> throw, out untouched; no q / w / key axis', () => {
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
    for (let i = 0; i < 400; i++) dd.add((i < 200 ? 0 : 10) + (i % 3) * 0.01);
    // WRONG CONTAINER TYPE (into) -> throw, state byte-identical (a programming error, not data)
    assertThrowsPure(dd, () => dd.into([0, 0, 0, 0, 0]), 'DD into(non-F64)');
    assertThrowsPure(dd, () => dd.into(new Float32Array(5)), 'DD into(Float32Array)');
    assertThrowsPure(dd, () => dd.into(new Proxy(new Float64Array(5), {})), 'DD into(Proxy)');
    assertThrowsPure(dd, () => dd.into(new Float64Array(4)), 'DD into(out too short)');
    // FAIL CLOSED: a non-finite accumulator throws the _guardFinite RangeError BEFORE any slot write,
    // so `out` is left untouched (never a partial write). DD.into has no w / q / key axis (no bad-VALUE
    // NaN branch): the only data-domain failure is the accumulator guard, which THROWS (fail closed).
    const bad = new DriftDetector(DRIFT_PH);
    for (let k = 0; k < 32; k++) bad.add((k < 16 ? 0 : 10) + k * 0.001);   // _n > 0 (a real, fired run)
    // The public API caps |x| <= DD_X_MAX and resets on a fire, so _guardFinite is defense-in-depth
    // (unreachable via add()); corrupt an accumulator directly to exercise the SAME guard the getters use.
    bad._gP = Infinity;
    const SENT = -987654.5;
    const out = new Float64Array(5); out.fill(SENT);
    const before = snap(bad);
    assert.throws(() => bad.into(out), /\[lite-adaptive\]/, 'DD into(non-finite accumulator) throws tagged');
    assert.equal(snap(bad), before, 'DD into(non-finite) left dd state byte-identical');
    for (let s = 0; s < 5; s++) assert.ok(Object.is(out[s], SENT), 'DD into(non-finite) slot ' + s + ' untouched (fail closed)');
});
