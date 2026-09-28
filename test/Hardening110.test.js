// @zakkster/lite-adaptive -- 1.10.0 H2 hardening RED-FIRST gate (ROADMAP 10.1, batch 1 T2).
//   run: node --test test/Hardening110.test.js
//
// Every FIX-DEPENDENT case is a node:test `todo` -- it prints `not ok ... # TODO` on the pristine
// (1.9.0) tree and turns green only after the batch that implements its fix. LIVE rows (legal
// positives, HEAD-number recordings) pass on HEAD today. Sections:
//   H2-1  SCM + SDD numeric domain: F1 (subnormal-pw huge clock), F2 (1e17 clock under-count),
//         F3 (subnormal W/panes builds) -> throws after batch 2; legal positives LIVE.
//   H2-4/H2-4b  the 17 container-gate sites: a Proxy / NaN-length / long-length subclass now throws
//         (a byte-identical no-op) after batch 3; on HEAD they slip through or throw a native error.
//   H2-3  latched-PH accumulator drift: the gated PH re-centre (v1.10.0 T8) bounds the latched
//         accumulators to max(|gP|,|gN|,|mMin|,|mMax|) <= th*2^20 + 30. LIVE via a fast-drift ramp
//         (a tiny threshold so the re-centre trips inside ~1e6 items); HEAD rate recorded at 1e6/1e7.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, DRIFT_PH, SlidingDDSketch, SlidingCountMin, DecayedReservoir } from '../Adaptive.js';

const LA = /\[lite-adaptive\]/;

// ===========================================================================
// H2-1 SCM + SDD numeric domain (batch 2). The clock-precision domain is |now| <= pw * 2^42 (and the
// count-mode tick <= that same bound); a subnormal pane width is rejected at the ctor door. Every
// out-of-domain now / tick is a FAIL-CLOSED, BYTE-IDENTICAL no-op: it throws [lite-adaptive] BEFORE
// any state write and leaves _mode / _now / _tick / _lastNow / _cur / _paneEnd (+ the pane counters)
// bit-identical -- proven with SlidingAggregate's rejectNoOp pattern, then ONE legal follow-up op
// must still succeed. This section has TEETH against the H2 review mutants: a moved / deleted range
// check (the check landing AFTER this._now = t, a dropped locked-branch check, a count-tick committed
// without its check, a removed `>= -nowMax` clause, or a deleted advance / advanceFrom check) each
// turns at least one row RED, because the reject then leaves state advanced (not byte-identical) or
// fails to throw at all.
// ===========================================================================

const SPAN = 4398046511104;   // 2^42 (SCM_/SLD_CLOCK_SPAN); nowMax = paneW * SPAN
const NM = (1000 / 32) * SPAN;   // W=1000 @ 32 panes -> pw = 31.25 -> nowMax = pw * 2^42

function nextUp(x) {
    const f = new Float64Array(1), u = new BigUint64Array(f.buffer);
    f[0] = x;
    if (x === 0) { u[0] = 1n; return f[0]; }
    if (x > 0) u[0] += 1n; else u[0] -= 1n;
    return f[0];
}
function nextDown(x) {
    const f = new Float64Array(1), u = new BigUint64Array(f.buffer);
    f[0] = x;
    if (x === 0) { u[0] = 0x8000000000000001n; return f[0]; }
    if (x > 0) u[0] -= 1n; else u[0] += 1n;
    return f[0];
}

// Snapshot the mutable pre-write state (SCM + SDD share the same time machine). _paneTotal is SCM's
// exact per-pane N; _paneCount is SDD's per-pane count -- copy whichever the instance carries so a
// mutant that binned a value before throwing is caught too.
function snap(o) {
    const s = { mode: o._mode, now: o._now, tick: o._tick, last: o._lastNow, cur: o._cur, pe: Array.from(o._paneEnd) };
    if (o._paneTotal) s.pt = Array.from(o._paneTotal);
    if (o._paneCount) s.pc = Array.from(o._paneCount);
    return s;
}
function sameSnap(a, b, msg) {
    for (const k of ['mode', 'now', 'tick', 'last', 'cur']) {
        assert.ok(Object.is(a[k], b[k]), msg + ' ' + k + ' drifted (' + a[k] + ' -> ' + b[k] + ')');
    }
    for (const k of ['pe', 'pt', 'pc']) {
        if (!a[k]) continue;
        assert.equal(a[k].length, b[k].length, msg + ' ' + k + ' length drifted');
        for (let i = 0; i < a[k].length; i++) assert.ok(Object.is(a[k][i], b[k][i]), msg + ' ' + k + '[' + i + '] drifted');
    }
}
// A rejected op throws [lite-adaptive] AND is a byte-identical no-op (state unchanged).
function rejectNoOp(o, fn, msg) {
    const before = snap(o);
    assert.throws(fn, LA, msg + ' must throw [lite-adaptive]');
    sameSnap(before, snap(o), msg + ' must be a byte-identical no-op');
}

// Per-class door descriptors: same 4 explicit-time ops, plus the count add + a legal read probe.
const DOMAIN_CLASSES = [
    {
        name: 'SCM',
        mk: () => new SlidingCountMin(1000, { panes: 32 }),
        add: (o, now) => o.add(now, 7),
        addFrom: (o, now) => o.addFrom(Float64Array.of(now, 7, 1), 0),
        advance: (o, now) => o.advance(now),
        advanceFrom: (o, now) => o.advanceFrom(Float64Array.of(now), 0),
        addCount: (o) => o.add(undefined, 7),
        tiny: (pw) => new SlidingCountMin(32 * pw, { panes: 32 }),
        read: (o) => o.estimate(7),
    },
    {
        name: 'SDD',
        mk: () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 32 }),
        add: (o, now) => o.add(now, 5),
        addFrom: (o, now) => o.addFrom(Float64Array.of(now, 5), 0),
        advance: (o, now) => o.advance(now),
        advanceFrom: (o, now) => o.advanceFrom(Float64Array.of(now), 0),
        addCount: (o) => o.add(undefined, 5),
        tiny: (pw) => new SlidingDDSketch(32 * pw, { alpha: 0.01, panes: 32 }),
        read: (o) => o.count(),
    },
];
const DOMAIN_OPS = ['add', 'addFrom', 'advance', 'advanceFrom'];

// The full fail-closed matrix: {add, addFrom, advance, advanceFrom} x {unset, locked-explicit} x
// {nextUp(+nowMax), nextDown(-nowMax)}. Each cell rejects as a byte-identical no-op, then one LEGAL
// follow-up (a now=0 add) succeeds. On a locked instance the negative edge is caught by the monotone
// door (lastNow=0), still a [lite-adaptive] no-op; on an unset instance it is caught by the range door
// (no monotone guard) -- which is exactly the `>= -nowMax` clause the noneg mutant deletes.
for (const c of DOMAIN_CLASSES) {
    test('H2-1 ' + c.name + ' domain matrix: {add,addFrom,advance,advanceFrom} x {unset,locked} x {+nowMax,-nowMax} reject as byte-identical no-ops', () => {
        for (const op of DOMAIN_OPS) {
            for (const state of ['unset', 'locked']) {
                for (const edge of ['pos', 'neg']) {
                    const o = c.mk();
                    if (state === 'locked') c.add(o, 0);   // lock EXPLICIT at now = 0
                    const bad = edge === 'pos' ? nextUp(NM) : nextDown(-NM);
                    rejectNoOp(o, () => c[op](o, bad), c.name + ' ' + op + ' ' + state + ' ' + edge);
                    // one LEGAL follow-up op must still succeed (now = 0 is in-domain + monotone).
                    c.add(o, 0);
                    assert.ok(c.read(o) >= 1, c.name + ' ' + op + ' ' + state + ' ' + edge + ': legal follow-up add must register');
                }
            }
        }
    });

    test('H2-1 ' + c.name + ' accepted edges: now = +nowMax and now = -nowMax build + read (inclusive bound)', () => {
        const op = c.mk(); c.add(op, NM); assert.ok(c.read(op) >= 1, c.name + ' +nowMax accepted');
        const on = c.mk(); c.add(on, -NM); assert.ok(c.read(on) >= 1, c.name + ' -nowMax accepted');
    });

    test('H2-1 ' + c.name + ' count-mode bound (W=32*2^-40 @ 32 panes -> nowMax=4): 4 adds pass, 5th throws (_tick unchanged), clear reopens', () => {
        const o = c.tiny(2 ** -40);   // pw = 2^-40 -> nowMax = 2^-40 * 2^42 = 4
        assert.equal(o._nowMax, 4, c.name + ' nowMax must be exactly 4');
        for (let n = 1; n <= 4; n++) c.addCount(o);
        assert.equal(o._tick, 4, c.name + ' _tick after 4 count adds');
        const before = snap(o);
        assert.throws(() => c.addCount(o), LA, c.name + ' 5th count add (tick 5 > nowMax 4) must throw');
        assert.equal(o._tick, 4, c.name + ' _tick must stay 4 after the rejected 5th add');
        sameSnap(before, snap(o), c.name + ' rejected 5th count add is a no-op');
        o.clear();
        c.addCount(o);
        assert.equal(o._tick, 1, c.name + ' clear() reopens count mode (tick back to 1)');
    });

    test('H2-1 ' + c.name + ' count-mode first-add overflow (nowMax < 1): the FIRST count add throws as a no-op', () => {
        const o = c.tiny(2 ** -44);   // pw = 2^-44 -> nowMax = 0.25 < 1 -> even tick 1 is out of domain
        assert.ok(o._nowMax < 1, c.name + ' nowMax must be < 1');
        const before = snap(o);
        assert.throws(() => c.addCount(o), LA, c.name + ' first count add (tick 1 > nowMax) must throw');
        sameSnap(before, snap(o), c.name + ' rejected first count add is a no-op (unset)');
        // a legal explicit add at now <= nowMax still works: the domain is a bound, not a wall.
        c.add(o, 0.2);
        assert.ok(c.read(o) >= 1, c.name + ' a legal small-clock explicit add still registers');
    });
}

// --- F3: a subnormal W/panes is rejected at the ctor door (BUILD throws /subnormal/), before any alloc. ---
test('H2-1 SCM F3: SCM(1500*2**-1074, {panes:1024}) ctor must THROW /subnormal/ (HEAD built a broken grid)', () => {
    assert.throws(() => new SlidingCountMin(1500 * 2 ** -1074, { panes: 1024 }),
        (e) => e instanceof RangeError && /subnormal/.test(e.message) && LA.test(e.message),
        'a subnormal W/panes must throw /subnormal/ [lite-adaptive]');
});
test('H2-1 SDD F3: SDD(1500*2**-1074, {panes:1024}) ctor must THROW /subnormal/ (HEAD built a broken grid)', () => {
    assert.throws(() => new SlidingDDSketch(1500 * 2 ** -1074, { alpha: 0.01, panes: 1024 }),
        (e) => e instanceof RangeError && /subnormal/.test(e.message) && LA.test(e.message),
        'a subnormal W/panes must throw /subnormal/ [lite-adaptive]');
});

// --- Legal positives (LIVE): typical epoch / perf.now configs build + 3 adds + an exact readout, plus
//     the count-mode default. These must keep passing after the domain bound lands (a real, generous bound). ---
const SCM_LEGAL = [
    { label: 'epoch-ms W=1000 @ 32 panes', W: 1000, panes: 32, now: 1.75e12 },
    { label: 'epoch-ms W=60000 @ 32 panes', W: 60000, panes: 32, now: 1.75e12 },
    { label: 'epoch-ms W=100 @ 32 panes', W: 100, panes: 32, now: 1.75e12 },
    { label: 'epoch-ms W=1000 @ 1024 panes', W: 1000, panes: 1024, now: 1.75e12 },
    { label: 'epoch-ms W=16 @ 32 panes', W: 16, panes: 32, now: 1.75e12 },
    { label: 'epoch-us W=1e6 @ 32 panes', W: 1e6, panes: 32, now: 1.75e15 },
    { label: 'epoch-us W=1e5 @ 32 panes', W: 1e5, panes: 32, now: 1.75e15 },
    { label: 'perf.now W=16 @ 32 panes', W: 16, panes: 32, now: 1e6 },
    { label: 'perf.now W=1 @ 32 panes', W: 1, panes: 32, now: 1e6 },
];
test('H2-1 SCM legal positives (LIVE): every section-2 config builds + 3 adds + exact estimate', () => {
    for (const cfg of SCM_LEGAL) {
        const scm = new SlidingCountMin(cfg.W, { panes: cfg.panes });
        scm.add(cfg.now, 7); scm.add(cfg.now, 7); scm.add(cfg.now, 7);
        assert.equal(scm.estimate(7), 3, cfg.label + ': estimate(7) must be exactly 3');
    }
    for (const W of [1000, 32]) {
        const scm = new SlidingCountMin(W, { panes: 32 });
        scm.add(undefined, 7); scm.add(undefined, 7); scm.add(undefined, 7);
        assert.equal(scm.estimate(7), 3, 'count-mode W=' + W + ': estimate(7) must be exactly 3');
    }
});
test('H2-1 SDD legal positives (LIVE): every section-2 config builds + 3 adds + exact count', () => {
    for (const cfg of SCM_LEGAL) {
        const sd = new SlidingDDSketch(cfg.W, { alpha: 0.01, panes: cfg.panes });
        sd.add(cfg.now, 5); sd.add(cfg.now, 5); sd.add(cfg.now, 5);
        assert.equal(sd.count(), 3, cfg.label + ': count() must be exactly 3');
        assert.ok(sd.quantile(0.5) > 0, cfg.label + ': q50 must be a positive value');
    }
    for (const W of [1000, 32]) {
        const sd = new SlidingDDSketch(W, { alpha: 0.01, panes: 32 });
        sd.add(undefined, 5); sd.add(undefined, 5); sd.add(undefined, 5);
        assert.equal(sd.count(), 3, 'count-mode W=' + W + ': count() must be exactly 3');
    }
});

// ===========================================================================
// H2-4 / H2-4b container gates (batch 3). One row per site. A Proxy of a Float64Array, a NaN-length
// subclass, and a long-length subclass (backing 8, index beyond it) each must throw a byte-identical
// [lite-adaptive] no-op after the fix. On HEAD the Proxy throws a NATIVE TypedArray error (not
// [lite-adaptive]) and the length-lying subclasses slip through (no throw, or state corruption).
// ===========================================================================
class NaNLen extends Float64Array { get length() { return NaN; } }
class LongLen extends Float64Array { get length() { return 1e9; } }
function fill(buf, vals) { for (let k = 0; k < vals.length; k++) buf[k] = vals[k]; return buf; }
// A TRANSPARENT Proxy over a Float64Array: it forwards length + element reads (methods bound to the
// target), so `instanceof`, `.length` and `buf[i]` all behave like the real array. The ONLY thing that
// distinguishes it from a real Float64Array is ArrayBuffer.isView, which returns false for any Proxy
// (no internal slot). So the isView gate is the SOLE line rejecting it: with the gate it is a
// byte-identical [lite-adaptive] no-op (H2-6: the thrower names it inertly via describeArg -> 'an object',
// never String(buf)); revert the gate to `instanceof` alone and the Proxy sails through and mutates state
// (no throw) -- the mutant's row RED.
function transProxy(f64) {
    return new Proxy(f64, { get(t, k) { const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } });
}
function proxyOf(vals) { return transProxy(fill(new Float64Array(Math.max(vals.length, 8)), vals)); }
function proxyOut() { return transProxy(new Float64Array(64)); }
function nanLenOf(vals) { return fill(new NaNLen(Math.max(vals.length, 8)), vals); }
function longLenOf(vals) { return fill(new LongLen(8), vals); }   // backing 8, claims 1e9 -> read at i=100 is undefined

// index/input sites: (buf, i). The proxy (isView gate) + nanLen (NaN-safe bound) are the CONTAINER
// forms (H2-4, batch 3, LIVE now). The longLen case reads buf[100] = undefined and is caught only by
// the H2-4b value form (batch 3b) -- it is SPLIT into its own todo row so batch 3 stays green.
function indexSite(name, id, make, prep, method, vals) {
    test('H2-4 ' + name + ': a Proxy (isView) / NaN-length (NaN-safe bound) buffer is a [lite-adaptive] no-op', () => {
        // Proxy: only ArrayBuffer.isView rejects it (instanceof + reads all forward); reverting the gate
        // to `instanceof` alone lets it through -> no throw -> this row goes RED (the mutant control).
        {
            const inst = make(); if (prep) prep(inst);
            assert.throws(() => inst[method](proxyOf(vals), 0), LA, name + ' (proxy) must throw [lite-adaptive]');
        }
        // NaN-length subclass: the NaN-safe bound !(i + k < NaN) rejects it via the real [lite-adaptive] thrower.
        {
            const inst = make(); if (prep) prep(inst);
            assert.throws(() => inst[method](nanLenOf(vals), 0), LA, name + ' (nanLen) must throw [lite-adaptive]');
        }
    });
    test('H2-4b ' + name + ': a long-length buffer must THROW [lite-adaptive] (undefined read)', () => {
        const inst = make(); if (prep) prep(inst);
        assert.throws(() => inst[method](longLenOf(vals), 100), LA, name + ' (longLen) must throw [lite-adaptive]');
    });
}
// reader out-buffer sites: the transparent Proxy out is rejected only by the isView gate (same as the
// index sites) -> a [lite-adaptive] no-op; reverting the gate lets the writer run -> no throw -> row RED.
function outSite(name, id, make, prep, call) {
    test('H2-4 ' + name + ': a Proxy out-buffer is a [lite-adaptive] no-op (isView gate)', () => {
        const inst = make(); if (prep) prep(inst);
        assert.throws(() => call(inst, proxyOut()), LA, name + ' (proxy out) must throw [lite-adaptive]');
    });
}

const NOW = 1.75e12;
indexSite('EH.addFrom', 'H2-4 batch 3', () => new ExponentialHistogram(1000, 0.01), null, 'addFrom', [NOW, 5]);
indexSite('EH.advanceFrom', 'H2-4 batch 3', () => new ExponentialHistogram(1000, 0.01), (o) => o.add(NOW, 5), 'advanceFrom', [NOW + 10]);
indexSite('ADWIN.addFrom', 'H2-4 batch 3', () => new ADWIN(0.1), null, 'addFrom', [0.5]);
indexSite('FD.addFrom', 'H2-4 batch 3', () => new ForwardDecay(1e9), null, 'addFrom', [NOW, 5]);
indexSite('HK.addFrom', 'H2-4 batch 3', () => new HeavyKeeper(4, 512, 16, { seed: 4 }), null, 'addFrom', [7, 1]);
outSite('HK.topKInto', 'H2-4 batch 3', () => new HeavyKeeper(4, 512, 16, { seed: 4 }), (o) => o.add(7, 1), (o, out) => o.topKInto(out));
indexSite('SHLL.addFrom', 'H2-4 batch 3', () => new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }), null, 'addFrom', [NOW, 7]);
indexSite('SHLL.advanceFrom', 'H2-4 batch 3', () => new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }), (o) => o.add(NOW, 7), 'advanceFrom', [NOW + 10]);
indexSite('DD.addFrom', 'H2-4 batch 3', () => new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 }), null, 'addFrom', [0.5]);
indexSite('SDD.addFrom', 'H2-4 batch 3', () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), null, 'addFrom', [NOW, 5]);
outSite('SDD.quantileInto', 'H2-4 batch 3', () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), (o) => o.add(NOW, 5), (o, out) => o.quantileInto(Float64Array.of(0.5, 0.9, 0.99), out));
indexSite('SDD.advanceFrom', 'H2-4 batch 3', () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), (o) => o.add(NOW, 5), 'advanceFrom', [NOW + 10]);
indexSite('SCM.addFrom', 'H2-4 batch 3', () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), null, 'addFrom', [NOW, 7, 1]);
outSite('SCM.estimateInto', 'H2-4 batch 3', () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), (o) => o.add(NOW, 7), (o, out) => o.estimateInto(Float64Array.of(7, 1, 2), out));
indexSite('SCM.advanceFrom', 'H2-4 batch 3', () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), (o) => o.add(NOW, 7), 'advanceFrom', [NOW + 10]);
indexSite('DR.addFrom', 'H2-4 batch 3', () => new DecayedReservoir(32, 1e5, { seed: 7 }), null, 'addFrom', [NOW, 5]);
outSite('DR.sampleInto', 'H2-4 batch 3', () => new DecayedReservoir(32, 1e5, { seed: 7 }), (o) => o.add(NOW, 5), (o, out) => o.sampleInto(out));

// H2-4b: after a long-length addFrom attempt, DriftDetector.mean must stay FINITE (an undefined read
// no longer corrupts the accumulators). On HEAD the undefined read drives _mean to NaN.
test('H2-4b DD.addFrom: a long-length buffer must NOT corrupt state (mean stays finite)', () => {
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
    dd.add(0.5); dd.add(0.6);
    let threw = false; try { dd.addFrom(longLenOf([0.5]), 100); } catch (e) { threw = true; }
    assert.ok(threw, 'the long-length addFrom must throw');
    let finite; try { finite = Number.isFinite(dd.mean); } catch (e) { finite = false; }
    assert.ok(finite, 'DriftDetector.mean must stay finite after a rejected long-length addFrom');
});

// ===========================================================================
// H2-3 latched-PH accumulator drift (v1.10.0 T8). Without the re-centre, a latched PH accumulator
// drifts unbounded on an infinite same-direction signal (phSquare at th=5: ~0.078/item; it would
// only trip the natural th*2^20 bound past ~6.7e7 items -- too slow for npm test). The gated
// re-centre (gP -= mMin; mMin = 0; gN -= mMax; mMax = 0 once max(|mMin|,|mMax|) > th*2^20) caps all
// four accumulators at th*2^20 + 30. To OBSERVE that cap fast, phRampDrift uses a tiny threshold
// (th 0.01) and a linear ramp so gN/mMax ratchet ~1/item and the re-centre trips within ~200 items.
// ===========================================================================
function phSquare(N) {
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5, latch: true });
    const buf = new Float64Array(1);
    for (let i = 0; i < N; i++) { buf[0] = ((i & 63) < 32) ? 0 : 10; dd.addFrom(buf, 0); }
    return { gP: dd._gP, gN: dd._gN, mMin: dd._mMin, mMax: dd._mMax };
}
test('H2-3 phSquare: HEAD RECORD -- latched-PH accumulators drift below the re-centre span (rate/item at 1e6 and 1e7)', () => {
    for (const N of [1e6, 1e7]) {
        const s = phSquare(N);
        const mx = Math.max(Math.abs(s.gP), Math.abs(s.gN), Math.abs(s.mMin), Math.abs(s.mMax));
        console.log('    [rate] phSquare N=' + N + ' max|acc|=' + mx.toFixed(3) + ' drift-rate/item=' + (mx / N).toExponential(4));
        // th=5 => span = 5*2^20 ~ 5.24e6, unreached below ~6.7e7 items, so drift is still visible here.
        assert.ok(mx > 30, 'below the re-centre span the drift is still visible; max|acc|=' + mx);
    }
});
// LIVE (v1.10.0 T8): the fast-drift ramp trips the re-centre inside ~1e6 items. Assert both the
// bound holds AND at least one re-centre fired -- observed through the raw mMax accumulator being
// driven above half the span then dropping (the re-centre zeroes it). Prove-RED: delete the
// re-centre line in _fired's arming/opposite/sustained branches and mMax climbs to ~N here.
test('H2-3 phRampDrift: gated re-centre bounds the latched-PH accumulators to th*2^20 + 30 and fires', () => {
    const TH = 0.01, DELTA = 0.005, N = 1000000;
    const SPAN = TH * 1048576;                 // DD_RECENTRE_SPAN * th
    const dd = new DriftDetector(DRIFT_PH, { delta: DELTA, threshold: TH, latch: true });
    const buf = new Float64Array(1);
    let recentres = 0, prevMMax = 0, prevMMin = 0, maxAcc = 0;
    for (let i = 0; i < N; i++) {
        buf[0] = i;                            // linear ramp: dev stays positive, gN/mMax ratchet up
        dd.addFrom(buf, 0);
        // a raw accumulator that had climbed past half the span then snapped to 0 is a re-centre.
        if (dd._mMax === 0 && prevMMax > SPAN * 0.5) recentres++;
        if (dd._mMin === 0 && prevMMin < -SPAN * 0.5) recentres++;
        prevMMax = dd._mMax; prevMMin = dd._mMin;
        const acc = Math.max(Math.abs(dd._gP), Math.abs(dd._gN), Math.abs(dd._mMin), Math.abs(dd._mMax));
        if (acc > maxAcc) maxAcc = acc;
    }
    assert.ok(maxAcc <= SPAN + 30, 'latched-PH accumulators must stay <= th*2^20 + 30 (' + (SPAN + 30).toFixed(1) + '), got max|acc|=' + maxAcc);
    assert.ok(recentres > 0, 'at least one PH re-centre must fire (raw accumulator dropping); recentres=' + recentres);
});

// Beyond-rule: the re-centre must not corrupt direction reporting. After it has fired repeatedly on a
// long upward drift (latched dir +1), a hard downward reversal is still reported with lastDirection -1.
test('H2-3 phReversalAfterDrift: a latched-PH reversal AFTER the re-centre fired reports direction -1', () => {
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 0.01, latch: true });
    const buf = new Float64Array(1);
    const SPAN = 0.01 * 1048576;
    let recentres = 0, prevMMax = 0, prevMMin = 0;
    for (let i = 0; i < 200000; i++) {
        buf[0] = i; dd.addFrom(buf, 0);
        if ((dd._mMax === 0 && prevMMax > SPAN * 0.5) || (dd._mMin === 0 && prevMMin < -SPAN * 0.5)) recentres++;
        prevMMax = dd._mMax; prevMMin = dd._mMin;
    }
    assert.ok(recentres > 0, 'precondition: the re-centre must have fired during the drift; recentres=' + recentres);
    assert.equal(dd.lastDirection, 1, 'latched upward before the reversal');
    let fired = false;
    for (let i = 0; i < 5000 && !fired; i++) { buf[0] = -1e6; fired = dd.addFrom(buf, 0); }
    assert.ok(fired, 'the downward reversal must fire');
    assert.equal(dd.lastDirection, -1, 'a reversal after drift must be reported downward (-1)');
});

// Beyond-rule: latch still fires EXACTLY once per sustained regime (the T8 re-centre changes only the
// bounding, not the one-fire-per-regime contract).
test('H2-3 sustainedStep: latched-PH fires exactly once per sustained regime, correct directions', () => {
    const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5, latch: true });
    const buf = new Float64Array(1);
    const dirs = [];
    const seg = [[0, 2000], [100, 50000], [0, 50000]];   // baseline, sustained up, sustained down
    for (const [val, n] of seg) for (let i = 0; i < n; i++) { buf[0] = val; if (dd.addFrom(buf, 0)) dirs.push(dd.lastDirection); }
    assert.deepEqual(dirs, [1, -1], 'one fire per regime, up then down; got ' + JSON.stringify(dirs));
});
