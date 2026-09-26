// @zakkster/lite-adaptive -- F13 option-door table (node:test).
// Every ctor and both `withAccuracy` factories route options through the SAME cold door (R6):
// `undefined` OK; null / a non-object / an Array / an ArrayBuffer view is rejected; an inherited
// key (`constructor`, `toString`) is rejected via a null-proto known set; an unknown key throws a
// tagged RangeError with a Levenshtein <= 2 did-you-mean hint. A ctor throw builds no instance, so
// the byte-identical requirement is the throw itself (no half-built state to inspect).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, SlidingDDSketch, SlidingCountMin, DecayedReservoir, DRIFT_PH,
} from '../Adaptive.js';

// Each door: [label, (opts) => construct]. 9 ctors + 2 withAccuracy = 11 doors.
const DOORS = [
    ['ExponentialHistogram', (o) => new ExponentialHistogram(1000, 0.01, o)],
    ['ADWIN', (o) => new ADWIN(0.01, o)],
    ['ForwardDecay', (o) => new ForwardDecay(100, o)],
    ['HeavyKeeper', (o) => new HeavyKeeper(4, 64, 8, o)],
    ['SlidingHyperLogLog', (o) => new SlidingHyperLogLog(1000, o)],
    ['DriftDetector', (o) => new DriftDetector(DRIFT_PH, o)],
    ['SlidingDDSketch', (o) => new SlidingDDSketch(1000, o)],
    ['SlidingCountMin', (o) => new SlidingCountMin(1000, o)],
    ['DecayedReservoir', (o) => new DecayedReservoir(8, 100, o)],
    ['HeavyKeeper.withAccuracy', (o) => HeavyKeeper.withAccuracy(8, 0.01, o)],
    ['SlidingCountMin.withAccuracy', (o) => SlidingCountMin.withAccuracy(1000, 0.01, 0.01, o)],
];

const REJECTED = [
    ['{toString:1}', { toString: 1 }],
    ['{constructor:1}', { constructor: 1 }],
    ['[]', []],
    ['new Float64Array(1)', new Float64Array(1)],
    ['null', null],
];

test('F13 every door rejects the 5 bad bags with a tagged throw', () => {
    for (const [label, make] of DOORS) {
        for (const [bagLabel, bag] of REJECTED) {
            assert.throws(() => make(bag), /\[lite-adaptive\]/, label + ' rejects ' + bagLabel);
        }
    }
});

test('F13 did-you-mean: {sede:1} suggests "seed" on the seeded members', () => {
    for (const [label, make] of [
        ['HeavyKeeper', (o) => new HeavyKeeper(4, 64, 8, o)],
        ['SlidingHyperLogLog', (o) => new SlidingHyperLogLog(1000, o)],
        ['SlidingCountMin', (o) => new SlidingCountMin(1000, o)],
        ['DecayedReservoir', (o) => new DecayedReservoir(8, 100, o)],
    ]) {
        assert.throws(() => make({ sede: 1 }), (e) => {
            assert.ok(/\[lite-adaptive\]/.test(e.message), label + ' tagged');
            assert.ok(e.message.includes('"seed"'), label + ' suggests seed: ' + e.message);
            return true;
        });
    }
});

test('F13 did-you-mean: {maxcount:1} suggests "maxCount" on EH', () => {
    assert.throws(() => new ExponentialHistogram(1000, 0.01, { maxcount: 1 }), (e) =>
        /\[lite-adaptive\]/.test(e.message) && e.message.includes('"maxCount"'));
});

test('F13 did-you-mean: {rnage:[1,2]} suggests "range" on SDD', () => {
    assert.throws(() => new SlidingDDSketch(1000, { rnage: [1, 2] }), (e) =>
        /\[lite-adaptive\]/.test(e.message) && e.message.includes('"range"'));
});

test('F13 valid options are still accepted on every door', () => {
    assert.ok(new ExponentialHistogram(1000, 0.01, { maxCount: 1000 }));
    assert.ok(new ADWIN(0.01, undefined));
    assert.ok(new ForwardDecay(100, undefined));
    assert.ok(new HeavyKeeper(4, 64, 8, { seed: 1, b: 1.5 }));
    assert.ok(new SlidingHyperLogLog(1000, { p: 10, ringCap: 8, seed: 1 }));
    assert.ok(new DriftDetector(DRIFT_PH, { delta: 0.01, threshold: 5 }));
    assert.ok(new SlidingDDSketch(1000, { alpha: 0.01, panes: 4, range: [1, 1000] }));
    assert.ok(new SlidingCountMin(1000, { epsilon: 0.01, conservative: false }));
    assert.ok(new DecayedReservoir(8, 100, { seed: 7 }));
    assert.ok(HeavyKeeper.withAccuracy(8, 0.01, { seed: 1 }));
    assert.ok(SlidingCountMin.withAccuracy(1000, 0.01, 0.01, { panes: 8 }));
});

// review 4b blocker: inherited keys and Symbol keys must not slip past the door.
test('F13: options with a non-plain prototype or Symbol keys are rejected on every door', async () => {
    const A = await import('../Adaptive.js');
    const doors = [
        (o) => new A.ExponentialHistogram(10, 0.1, o), (o) => new A.ADWIN(0.01, o), (o) => new A.ForwardDecay(10, o),
        (o) => new A.HeavyKeeper(2, 8, 2, o), (o) => A.HeavyKeeper.withAccuracy(2, 0.1, o),
        (o) => new A.SlidingHyperLogLog(10, o), (o) => new A.DriftDetector(A.DRIFT_PH, o),
        (o) => new A.SlidingDDSketch(10, o), (o) => new A.SlidingCountMin(10, o),
        (o) => A.SlidingCountMin.withAccuracy(10, 0.1, 0.1, o), (o) => new A.DecayedReservoir(2, 10, o),
    ];
    for (const door of doors) {
        assert.throws(() => door(Object.create({ seed: 12345 })), /\[lite-adaptive\].*plain object/);
        assert.throws(() => door(Object.create({ bogusKey: 1 })), /\[lite-adaptive\].*plain object/);
        assert.throws(() => door({ [Symbol('x')]: 1 }), /\[lite-adaptive\].*plain object/);
        door(Object.create(null));   // a null-prototype bag with no keys is a valid (empty) options object
        door({});
    }
});

// ---------------------------------------------------------------------------
// 1.7.0 QA adversarial (e): __proto__ literal vs an OWN "__proto__" key, and a
// Proxy whose ownKeys trap throws.
// ---------------------------------------------------------------------------
test('ADVERSARIAL (e): a null-proto object LITERAL {__proto__: null, seed: 1} is accepted ' +
    '(same shape as Object.create(null) + assign)', () => {
    const bag = { __proto__: null, seed: 1 };            // sets the prototype, NOT an own key
    assert.equal(Object.getPrototypeOf(bag), null, 'sanity: the literal really is null-proto');
    assert.deepEqual(Object.keys(bag), ['seed'], 'sanity: seed is the only own key');
    assert.ok(new HeavyKeeper(4, 64, 8, bag), 'HeavyKeeper accepts a null-proto {__proto__:null, seed:1}');
    assert.ok(new SlidingHyperLogLog(1000, bag), 'SlidingHyperLogLog accepts it too');
    assert.ok(new SlidingCountMin(1000, bag), 'SlidingCountMin accepts it too');
    assert.ok(new DecayedReservoir(8, 100, bag), 'DecayedReservoir accepts it too');
});

test('ADVERSARIAL (e): JSON.parse(\'{"__proto__": {...}}\') produces an OWN "__proto__" data ' +
    'property -> rejected as an unknown option, never a crash / never silently merged', () => {
    const bag = JSON.parse('{"__proto__": {"seed": 5}}');
    // JSON.parse defines "__proto__" as a normal OWN enumerable data property (unlike object-literal
    // syntax); the object's prototype stays Object.prototype.
    assert.equal(Object.getPrototypeOf(bag), Object.prototype, 'sanity: JSON.parse does not set proto');
    assert.ok(Object.prototype.hasOwnProperty.call(bag, '__proto__'), 'sanity: __proto__ is an own key');
    for (const make of [
        (o) => new HeavyKeeper(4, 64, 8, o),
        (o) => new SlidingHyperLogLog(1000, o),
        (o) => new SlidingCountMin(1000, o),
        (o) => new DecayedReservoir(8, 100, o),
        (o) => new ExponentialHistogram(1000, 0.01, o),
    ]) {
        assert.throws(() => make(bag), /\[lite-adaptive\]/, 'an own "__proto__" key throws, not a crash');
    }
});

test('ADVERSARIAL (e): a Proxy options object whose ownKeys trap throws -- the throw propagates ' +
    '(or is tagged) and NO instance is ever constructed', () => {
    const boom = new Error('ownKeys boom');
    const proxy = new Proxy({}, { ownKeys() { throw boom; } });
    for (const make of [
        (o) => new HeavyKeeper(4, 64, 8, o),
        (o) => new SlidingHyperLogLog(1000, o),
        (o) => new SlidingCountMin(1000, o),
        (o) => new DecayedReservoir(8, 100, o),
        (o) => new ExponentialHistogram(1000, 0.01, o),
        (o) => new SlidingDDSketch(1000, o),
        (o) => new ADWIN(0.01, o),
        (o) => new ForwardDecay(100, o),
        (o) => new DriftDetector(DRIFT_PH, o),
    ]) {
        let threw = null, instance;
        try { instance = make(proxy); } catch (e) { threw = e; }
        assert.ok(threw, 'the ownKeys throw propagates (or is tagged), no instance silently built');
        assert.equal(instance, undefined, 'no instance escapes when the options bag itself throws');
    }
});
