// @zakkster/lite-adaptive -- 1.10.0 addFrom / advanceFrom parity gate (repo-only; run:
//   node --test test/differential/AddFromParity.test.mjs).
//
// H2-4 / H2-4b (ROADMAP 10.1) tighten the 17 container gates and the buffer-read value forms: a
// Proxy / NaN-length subclass now THROWS, and an `undefined` read now throws instead of corrupting
// state. Every ACCEPTED number is accepted / rejected exactly as before -- only bad CONTAINERS and
// `undefined` reads change. This gate freezes the 1.9.0 (HEAD) VALID-input behavior of every
// addFrom / advanceFrom path (EH, ADWIN, FD, HK, SHLL, DR, DD PH + CUSUM) so batch 3's guard
// tightening is proven output-preserving on good input. 5000 addFrom + 1000 advanceFrom (EH / SHLL);
// cheap readers sampled every 50 ops, encoded as IEEE-bit hex. All LIVE.
//
// The golden is a DATA file inside the package (addfrom-1.9.0-vectors.json); this test imports only
// package files. The STREAM block below is a VERBATIM copy of the generator's block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DecayedReservoir, DriftDetector, DRIFT_PH, DRIFT_CUSUM } from '../../Adaptive.js';

const V = JSON.parse(readFileSync(
    fileURLToPath(new URL('./addfrom-1.9.0-vectors.json', import.meta.url)), 'utf8'));

const dv = new DataView(new ArrayBuffer(8));
function hx(x) { dv.setFloat64(0, x); return dv.getBigUint64(0).toString(16).padStart(16, '0'); }

// ===== STREAM (VERBATIM copy of the generator's block) =====
const NOW0 = 1.75e12, ADDS = 5000, ADVS = 1000, SAMPLE = 50;
function step(j) { return 1.5 + 0.25 * (j % 7); }
function valAt(j) { return (((j * 40503) % 9973) + 0.5); }        // > 0, fractional
function shllKey(j) { return ((j * 2654435761) >>> 0) % 5000; }
function hkKey(j) { return (j % 500) + 1; }
function push(map, k, v) { (map[k] || (map[k] = [])).push(hx(v)); }

function runEH() {
    const eh = new ExponentialHistogram(1000, 0.01); const buf = new Float64Array(2); const s = {}; let now = NOW0;
    for (let j = 0; j < ADDS; j++) { now += step(j); buf[0] = now; buf[1] = valAt(j); eh.addFrom(buf, 0);
        if (j % SAMPLE === 0) { push(s, 'count', eh.count()); push(s, 'sum', eh.sum()); } }
    for (let j = 0; j < ADVS; j++) { now += 3; eh.advanceFrom(Float64Array.of(now), 0);
        if (j % SAMPLE === 0) { push(s, 'advCount', eh.count()); push(s, 'advSum', eh.sum()); } }
    return join(s);
}
function runADWIN() {
    const ad = new ADWIN(0.1); const buf = new Float64Array(1); const s = {};
    for (let j = 0; j < ADDS; j++) { buf[0] = valAt(j) * 1e-3 + ((j >= 2500) ? 10 : 0); ad.addFrom(buf, 0);
        if (j % SAMPLE === 0) { push(s, 'width', ad.width); push(s, 'mean', ad.mean); } }
    return join(s);
}
function runFD() {
    const fd = new ForwardDecay(1e9); const buf = new Float64Array(2); const s = {}; let now = NOW0;
    for (let j = 0; j < ADDS; j++) { now += step(j); buf[0] = now; buf[1] = valAt(j) - 4986; fd.addFrom(buf, 0);
        if (j % SAMPLE === 0) { push(s, 'count', fd.count(now)); push(s, 'sum', fd.sum(now)); push(s, 'mean', fd.mean(now)); } }
    return join(s);
}
function runHK() {
    const hk = new HeavyKeeper(4, 512, 16, { seed: 4 }); const buf = new Float64Array(2); const s = {};
    for (let j = 0; j < ADDS; j++) { buf[0] = hkKey(j); buf[1] = (j & 7) + 1; hk.addFrom(buf, 0);
        if (j % SAMPLE === 0) { push(s, 'size', hk.size); push(s, 'est7', hk.estimate(7)); push(s, 'est1', hk.estimate(1)); } }
    return join(s);
}
function runSHLL() {
    const sl = new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 3 }); const buf = new Float64Array(2); const s = {}; let now = NOW0;
    for (let j = 0; j < ADDS; j++) { now += step(j); buf[0] = now; buf[1] = shllKey(j); sl.addFrom(buf, 0);
        if (j % SAMPLE === 0) { push(s, 'count', sl.count()); push(s, 'ov', sl.overflows); } }
    for (let j = 0; j < ADVS; j++) { now += 3; sl.advanceFrom(Float64Array.of(now), 0);
        if (j % SAMPLE === 0) { push(s, 'advCount', sl.count()); push(s, 'advOv', sl.overflows); } }
    return join(s);
}
function runDR() {
    const dr = new DecayedReservoir(32, 1e5, { seed: 7 }); const buf = new Float64Array(2); const out = new Float64Array(32); const s = {}; let now = NOW0;
    for (let j = 0; j < ADDS; j++) { now += step(j); buf[0] = now; buf[1] = valAt(j) - 4986; dr.addFrom(buf, 0);
        if (j % SAMPLE === 0) { const m = dr.sampleInto(out); let sum = 0; for (let k = 0; k < m; k++) sum += out[k]; push(s, 'size', dr.size); push(s, 'sampleSum', sum); } }
    return join(s);
}
function runDD(mode, opts) {
    const dd = new DriftDetector(mode, opts); const buf = new Float64Array(1); const s = {};
    for (let j = 0; j < ADDS; j++) { buf[0] = valAt(j) * 1e-3 + ((j >= 2500) ? 3 : 0); const f = dd.addFrom(buf, 0);
        if (j % SAMPLE === 0) { push(s, 'stat', dd.statistic); push(s, 'mean', dd.mean); push(s, 'cnt', dd.count); push(s, 'fired', f ? 1 : 0); } }
    return join(s);
}
function join(s) { const o = {}; for (const k of Object.keys(s)) o[k] = s[k].join(''); return o; }
// ===== END STREAM =====

function assertSeries(got, gold, label) {
    const keys = Object.keys(gold);
    assert.deepEqual(Object.keys(got).sort(), keys.slice().sort(), label + ' series set differs');
    for (const k of keys) assert.equal(got[k], gold[k], label + '.' + k + ' series drifted');
}

test('AddFromParity: ExponentialHistogram addFrom + advanceFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runEH(), V.eh, 'EH'));
test('AddFromParity: ADWIN addFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runADWIN(), V.adwin, 'ADWIN'));
test('AddFromParity: ForwardDecay addFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runFD(), V.fd, 'FD'));
test('AddFromParity: HeavyKeeper addFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runHK(), V.hk, 'HK'));
test('AddFromParity: SlidingHyperLogLog addFrom + advanceFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runSHLL(), V.shll, 'SHLL'));
test('AddFromParity: DecayedReservoir addFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runDR(), V.dr, 'DR'));
test('AddFromParity: DriftDetector PH addFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runDD(DRIFT_PH, { delta: 0.005, threshold: 5 }), V.ddPH, 'DD PH'));
test('AddFromParity: DriftDetector CUSUM addFrom is bit-identical to the 1.9.0 golden', () => assertSeries(runDD(DRIFT_CUSUM, { target: 0, delta: 0.5, threshold: 4 }), V.ddCUSUM, 'DD CUSUM'));

// TEETH: flip ONE hex digit inside a golden series and confirm the live replay does NOT match it.
test('AddFromParity CONTROL: a one-hex-digit flip in a golden series goes RED', () => {
    const gold = V.eh.sum;
    const pos = 32;
    const flip = (parseInt(gold[pos], 16) ^ 0x1).toString(16);
    const mutated = gold.slice(0, pos) + flip + gold.slice(pos + 1);
    assert.notEqual(mutated, gold, 'sanity: the flip changed the golden string');
    assert.notEqual(runEH().sum, mutated, 'a one-hex-digit flip must NOT match the live replay (gate is toothless)');
    assert.equal(runEH().sum, gold, 'sanity: the live replay matches the true golden');
});
