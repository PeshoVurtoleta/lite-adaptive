// @zakkster/lite-adaptive -- H2-6 TRAP-FREE REJECT gate (ROADMAP 10.1 section 1).
//
// A rejected mutating call must be a BYTE-IDENTICAL no-op. Before H2-6 every reject message was built
// as `'...got ' + String(userArg)`; when `userArg` is a Proxy (or any object with toString / valueOf /
// Symbol.toPrimitive), `String()` RAN caller code AFTER the guard had already decided to reject, so a
// re-entrant trap could mutate the same instance -- the "no-op" reject was not a no-op (fail-open).
//
// This gate drives every public method that validates an argument, for all ten classes (ctors + the two
// static withAccuracy factories included), with a HOSTILE object in the checked slot: a Proxy whose
// get / has / ownKeys / getPrototypeOf traps AND toString / valueOf / Symbol.toPrimitive methods each
// increment a shared counter and call a MUTATING method on a previously built victim instance of the
// same class. Typed-array slots are also covered with a Proxy-OVER-Float64Array (the anytrap case).
//
// Assertions per row: the call throws `[lite-adaptive]`; the counter === 0 (no caller code ran, because
// the fix names the arg via `describeArg`, which uses only typeof + ArrayBuffer.isView -- never a trap --
// and `String` only on a primitive); a full internal snapshot of BOTH the victim and the operated
// instance is unchanged.
//
// MUTANT: revert `describeArg` -> `String` at ONE site inside SCM.estimateInto, SA.into, DD.addFrom, or
// EH.add(now), and that row goes RED (the trap fires -> counter > 0 -> the victim mutates).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, SlidingDDSketch, SlidingCountMin, DecayedReservoir, SlidingAggregate,
    DRIFT_PH,
} from '../Adaptive.js';

const LA = /\[lite-adaptive\]/;

/** A full internal snapshot: every own data field, typed arrays expanded, order-stable. */
function snapshot(inst) {
    const parts = [];
    for (const n of Object.getOwnPropertyNames(inst).sort()) {
        let v;
        try { v = inst[n]; } catch { parts.push(n + '=<throw>'); continue; }
        if (typeof v === 'function') continue;
        if (ArrayBuffer.isView(v)) parts.push(n + '=[' + Array.from(v).join(',') + ']');
        else if (v && typeof v === 'object') parts.push(n + '=<obj>');
        else parts.push(n + '=' + String(v));
    }
    return parts.join('|');
}

/** Build a hostile Proxy (plain-object target) bound to `state`; any observation bumps + re-enters. */
function hostileObj(state) {
    const bump = () => { state.count++; try { state.mutate(state.victim); } catch { /* keep going */ } return 1; };
    const touch = () => { state.count++; try { state.mutate(state.victim); } catch { /* keep going */ } };
    return new Proxy({}, {
        get(t, k, r) {
            touch();
            if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') return bump;
            return Reflect.get(t, k, r);
        },
        has(t, k) { touch(); return Reflect.has(t, k); },
        ownKeys(t) { touch(); return Reflect.ownKeys(t); },
        getPrototypeOf(t) { touch(); return Reflect.getPrototypeOf(t); },
    });
}

/** A hostile Proxy OVER a real Float64Array: instanceof passes, ArrayBuffer.isView does not (no slot). */
function hostileF64(state) {
    const bump = () => { state.count++; try { state.mutate(state.victim); } catch { /* keep going */ } return 1; };
    const touch = () => { state.count++; try { state.mutate(state.victim); } catch { /* keep going */ } };
    const f = new Float64Array(8);
    for (let i = 0; i < 8; i++) f[i] = i + 1;
    return new Proxy(f, {
        get(t, k, r) {
            touch();
            if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') return bump;
            const v = Reflect.get(t, k, r);
            return typeof v === 'function' ? v.bind(t) : v;
        },
        has(t, k) { touch(); return Reflect.has(t, k); },
        ownKeys(t) { touch(); return Reflect.ownKeys(t); },
        getPrototypeOf(t) { touch(); return Reflect.getPrototypeOf(t); },
    });
}

/**
 * Drive one class. `cases` are {label, kind:'obj'|'f64', ctor?, prep?, invoke(inst, hostile)}.
 * ctor cases ignore `inst` (the ctor itself throws); non-ctor cases prep an operated instance.
 */
function drive(name, makeInst, mutate, cases) {
    for (const c of cases) {
        test('H2-6 ' + name + ': ' + c.label + ' -- hostile arg is a trap-free [lite-adaptive] no-op', () => {
            const state = { count: 0, victim: makeInst(), mutate };
            mutate(state.victim);                       // give the victim real state to corrupt
            const vBefore = snapshot(state.victim);
            const hostile = c.kind === 'f64' ? hostileF64(state) : hostileObj(state);

            let inst = null, iBefore = null;
            if (!c.ctor) {
                inst = makeInst();
                (c.prep || mutate)(inst);
                iBefore = snapshot(inst);
            }

            assert.throws(() => c.invoke(inst, hostile), LA, c.label + ' must throw [lite-adaptive]');
            assert.equal(state.count, 0,
                c.label + ' ran caller code during the reject (counter=' + state.count + ') -- String() on a hostile arg');
            assert.equal(snapshot(state.victim), vBefore, c.label + ' mutated the victim (re-entrant trap fired)');
            if (!c.ctor) assert.equal(snapshot(inst), iBefore, c.label + ' was not a byte-identical no-op');
        });
    }
}

const NOW = 1.75e12;
const F64OK = () => Float64Array.of(NOW, 5, NOW, 5, NOW, 5, NOW, 5);   // a benign valid buffer for the OTHER slot

// ---- ExponentialHistogram ------------------------------------------------
drive('ExponentialHistogram', () => new ExponentialHistogram(1000, 0.01), (o) => o.add(NOW, 5), [
    { label: 'ctor W', ctor: true, kind: 'obj', invoke: (_, h) => new ExponentialHistogram(h, 0.01) },
    { label: 'ctor epsilon', ctor: true, kind: 'obj', invoke: (_, h) => new ExponentialHistogram(1000, h) },
    { label: 'add(now)', kind: 'obj', invoke: (o, h) => o.add(h, 5) },
    { label: 'add(value)', kind: 'obj', invoke: (o, h) => o.add(NOW, h) },
    { label: 'addFrom(buf) obj', kind: 'obj', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(F64OK(), h) },
    { label: 'advance(now)', kind: 'obj', invoke: (o, h) => o.advance(h) },
    { label: 'advanceFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.advanceFrom(h, 0) },
]);

// ---- ADWIN ---------------------------------------------------------------
drive('ADWIN', () => new ADWIN(0.1), (o) => o.add(0.5), [
    { label: 'ctor delta', ctor: true, kind: 'obj', invoke: (_, h) => new ADWIN(h) },
    { label: 'add(x)', kind: 'obj', invoke: (o, h) => o.add(h) },
    { label: 'addFrom(buf) obj', kind: 'obj', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(Float64Array.of(0.5, 0.5), h) },
]);

// ---- ForwardDecay --------------------------------------------------------
drive('ForwardDecay', () => new ForwardDecay(1e9), (o) => o.add(NOW, 5), [
    { label: 'ctor halfLife', ctor: true, kind: 'obj', invoke: (_, h) => new ForwardDecay(h) },
    { label: 'add(now)', kind: 'obj', invoke: (o, h) => o.add(h, 5) },
    { label: 'add(value)', kind: 'obj', invoke: (o, h) => o.add(NOW, h) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(F64OK(), h) },
]);

// ---- HeavyKeeper ---------------------------------------------------------
drive('HeavyKeeper', () => new HeavyKeeper(4, 512, 16, { seed: 4 }), (o) => o.add(7, 1), [
    { label: 'ctor d', ctor: true, kind: 'obj', invoke: (_, h) => new HeavyKeeper(h, 512, 16) },
    { label: 'ctor w', ctor: true, kind: 'obj', invoke: (_, h) => new HeavyKeeper(4, h, 16) },
    { label: 'ctor k', ctor: true, kind: 'obj', invoke: (_, h) => new HeavyKeeper(4, 512, h) },
    { label: 'withAccuracy k', ctor: true, kind: 'obj', invoke: (_, h) => HeavyKeeper.withAccuracy(h, 0.01) },
    { label: 'withAccuracy targetError', ctor: true, kind: 'obj', invoke: (_, h) => HeavyKeeper.withAccuracy(16, h) },
    { label: 'add(key)', kind: 'obj', invoke: (o, h) => o.add(h, 1) },
    { label: 'add(weight)', kind: 'obj', invoke: (o, h) => o.add(7, h) },
    { label: 'addFrom(buf) obj', kind: 'obj', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(Float64Array.of(7, 1), h) },
    { label: 'topKInto(buf) obj', kind: 'obj', invoke: (o, h) => o.topKInto(h) },
    { label: 'topKInto(buf) f64', kind: 'f64', invoke: (o, h) => o.topKInto(h) },
    { label: 'forEach(fn)', kind: 'obj', invoke: (o, h) => o.forEach(h) },
]);

// ---- SlidingHyperLogLog --------------------------------------------------
drive('SlidingHyperLogLog', () => new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }), (o) => o.add(NOW, 7), [
    { label: 'ctor W', ctor: true, kind: 'obj', invoke: (_, h) => new SlidingHyperLogLog(h, { p: 10 }) },
    { label: 'add(now)', kind: 'obj', invoke: (o, h) => o.add(h, 7) },
    { label: 'add(key)', kind: 'obj', invoke: (o, h) => o.add(NOW, h) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(Float64Array.of(NOW, 7), h) },
    { label: 'advance(now)', kind: 'obj', invoke: (o, h) => o.advance(h) },
    { label: 'advanceFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.advanceFrom(h, 0) },
]);

// ---- DriftDetector -------------------------------------------------------
drive('DriftDetector', () => new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 }), (o) => o.add(0.5), [
    { label: 'ctor mode', ctor: true, kind: 'obj', invoke: (_, h) => new DriftDetector(h) },
    { label: 'add(x)', kind: 'obj', invoke: (o, h) => o.add(h) },
    { label: 'addFrom(buf) obj', kind: 'obj', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(Float64Array.of(0.5, 0.5), h) },
]);

// ---- SlidingDDSketch -----------------------------------------------------
drive('SlidingDDSketch', () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), (o) => o.add(NOW, 5), [
    { label: 'ctor W', ctor: true, kind: 'obj', invoke: (_, h) => new SlidingDDSketch(h, { alpha: 0.01 }) },
    { label: 'add(now)', kind: 'obj', invoke: (o, h) => o.add(h, 5) },
    { label: 'add(value)', kind: 'obj', invoke: (o, h) => o.add(NOW, h) },
    { label: 'quantileInto(qs) obj', kind: 'obj', invoke: (o, h) => o.quantileInto(h, new Float64Array(3)) },
    { label: 'quantileInto(out) f64', kind: 'f64', invoke: (o, h) => o.quantileInto(Float64Array.of(0.5, 0.9, 0.99), h) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(F64OK(), h) },
    { label: 'advance(now)', kind: 'obj', invoke: (o, h) => o.advance(h) },
    { label: 'advanceFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.advanceFrom(h, 0) },
]);

// ---- SlidingCountMin -----------------------------------------------------
drive('SlidingCountMin', () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), (o) => o.add(NOW, 7, 1), [
    { label: 'ctor W', ctor: true, kind: 'obj', invoke: (_, h) => new SlidingCountMin(h) },
    { label: 'withAccuracy W', ctor: true, kind: 'obj', invoke: (_, h) => SlidingCountMin.withAccuracy(h, 0.01, 0.01) },
    { label: 'withAccuracy epsilon', ctor: true, kind: 'obj', invoke: (_, h) => SlidingCountMin.withAccuracy(1000, h, 0.01) },
    { label: 'withAccuracy delta', ctor: true, kind: 'obj', invoke: (_, h) => SlidingCountMin.withAccuracy(1000, 0.01, h) },
    { label: 'add(now)', kind: 'obj', invoke: (o, h) => o.add(h, 7, 1) },
    { label: 'add(key)', kind: 'obj', invoke: (o, h) => o.add(NOW, h, 1) },
    { label: 'add(count)', kind: 'obj', invoke: (o, h) => o.add(NOW, 7, h) },
    { label: 'estimateInto(keys) obj', kind: 'obj', invoke: (o, h) => o.estimateInto(h, new Float64Array(3)) },
    { label: 'estimateInto(keys) f64', kind: 'f64', invoke: (o, h) => o.estimateInto(h, new Float64Array(8)) },
    { label: 'estimateInto(out) f64', kind: 'f64', invoke: (o, h) => o.estimateInto(Float64Array.of(7), h) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(Float64Array.of(NOW, 7, 1), h) },
    { label: 'advance(now)', kind: 'obj', invoke: (o, h) => o.advance(h) },
    { label: 'advanceFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.advanceFrom(h, 0) },
]);

// ---- DecayedReservoir ----------------------------------------------------
drive('DecayedReservoir', () => new DecayedReservoir(32, 1e5, { seed: 7 }), (o) => o.add(NOW, 5), [
    { label: 'ctor k', ctor: true, kind: 'obj', invoke: (_, h) => new DecayedReservoir(h, 1e5) },
    { label: 'ctor halfLife', ctor: true, kind: 'obj', invoke: (_, h) => new DecayedReservoir(32, h) },
    { label: 'add(now)', kind: 'obj', invoke: (o, h) => o.add(h, 5) },
    { label: 'add(value)', kind: 'obj', invoke: (o, h) => o.add(NOW, h) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(F64OK(), h) },
    { label: 'sampleInto(buf) obj', kind: 'obj', invoke: (o, h) => o.sampleInto(h) },
    { label: 'sampleInto(buf) f64', kind: 'f64', invoke: (o, h) => o.sampleInto(h) },
    { label: 'forEach(fn)', kind: 'obj', invoke: (o, h) => o.forEach(h) },
]);

// ---- SlidingAggregate ----------------------------------------------------
drive('SlidingAggregate', () => new SlidingAggregate(1000, { panes: 8 }), (o) => o.add(NOW, 5), [
    { label: 'ctor W', ctor: true, kind: 'obj', invoke: (_, h) => new SlidingAggregate(h) },
    { label: 'add(now)', kind: 'obj', invoke: (o, h) => o.add(h, 5) },
    { label: 'add(value)', kind: 'obj', invoke: (o, h) => o.add(NOW, h) },
    { label: 'into(out) obj', kind: 'obj', invoke: (o, h) => o.into(h) },
    { label: 'into(out) f64', kind: 'f64', invoke: (o, h) => o.into(h) },
    { label: 'addFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.addFrom(h, 0) },
    { label: 'addFrom(i)', kind: 'obj', invoke: (o, h) => o.addFrom(F64OK(), h) },
    { label: 'advance(now)', kind: 'obj', invoke: (o, h) => o.advance(h) },
    { label: 'advanceFrom(buf) f64', kind: 'f64', invoke: (o, h) => o.advanceFrom(h, 0) },
]);

// ---- the anytrap.mjs cases, made explicit (a get-trap Proxy-over-Float64Array) -------------------
test('H2-6 anytrap: SCM.estimateInto / SA.into / DD.addFrom leave total / count untouched on reject', () => {
    // SlidingCountMin: total() must stay at the single add, not jump because a trap re-added during String().
    {
        const scm = new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 });
        scm.add(NOW, 7, 1);
        const before = scm.total();
        const px = new Proxy(new Float64Array(8), { get(t, k) { scm.add(NOW, 2, 1); const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } });
        assert.throws(() => scm.estimateInto(px, new Float64Array(8)), LA);
        assert.equal(scm.total(), before, 'SCM.total drifted -- a trap re-added during the reject');
    }
    // SlidingAggregate: count() must stay at 1.
    {
        const sa = new SlidingAggregate(1000, { panes: 8 });
        sa.add(NOW, 5);
        const before = sa.count();
        const px = new Proxy(new Float64Array(8), { get(t, k) { sa.add(NOW, 5); const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } });
        assert.throws(() => sa.into(px), LA);
        assert.equal(sa.count(), before, 'SA.count drifted -- a trap re-added during the reject');
    }
    // DriftDetector: count must stay at 1.
    {
        const dd = new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 });
        dd.add(0.5);
        const before = dd.count;
        const px = new Proxy(new Float64Array(8), { get(t, k) { dd.add(0.5); const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } });
        assert.throws(() => dd.addFrom(px, 0), LA);
        assert.equal(dd.count, before, 'DD.count drifted -- a trap re-added during the reject');
    }
});

// ---- H34 container-length rows (container-length threat model, SETTLED 2026-09-28). Two regimes:
//   COLD render readers (topKInto / quantileInto / estimateInto / sampleInto / into) read the length
//     through the INTRINSIC %TypedArray%.length getter (TA_LEN), so a tampered `length` (a subclass
//     getter, or an own accessor returning an object with valueOf) is NEVER invoked: 0 caller code, and
//     the reject / no-op is byte-identical. A too-small (0-slot) backing forces the reject (out sites)
//     or an empty read-only answer (arg sites).
//   HOT entry points (addFrom / advanceFrom) read `buf.length` ONCE into the index bound; a caller
//     length getter is caller-owned code that may run AT MOST ONCE per call, and the call behaves per
//     the ONE value it returned (documented caveat -- see the hot rows below).
// MUTANT: revert ONE COLD site (e.g. SCM.estimateInto out) to `x.length` and its row goes RED (the
// getter fires -> counter > 0 -> the operated instance mutates via the re-entrant read).
const CNOW = 1.75e12;
const CBENIGN = () => Float64Array.of(CNOW, 7, 1, CNOW, 7, 1, CNOW, 7);   // valid for the OTHER container slot
// Each site: make an instance, mut() gives it real state, call(o, buf) puts `buf` in the container slot.
const CONTAINER_SITES = [
    { n: 'EH.addFrom(buf)', mk: () => new ExponentialHistogram(1000, 0.01), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.addFrom(b, 0) },
    { n: 'EH.advanceFrom(buf)', mk: () => new ExponentialHistogram(1000, 0.01), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.advanceFrom(b, 0) },
    { n: 'ADWIN.addFrom(buf)', mk: () => new ADWIN(0.1), mut: (o) => o.add(0.5), call: (o, b) => o.addFrom(b, 0) },
    { n: 'FD.addFrom(buf)', mk: () => new ForwardDecay(1e9), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.addFrom(b, 0) },
    { n: 'HK.addFrom(buf)', mk: () => new HeavyKeeper(4, 512, 16, { seed: 4 }), mut: (o) => o.add(7, 1), call: (o, b) => o.addFrom(b, 0) },
    { n: 'HK.topKInto(buf)', mk: () => new HeavyKeeper(4, 512, 16, { seed: 4 }), mut: (o) => o.add(7, 1), call: (o, b) => o.topKInto(b) },
    { n: 'SHLL.addFrom(buf)', mk: () => new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }), mut: (o) => o.add(CNOW, 7), call: (o, b) => o.addFrom(b, 0) },
    { n: 'SHLL.advanceFrom(buf)', mk: () => new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }), mut: (o) => o.add(CNOW, 7), call: (o, b) => o.advanceFrom(b, 0) },
    { n: 'DD.addFrom(buf)', mk: () => new DriftDetector(DRIFT_PH, { delta: 0.005, threshold: 5 }), mut: (o) => o.add(0.5), call: (o, b) => o.addFrom(b, 0) },
    { n: 'SDD.addFrom(buf)', mk: () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.addFrom(b, 0) },
    { n: 'SDD.quantileInto(qs)', mk: () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.quantileInto(b, new Float64Array(8)), arg: true },
    { n: 'SDD.quantileInto(out)', mk: () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.quantileInto(Float64Array.of(0.5, 0.9, 0.99), b) },
    { n: 'SDD.advanceFrom(buf)', mk: () => new SlidingDDSketch(1000, { alpha: 0.01, panes: 8 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.advanceFrom(b, 0) },
    { n: 'SCM.addFrom(buf)', mk: () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), mut: (o) => o.add(CNOW, 7, 1), call: (o, b) => o.addFrom(b, 0) },
    { n: 'SCM.estimateInto(keys)', mk: () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), mut: (o) => o.add(CNOW, 7, 1), call: (o, b) => o.estimateInto(b, new Float64Array(8)), arg: true },
    { n: 'SCM.estimateInto(out)', mk: () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), mut: (o) => o.add(CNOW, 7, 1), call: (o, b) => o.estimateInto(Float64Array.of(7, 1, 7), b) },
    { n: 'SCM.advanceFrom(buf)', mk: () => new SlidingCountMin(1000, { panes: 8, w: 128, d: 4, seed: 7 }), mut: (o) => o.add(CNOW, 7, 1), call: (o, b) => o.advanceFrom(b, 0) },
    { n: 'DR.addFrom(buf)', mk: () => new DecayedReservoir(32, 1e5, { seed: 7 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.addFrom(b, 0) },
    { n: 'DR.sampleInto(buf)', mk: () => new DecayedReservoir(32, 1e5, { seed: 7 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.sampleInto(b) },
    { n: 'SA.addFrom(buf)', mk: () => new SlidingAggregate(1000, { panes: 8 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.addFrom(b, 0) },
    { n: 'SA.advanceFrom(buf)', mk: () => new SlidingAggregate(1000, { panes: 8 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.advanceFrom(b, 0) },
    { n: 'SA.into(out)', mk: () => new SlidingAggregate(1000, { panes: 8 }), mut: (o) => o.add(CNOW, 5), call: (o, b) => o.into(b) },
];

for (const s of CONTAINER_SITES) {
    const isHotSite = /(addFrom|advanceFrom)/.test(s.n);
    for (const shape of ['LenLie', 'LenObj']) {
        if (isHotSite) {
            // HOT entry points (addFrom / advanceFrom) read `buf.length` ONCE into the index bound
            // (container-length threat model, SETTLED 2026-09-28). A caller-defined length getter is the
            // caller's OWN code and may run AT MOST ONCE per call; the call then behaves per the ONE value
            // the getter returned. Here a short lie (0) makes the NaN-safe bound !(i+k < 0) reject with a
            // tagged [lite-adaptive] throw -- H2-4 kept. The getter is caller code, so state is not asserted.
            test('H34 ' + s.n + ': ' + shape + ' (hot path: caller-owned subclass getter, documented)', () => {
                const victim = s.mk(); s.mut(victim);
                const o = s.mk(); s.mut(o);
                let calls = 0;
                const onRead = () => {
                    calls++;
                    try { s.mut(victim); } catch { /* keep going */ }
                    try { s.mut(o); } catch { /* keep going */ }
                    return 0;   // a short lie: the NaN-safe bound rejects, driven by this ONE returned value
                };
                let buf;
                if (shape === 'LenLie') {
                    class Tampered extends Float64Array { get length() { return onRead(); } }
                    buf = new Tampered(8);
                } else {
                    buf = new Float64Array(8);
                    Object.defineProperty(buf, 'length', { get: onRead, configurable: true });
                }
                let threw = false;
                try { s.call(o, buf, 0); } catch (e) { threw = LA.test(e.message); }
                assert.ok(calls <= 1, s.n + ' ' + shape + ': the caller length getter ran more than once (calls=' + calls + ')');
                assert.ok(threw, s.n + ' ' + shape + ': a short-lie length must reject [lite-adaptive] (behaves per the returned 0)');
            });
            continue;
        }
        test('H34 ' + s.n + ': ' + shape + ' length runs 0 caller code, byte-identical no-op', () => {
            const victim = s.mk();
            s.mut(victim);
            const vBefore = snapshot(victim);
            const o = s.mk();
            s.mut(o);
            const iBefore = snapshot(o);
            let calls = 0;
            // These are COLD render readers (out / arg sites). Both shapes read the length via TA_LEN.
            // LenLie: a SUBCLASS getter that re-enters the victim AND the operated instance, then lies (0).
            //   The intrinsic TA_LEN read reads the true [[ArrayLength]] slot, so the getter never runs.
            // LenObj: an OWN-property length accessor on a PLAIN Float64Array that returns an OBJECT with
            //   valueOf / Symbol.toPrimitive re-entering on coercion. TA_LEN never invokes it; reverting the
            //   length read to `x.length` would coerce it (calls > 0 -> RED).
            const onRead = () => {
                calls++;
                try { s.mut(victim); } catch { /* keep going */ }
                try { s.mut(o); } catch { /* keep going */ }
                if (shape === 'LenLie') return 0;
                return { valueOf() { calls++; try { s.mut(o); } catch { /* keep going */ } return 1e6; },
                    [Symbol.toPrimitive]() { calls++; try { s.mut(o); } catch { /* keep going */ } return 1e6; } };
            };
            let buf;   // a 0-slot backing forces the reject on every in / out site
            if (shape === 'LenLie') {
                class Tampered extends Float64Array { get length() { return onRead(); } }
                buf = new Tampered(0);
            } else {
                buf = new Float64Array(0);
                Object.defineProperty(buf, 'length', { get: onRead, configurable: true });
            }
            let threw = false;
            try { s.call(o, buf, 0); } catch (e) { threw = LA.test(e.message); }
            assert.equal(calls, 0, s.n + ' ' + shape + ': read a caller length getter (calls=' + calls + ')');
            assert.equal(snapshot(victim), vBefore, s.n + ' ' + shape + ': mutated the victim (re-entrant getter fired)');
            // in / out sites reject a 0-slot backing before any write -> a byte-identical no-op + tagged throw.
            // arg sites (keys / qs) read n = 0 -> an empty read-only answer (a reader MAY refresh its private
            // merge scratch, per C7 -- so assert the getter ran 0 caller code, not a raw byte snapshot).
            if (!s.arg) {
                assert.equal(snapshot(o), iBefore, s.n + ' ' + shape + ': not a byte-identical no-op');
                assert.ok(threw, s.n + ' ' + shape + ': a 0-slot container must reject [lite-adaptive]');
            }
        });
    }
}
