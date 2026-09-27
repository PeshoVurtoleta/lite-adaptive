// @zakkster/lite-adaptive -- QA boundary matrix for the 1.8.0 DriftDetector `latch` option and the
// latch / latched / lastDriftIndex / lastDirection getters (node:test). 0 / 1 / N-1 / N / N+1 on the
// trip + re-arm levels, empty, null, undefined, NaN, -0, duplicate clear, clear-while-latched,
// re-entrant write (a Proxy buffer whose get trap calls add on the same instance), add / addFrom
// interleaving, and adversarial thresholds (Number.MIN_VALUE, huge) and +-DD_X_MAX streams.
// Test-only: Adaptive.js is not touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriftDetector, DRIFT_PH, DRIFT_CUSUM } from '../Adaptive.js';

const XMAX = 1e150;
const MODES = [['PH', DRIFT_PH, {}], ['CUSUM', DRIFT_CUSUM, { target: 0 }]];
const mk = (mode, extra, opts) => new DriftDetector(mode, { ...extra, ...opts });

function run(dd, seq) {
    const fires = [];
    for (let i = 0; i < seq.length; i++) if (dd.add(seq[i])) fires.push(i);
    return fires;
}
const block = (v, n) => new Array(n).fill(v);

test('latch door: true / false / undefined accepted; null / 0 / 1 / -0 / NaN / "true" / {} rejected (TypeError, no coercion)', () => {
    for (const [, m, ex] of MODES) {
        assert.equal(mk(m, ex, { latch: true }).latch, true);
        assert.equal(mk(m, ex, { latch: false }).latch, false);
        assert.equal(mk(m, ex, { latch: undefined }).latch, false);
        assert.equal(mk(m, ex, {}).latch, false);
        for (const bad of [null, 0, 1, -0, NaN, 'true', {}, [], 1n]) {
            assert.throws(() => mk(m, ex, { latch: bad }), TypeError, String(bad));
        }
    }
});

test('getters before ANY fire are NaN (null is not zero), latched false -- for latch true AND false, and after 0 adds', () => {
    for (const [, m, ex] of MODES) for (const latch of [true, false]) {
        const d = mk(m, ex, { latch });
        assert.ok(Number.isNaN(d.lastDriftIndex)); assert.ok(Number.isNaN(d.lastDirection));
        assert.equal(d.latched, false);
        run(d, block(0, 1000));
        assert.ok(Number.isNaN(d.lastDriftIndex)); assert.ok(Number.isNaN(d.lastDirection));
        assert.equal(d.latched, false);
    }
});

test('CUSUM trip level N-1 / N / N+1: statistic == threshold does NOT fire; strictly above does (latch on and off)', () => {
    for (const latch of [true, false]) {
        const d = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0, threshold: 8, latch });
        assert.equal(d.add(4), false);           // 4
        assert.equal(d.add(4), false);           // 8 == threshold (N): no fire
        assert.equal(d.add(1e-9), true);         // N+1: fires
        assert.equal(d.lastDriftIndex, 2);
        assert.equal(d.lastDirection, 1);
        assert.equal(d.latched, latch);
    }
});

test('re-arm level N-1 / N / N+1: latched gap == threshold/2 EXACTLY stays latched; one ulp below re-arms', () => {
    const d = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0, threshold: 8, latch: true });
    assert.equal(d.add(9), true);                // fire, clamp gP = 8
    assert.equal(d.latched, true);
    assert.equal(d.add(-3), false);              // gP 5 (> half): latched
    assert.equal(d.latched, true);
    assert.equal(d.add(-1), false);              // gP 4 == half (N): strict <, still latched
    assert.equal(d.latched, true);
    assert.equal(d.add(-1e-9), false);           // gP < half (N+1): re-arm
    assert.equal(d.latched, false);
    assert.equal(d.lastDriftIndex, 0, 'a re-arm does not touch the fire log');
    assert.equal(d.add(20), true, 'armed again: a new same-direction step fires');
    assert.equal(d.lastDriftIndex, 4);
});

test('lastDriftIndex is a plain integer that increases STRICTLY across fires and equals the firing item index', () => {
    for (const [name, m, ex] of MODES) {
        const d = mk(m, ex, { latch: true, threshold: 20 });
        const seq = [];
        for (let r = 0; r < 12; r++) seq.push(...block(r & 1 ? 10 : -10, 400));
        let prev = -1, fires = 0;
        for (let i = 0; i < seq.length; i++) {
            if (d.add(seq[i])) {
                fires++;
                const li = d.lastDriftIndex;
                assert.ok(Number.isInteger(li), name + ' integer');
                assert.equal(li, i, name + ' index == firing item');
                assert.ok(li > prev, name + ' strictly increasing');
                prev = li;
                assert.equal(d.lastDirection, seq[i] > 0 ? 1 : -1, name + ' direction at ' + i);
            }
        }
        assert.ok(fires >= 11 && fires <= 12, name + ' one fire per regime (' + fires + ')');
    }
});

test('add and addFrom INTERLEAVED on one latched instance: lastDriftIndex counts both, bit-identical to an add-only twin', () => {
    for (const [name, m, ex] of MODES) {
        const a = mk(m, ex, { latch: true, threshold: 15 });
        const b = mk(m, ex, { latch: true, threshold: 15 });
        const buf = new Float64Array(1);
        const seq = [...block(0.25, 300), ...block(7.5, 300), ...block(-3.25, 300), ...block(0.5, 300)];
        for (let i = 0; i < seq.length; i++) {
            let ra;
            if (i % 3 === 0) { buf[0] = seq[i]; ra = a.addFrom(buf, 0); } else ra = a.add(seq[i]);
            const rb = b.add(seq[i]);
            assert.equal(ra, rb, name + ' fire parity at ' + i);
        }
        assert.ok(Object.is(a.lastDriftIndex, b.lastDriftIndex) && Object.is(a.lastDirection, b.lastDirection), name);
        assert.ok(Object.is(a.statistic, b.statistic) && a.latched === b.latched, name + ' state');
        assert.ok(a.lastDriftIndex >= 300, name + ' index spans both entry points');
    }
});

test('a REJECTED add / addFrom (NaN, +-Infinity, |x| > 1e150, null, undefined) does not advance the item index', () => {
    const d = new DriftDetector(DRIFT_CUSUM, { target: 0, delta: 0, threshold: 8, latch: true });
    d.add(1);
    for (const bad of [NaN, Infinity, -Infinity, XMAX * 1.0000001, null, undefined, '5']) assert.throws(() => d.add(bad));
    const buf = new Float64Array([NaN]);
    assert.throws(() => d.addFrom(buf, 0));
    assert.throws(() => d.addFrom(null, 0));
    assert.throws(() => d.addFrom(buf, 1));
    assert.equal(d.add(100), true);
    assert.equal(d.lastDriftIndex, 1, 'only accepted adds count');
});

test('-0 input is bit-identical to 0 (statistic, fires, getters)', () => {
    for (const [, m, ex] of MODES) {
        const a = mk(m, ex, { latch: true, threshold: 5 }), b = mk(m, ex, { latch: true, threshold: 5 });
        const s = [...block(3, 50), ...block(0, 50)];
        for (const x of s) { a.add(x); b.add(x === 0 ? -0 : x); }
        assert.ok(Object.is(a.statistic, b.statistic));
        assert.ok(Object.is(a.lastDriftIndex, b.lastDriftIndex));
    }
});

test('clear() while LATCHED then an immediate OPPOSITE step: getters NaN, unlatched, next fire is -1 at index 0-based from clear', () => {
    for (const [name, m, ex] of MODES) {
        const d = mk(m, ex, { latch: true, threshold: 10 });
        run(d, [...block(0, 50), ...block(50, 50)]);
        assert.equal(d.latched, true, name);
        d.clear(); d.clear();                    // duplicate clear is a safe no-op
        assert.equal(d.latched, false);
        assert.ok(Number.isNaN(d.lastDriftIndex) && Number.isNaN(d.lastDirection));
        // PH needs a reference to deviate from; CUSUM fires on the first item.
        const seq = m === DRIFT_PH ? [...block(0, 20), ...block(-50, 20)] : block(-50, 20);
        const fires = run(d, seq);
        assert.equal(fires.length, 1, name + ' one fire');
        assert.equal(d.lastDirection, -1, name);
        assert.equal(d.lastDriftIndex, fires[0], name + ' index restarts at 0 after clear');
        assert.ok(fires[0] < (m === DRIFT_PH ? 25 : 1), name + ' fires promptly: ' + fires[0]);
    }
});

test('ADVERSARIAL: a +-1e150 (DD_X_MAX) alternating-regime stream: one fire per regime, correct direction, finite statistic', () => {
    for (const [name, m, ex] of MODES) {
        const d = mk(m, ex, { latch: true, threshold: 1e3 });
        const seq = [];
        for (let r = 0; r < 6; r++) seq.push(...block(r & 1 ? -XMAX : XMAX, 200));
        const fires = [];
        const dirs = [];
        for (let i = 0; i < seq.length; i++) if (d.add(seq[i])) { fires.push(i); dirs.push(d.lastDirection); }
        assert.ok(Number.isFinite(d.statistic), name + ' finite statistic');
        assert.ok(fires.length >= 5 && fires.length <= 6, name + ' fires ' + fires.length);
        for (let k = 0; k < fires.length; k++) assert.equal(dirs[k], seq[fires[k]] > 0 ? 1 : -1, name + ' dir ' + k);
        assert.doesNotThrow(() => { d.add(XMAX); d.add(-XMAX); }, name + ' exactly +-DD_X_MAX is accepted');
    }
});

test('ADVERSARIAL: a HUGE threshold (1e300) never fires on a +-1e150 stream; getters stay NaN', () => {
    for (const [, m, ex] of MODES) {
        const d = mk(m, ex, { latch: true, threshold: 1e300 });
        const fires = run(d, [...block(XMAX, 3000), ...block(-XMAX, 3000)]);
        assert.equal(fires.length, 0);
        assert.ok(Number.isNaN(d.lastDriftIndex));
        assert.equal(d.latched, false);
    }
});

test('ADVERSARIAL: a RE-ENTRANT write -- addFrom through a Proxy buffer whose get trap calls add() on the SAME instance', () => {
    for (const [name, m, ex] of MODES) {
        const a = mk(m, ex, { latch: true, threshold: 10 });
        const b = mk(m, ex, { latch: true, threshold: 10 });
        const raw = new Float64Array(1);
        const buf = new Proxy(raw, { get(t, p) {
            if (p === '0') a.add(-2);                         // re-entrant write BEFORE the value is returned
            const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v; } });
        assert.ok(buf instanceof Float64Array);
        const seq = [...block(1, 40), ...block(40, 40)];
        let mism = 0, anyFire = 0;
        for (const x of seq) {
            raw[0] = x;
            const ra = a.addFrom(buf, 0);                     // = the OUTER item's fire (inner add's fire is its own)
            b.add(-2);
            const rb = b.add(x);
            if (ra !== rb || !Object.is(a.lastDriftIndex, b.lastDriftIndex) || !Object.is(a.lastDirection, b.lastDirection) ||
                a.latched !== b.latched) mism++;
            if (rb) anyFire++;
        }
        assert.equal(mism, 0, name + ' state == the explicit (add(-2), add(x)) sequence after every item');
        assert.ok(!Number.isNaN(a.lastDriftIndex), name + ' the stream did fire');
        assert.ok(Object.is(a.lastDriftIndex, b.lastDriftIndex) && Object.is(a.statistic, b.statistic), name);
    }
});

test('the first latched fire lands on the SAME item as the latch:false twin (PH + CUSUM, up and down steps)', () => {
    for (const [name, m, ex] of MODES) for (const step of [12, -12]) {
        const seq = [...block(0, 500), ...block(step, 200)];
        const on = run(mk(m, ex, { latch: true, threshold: 30 }), seq);
        const off = run(mk(m, ex, { latch: false, threshold: 30 }), seq);
        assert.equal(on[0], off[0], name + ' step ' + step);
        assert.equal(on.length, 1, name + ' latched fires once');
        if (m === DRIFT_CUSUM) assert.ok(off.length > 1, name + ' unlatched CUSUM re-fires on a sustained step');
    }
});

test('ADVERSARIAL: threshold = 2 * Number.MIN_VALUE -- latch still re-arms and catches a later same-direction regime', () => {
    const seq = [...block(0, 100), ...block(5, 50), ...block(0, 200), ...block(5, 50)];
    for (const [name, m, ex] of MODES) {
        const fires = run(mk(m, ex, { latch: true, threshold: 2 * Number.MIN_VALUE }), seq);
        assert.ok(fires.includes(100) && fires.includes(350), name + ' ' + fires.join(','));
    }
});

// FINDING QA-1.8.0-DD1 (fixed: fail closed at the door): with threshold = Number.MIN_VALUE,
// `threshold * 0.5` rounds to 0, so a floored CUSUM gap could never fall below the re-arm level and a
// latched detector would silently miss every later regime. The ctor now REJECTS a latch whose half
// underflows; the unlatched detector (no re-arm level needed) still accepts it.
test('latch with threshold = Number.MIN_VALUE fails closed at the door (QA-1.8.0-DD1); unlatched still accepts it', () => {
    for (const m of [DRIFT_PH, DRIFT_CUSUM]) {
        const ex = m === DRIFT_CUSUM ? { target: 0 } : {};
        assert.throws(() => new DriftDetector(m, { ...ex, latch: true, threshold: Number.MIN_VALUE }),
            (e) => e instanceof RangeError && /^\[lite-adaptive\].*threshold \/ 2 > 0/.test(e.message));
        assert.doesNotThrow(() => new DriftDetector(m, { ...ex, latch: false, threshold: Number.MIN_VALUE }));
        assert.doesNotThrow(() => new DriftDetector(m, { ...ex, latch: true, threshold: 2 * Number.MIN_VALUE }));
    }
});
