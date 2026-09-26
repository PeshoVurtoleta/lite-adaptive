/**
 * @zakkster/lite-adaptive -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between Adaptive.d.ts and the runtime fails
 * `npm run test:types`. Not executed; only type-checked.
 */

import {
    ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog,
    DriftDetector, DRIFT_PH, DRIFT_CUSUM, SlidingDDSketch, SlidingCountMin, DecayedReservoir, VERSION,
} from '../../Adaptive.js';
import type {
    ExponentialHistogramMode, ExponentialHistogramOptions, ADWINOptions,
    ForwardDecayMode, ForwardDecayOptions, HeavyKeeperOptions, HeavyKeeperEntry,
    SlidingHyperLogLogMode, SlidingHyperLogLogOptions,
    DriftDetectorMode, DriftDetectorOptions,
    SlidingDDSketchMode, SlidingDDSketchOptions,
    SlidingCountMinOptions, DecayedReservoirOptions,
} from '../../Adaptive.js';

// VERSION is a string.
const v: string = VERSION;
void v;

// --- ExponentialHistogram --------------------------------------------------
const eh = new ExponentialHistogram(1000, 0.01);
const eh2 = new ExponentialHistogram(65536, 0.1, {});
const eh3 = new ExponentialHistogram(1000, 0.01, { maxCount: 5000 });
void eh3;

// getters
const w: number = eh.windowSize;
const e: number = eh.epsilon;
const bc: number = eh.bucketCount;
const cap: number = eh.capacity;
const k: number = eh.k;
const lv: number = eh.levels;
const mc: number = eh.maxCount;
const mode: ExponentialHistogramMode = eh.mode;
void w; void e; void bc; void cap; void k; void lv; void mc; void mode;

// add: chainable, both entry shapes
const chained: ExponentialHistogram = eh.add(1).add(2, 3);
const counted: ExponentialHistogram = eh2.add();
void chained; void counted;

// addFrom: zero-box packed [now, value] entry, chainable
const ehBuf = new Float64Array([1, 3]);
const ehFrom: ExponentialHistogram = eh2.addFrom(ehBuf, 0).addFrom(ehBuf, 0);
void ehFrom;

// advance / advanceFrom: idle-slide, chainable, returns this
const ehAdv: ExponentialHistogram = eh2.advance(500).advanceFrom(ehBuf, 0);
void ehAdv;

// @ts-expect-error -- addFrom buf must be a Float64Array.
eh2.addFrom([1, 3], 0);

// @ts-expect-error -- addFrom index must be a number.
eh2.addFrom(ehBuf, 'x');

// @ts-expect-error -- advance now must be a number.
eh2.advance('500');

// @ts-expect-error -- advanceFrom buf must be a Float64Array.
eh2.advanceFrom([1], 0);

// queries return numbers
const c: number = eh.count();
const su: number = eh.sum();
const q: number = eh.query();
void c; void su; void q;

// clear is chainable
const cleared: ExponentialHistogram = eh.clear();
void cleared;

// options type is assignable
const opts: ExponentialHistogramOptions = {};
void opts;

// @ts-expect-error -- W must be a number.
new ExponentialHistogram('1000', 0.01);

// @ts-expect-error -- epsilon must be a number.
new ExponentialHistogram(1000, '0.01');

// @ts-expect-error -- add value must be a number.
eh.add(1, 'x');

// @ts-expect-error -- count takes no arguments.
eh.count(1);

// --- ADWIN ------------------------------------------------------------------
const ad = new ADWIN(0.1);
const ad2 = new ADWIN(0.05, {});

// getters
const adDelta: number = ad.delta;
const adWidth: number = ad.width;
const adBc: number = ad.bucketCount;
const adCap: number = ad.capacity;
const adMean: number = ad.mean;
const adVar: number = ad.variance;
void adDelta; void adWidth; void adBc; void adCap; void adMean; void adVar;

// add returns a boolean (drift detected?)
const drift: boolean = ad.add(3.14);
const drift2: boolean = ad2.add(-5);
void drift; void drift2;

// addFrom: zero-box entry, returns the boolean drift flag
const adBuf = new Float64Array([3.14]);
const driftFrom: boolean = ad.addFrom(adBuf, 0);
void driftFrom;

// @ts-expect-error -- addFrom buf must be a Float64Array.
ad.addFrom([3.14], 0);

// @ts-expect-error -- addFrom index must be a number.
ad.addFrom(adBuf, 'x');

// clear is chainable
const adCleared: ADWIN = ad.clear();
void adCleared;

// options type is assignable
const adOpts: ADWINOptions = {};
void adOpts;

// @ts-expect-error -- delta must be a number.
new ADWIN('0.1');

// @ts-expect-error -- add value must be a number.
ad.add('x');

// @ts-expect-error -- add takes exactly one argument.
ad.add(1, 2);

// --- ForwardDecay -----------------------------------------------------------
const fd = new ForwardDecay(100);
const fd2 = new ForwardDecay(50, {});

// getters
const fdHalf: number = fd.halfLife;
const fdLambda: number = fd.lambda;
const fdLandmark: number = fd.landmark;
const fdMode: ForwardDecayMode = fd.mode;
void fdHalf; void fdLambda; void fdLandmark; void fdMode;

// add: chainable, both entry shapes, signed value allowed
const fdChained: ForwardDecay = fd.add(1).add(2, 3).add(3, -5);
const fdCounted: ForwardDecay = fd2.add();
void fdChained; void fdCounted;

// addFrom: zero-box packed [now, value] entry, chainable
const fdBuf = new Float64Array([1, -5]);
const fdFrom: ForwardDecay = fd2.addFrom(fdBuf, 0).addFrom(fdBuf, 0);
void fdFrom;

// @ts-expect-error -- addFrom buf must be a Float64Array.
fd2.addFrom([1, -5], 0);

// @ts-expect-error -- addFrom index must be a number.
fd2.addFrom(fdBuf, 'x');

// queries return numbers, with an optional query time
const fdC: number = fd.count();
const fdC2: number = fd.count(100);
const fdS: number = fd.sum(100);
const fdM: number = fd.mean();
const fdR: number = fd.rate(100);
void fdC; void fdC2; void fdS; void fdM; void fdR;

// clear is chainable
const fdCleared: ForwardDecay = fd.clear();
void fdCleared;

// options type is assignable
const fdOpts: ForwardDecayOptions = {};
void fdOpts;

// @ts-expect-error -- halfLife must be a number.
new ForwardDecay('100');

// @ts-expect-error -- add value must be a number.
fd.add(1, 'x');

// @ts-expect-error -- query time must be a number.
fd.count('now');

// --- HeavyKeeper ------------------------------------------------------------
const hk = new HeavyKeeper(4, 1024, 16);
const hk2 = new HeavyKeeper(4, 512, 8, { seed: 1, b: 1.08 });
const hk3 = HeavyKeeper.withAccuracy(16, 0.001, { seed: 0 });   // seed=0 is valid

// getters
const hkD: number = hk.d;
const hkW: number = hk.w;
const hkK: number = hk.k;
const hkB: number = hk.b;
const hkSeed: number = hk.seed;
const hkBytes: number = hk.bytes;
const hkSize: number = hk.size;
void hkD; void hkW; void hkK; void hkB; void hkSeed; void hkBytes; void hkSize;

// add: chainable, weight optional
const hkChained: HeavyKeeper = hk.add(42).add(4000000000, 5);
const hkCounted: HeavyKeeper = hk2.add(7);
void hkChained; void hkCounted;

// addFrom: zero-box packed [key, weight] entry, chainable
const hkBuf = new Float64Array([4000000000, 5]);
const hkFrom: HeavyKeeper = hk2.addFrom(hkBuf, 0).addFrom(hkBuf, 0);
void hkFrom;

// reads
const hkEst: number = hk.estimate(42);
hk.forEach((key: number, est: number) => { void key; void est; });
const hkInto: number = hk.topKInto(new Float64Array(16));
const hkTop: HeavyKeeperEntry[] = hk.topK();
const hkTopKey: number = hkTop[0].key;
const hkTopCount: number = hkTop[0].count;
void hkEst; void hkInto; void hkTopKey; void hkTopCount; void hk3;

// clear is chainable
const hkCleared: HeavyKeeper = hk.clear();
void hkCleared;

// options type is assignable
const hkOpts: HeavyKeeperOptions = { seed: 3, b: 1.1 };
void hkOpts;

// @ts-expect-error -- d must be a number.
new HeavyKeeper('4', 1024, 16);

// @ts-expect-error -- add key must be a number.
hk.add('x');

// @ts-expect-error -- addFrom buf must be a Float64Array.
hk.addFrom([1, 2], 0);

// @ts-expect-error -- forEach needs a function.
hk.forEach(42);

// @ts-expect-error -- topKInto needs a Float64Array.
hk.topKInto([]);

// @ts-expect-error -- withAccuracy targetError must be a number.
HeavyKeeper.withAccuracy(16, 'tight');

// --- SlidingHyperLogLog -----------------------------------------------------
const sl = new SlidingHyperLogLog(1000);
const sl2 = new SlidingHyperLogLog(65536, { p: 12, ringCap: 16, seed: 0 });   // seed=0 is valid

// getters
const slW: number = sl.W;
const slP: number = sl.p;
const slM: number = sl.m;
const slRing: number = sl.ringCap;
const slSeed: number = sl.seed;
const slSE: number = sl.standardError;
const slLast: number = sl.lastNow;
const slMode: SlidingHyperLogLogMode = sl.mode;
const slOver: number = sl.overflows;
const slDeg: boolean = sl.degraded;
const slBytes: number = sl.bytes;
void slW; void slP; void slM; void slRing; void slSeed; void slSE; void slLast; void slMode;
void slOver; void slDeg; void slBytes;

// add: chainable, explicit + count mode (count = add(undefined, key)), large key ok
const slChained: SlidingHyperLogLog = sl.add(1, 42).add(2, 4000000000);
const slCounted: SlidingHyperLogLog = sl2.add(undefined, 7);
void slChained; void slCounted;

// addFrom: zero-box packed [now, key] entry, chainable
const slBuf = new Float64Array([1, 42]);
const slFrom: SlidingHyperLogLog = sl2.addFrom(slBuf, 0).addFrom(slBuf, 0);
void slFrom;

// advance / advanceFrom: idle-slide, chainable, returns this
const slAdv: SlidingHyperLogLog = sl2.advance(500).advanceFrom(slBuf, 0);
void slAdv;

// queries return numbers, with an optional sub-window
const slC: number = sl.count();
const slC2: number = sl.count(500);
const slQ: number = sl.query();
void slC; void slC2; void slQ;

// clear is chainable
const slCleared: SlidingHyperLogLog = sl.clear();
void slCleared;

// options type is assignable
const slOpts: SlidingHyperLogLogOptions = { p: 10, ringCap: 8, seed: 3 };
void slOpts;

// @ts-expect-error -- W must be a number.
new SlidingHyperLogLog('1000');

// @ts-expect-error -- p option must be a number.
new SlidingHyperLogLog(1000, { p: '10' });

// @ts-expect-error -- ringCap option must be a number.
new SlidingHyperLogLog(1000, { ringCap: '8' });

// @ts-expect-error -- unknown option key.
new SlidingHyperLogLog(1000, { precision: 10 });

// @ts-expect-error -- add key must be a number.
sl.add(1, 'x');

// @ts-expect-error -- addFrom buf must be a Float64Array.
sl.addFrom([1, 42], 0);

// @ts-expect-error -- addFrom index must be a number.
sl.addFrom(slBuf, 'x');

// @ts-expect-error -- advance now must be a number.
sl.advance('500');

// @ts-expect-error -- advanceFrom buf must be a Float64Array.
sl.advanceFrom([1], 0);

// @ts-expect-error -- count sub-window must be a number.
sl.count('500');

// @ts-expect-error -- query takes no arguments.
sl.query(1);

// --- DriftDetector -----------------------------------------------------------
const dd = new DriftDetector(DRIFT_PH);
const dd2 = new DriftDetector(DRIFT_CUSUM, { delta: 0, threshold: 5, target: 0 });   // delta=0 / target=0 valid

// the mode consts are the documented literal types
const phMode: 0 = DRIFT_PH;
const cusumMode: 1 = DRIFT_CUSUM;
void phMode; void cusumMode;

// getters
const ddMode: DriftDetectorMode = dd.mode;
const ddDelta: number = dd.delta;
const ddThreshold: number = dd.threshold;
const ddTarget: number | undefined = dd.target;   // the fixed CUSUM mu0, or undefined for PH
const ddCount: number = dd.count;
const ddMean: number = dd.mean;
const ddStat: number = dd.statistic;
void ddMode; void ddDelta; void ddThreshold; void ddTarget; void ddCount; void ddMean; void ddStat;

// add returns a boolean (drift detected?)
const ddDrift: boolean = dd.add(3.14);
const ddDrift2: boolean = dd2.add(-5);
void ddDrift; void ddDrift2;

// addFrom: zero-box entry, returns the boolean drift flag
const ddBuf = new Float64Array([3.14]);
const ddDriftFrom: boolean = dd.addFrom(ddBuf, 0);
void ddDriftFrom;

// clear is chainable
const ddCleared: DriftDetector = dd.clear();
void ddCleared;

// options type is assignable (target is part of the options surface)
const ddOpts: DriftDetectorOptions = { delta: 0.01, threshold: 20, target: 3.5 };
void ddOpts;

// @ts-expect-error -- target option must be a number.
new DriftDetector(DRIFT_CUSUM, { target: '0' });

// @ts-expect-error -- mode must be DRIFT_PH | DRIFT_CUSUM (a numeric literal), not an arbitrary number.
new DriftDetector(2);

// @ts-expect-error -- mode must be a DriftDetectorMode, not a string.
new DriftDetector('ph');

// @ts-expect-error -- delta option must be a number.
new DriftDetector(DRIFT_PH, { delta: '0.005' });

// @ts-expect-error -- threshold option must be a number.
new DriftDetector(DRIFT_PH, { threshold: '50' });

// @ts-expect-error -- unknown option key.
new DriftDetector(DRIFT_PH, { lambda: 50 });

// @ts-expect-error -- add value must be a number.
dd.add('x');

// @ts-expect-error -- add takes exactly one argument.
dd.add(1, 2);

// @ts-expect-error -- addFrom buf must be a Float64Array.
dd.addFrom([3.14], 0);

// @ts-expect-error -- addFrom index must be a number.
dd.addFrom(ddBuf, 'x');

// @ts-expect-error -- add returns a boolean, not assignable to DriftDetector (no chaining).
const ddChain: DriftDetector = dd.add(1);
void ddChain;

// --- SlidingDDSketch ---------------------------------------------------------
const sd = new SlidingDDSketch(1000);
const sd2 = new SlidingDDSketch(4096, { alpha: 0.005, strict: true, panes: 64 });
const sd3 = new SlidingDDSketch(1000, { alpha: 0.01, range: [1, 1000] });
const sd4 = new SlidingDDSketch(1000, { range: [1, 1000] as const });
void sd4;

// getters
const sdAlpha: number = sd.alpha;
const sdStrict: boolean = sd.strict;
const sdPanes: number = sd.panes;
const sdW: number = sd.W;
const sdLast: number = sd.lastNow;
const sdMode: SlidingDDSketchMode = sd.mode;
const sdMinIx: number = sd.minIndexable;
const sdMaxIx: number = sd.maxIndexable;
const sdRMin: number = sd3.rangeMin;
const sdRMax: number = sd3.rangeMax;
const sdColl: boolean = sd.collapsed;
const sdBytes: number = sd.bytes;
void sdAlpha; void sdStrict; void sdPanes; void sdW; void sdLast; void sdMode;
void sdMinIx; void sdMaxIx; void sdRMin; void sdRMax; void sdColl; void sdBytes;

// add: chainable, explicit + count mode (count = add(undefined, value))
const sdChained: SlidingDDSketch = sd.add(1, 42).add(2, 3.5);
const sdCounted: SlidingDDSketch = sd2.add(undefined, 7);
void sdChained; void sdCounted;

// addFrom: zero-box packed [now, value] entry, chainable
const sdBuf = new Float64Array([1, 42]);
const sdFrom: SlidingDDSketch = sd2.addFrom(sdBuf, 0).addFrom(sdBuf, 0);
void sdFrom;

// advance / advanceFrom: idle-slide, chainable, returns this
const sdAdv: SlidingDDSketch = sd2.advance(500).advanceFrom(sdBuf, 0);
void sdAdv;

// queries return numbers, with an optional sub-window; quantileInto returns a count
const sdQ: number = sd.quantile(0.5);
const sdQw: number = sd.quantile(0.99, 500);
const sdCount: number = sd.count();
const sdCountW: number = sd.count(500);
const sdInto: number = sd.quantileInto(new Float64Array([0.5, 0.9]), new Float64Array(2));
void sdQ; void sdQw; void sdCount; void sdCountW; void sdInto;

// clear is chainable
const sdCleared: SlidingDDSketch = sd.clear();
void sdCleared;

// options type is assignable
const sdOpts: SlidingDDSketchOptions = { alpha: 0.01, strict: false, panes: 32 };
void sdOpts;

// @ts-expect-error -- W must be a number.
new SlidingDDSketch('1000');

// @ts-expect-error -- alpha option must be a number.
new SlidingDDSketch(1000, { alpha: '0.01' });

// @ts-expect-error -- strict option must be a boolean.
new SlidingDDSketch(1000, { strict: 1 });

// @ts-expect-error -- panes option must be a number.
new SlidingDDSketch(1000, { panes: '32' });

// @ts-expect-error -- unknown option key.
new SlidingDDSketch(1000, { bins: 2048 });

// @ts-expect-error -- add value must be a number.
sd.add(1, 'x');

// @ts-expect-error -- addFrom buf must be a Float64Array.
sd.addFrom([1, 42], 0);

// @ts-expect-error -- addFrom index must be a number.
sd.addFrom(sdBuf, 'x');

// @ts-expect-error -- advance now must be a number.
sd.advance('500');

// @ts-expect-error -- advanceFrom buf must be a Float64Array.
sd.advanceFrom([1], 0);

// @ts-expect-error -- quantile q must be a number.
sd.quantile('0.5');

// @ts-expect-error -- quantileInto qs must be a Float64Array.
sd.quantileInto([0.5], new Float64Array(1));

// @ts-expect-error -- count sub-window must be a number.
sd.count('500');

// @ts-expect-error -- a readonly getter is not assignable.
sd.alpha = 0.02;

// --- SlidingCountMin ---------------------------------------------------------
const cm = new SlidingCountMin(1000);
const cm2 = new SlidingCountMin(60000, { epsilon: 0.005, delta: 0.01, panes: 64, seed: 0, conservative: false });
void cm2;

// withAccuracy: the accuracy-sizing convenience ctor (parity with lite-sketch CMS), returns an instance
const cmWA: SlidingCountMin = SlidingCountMin.withAccuracy(60000, 0.01, 0.01, { panes: 32 });
void cmWA;

// @ts-expect-error -- withAccuracy epsilon must be a number.
SlidingCountMin.withAccuracy(1000, '0.01', 0.01);

// add / addFrom / advance / advanceFrom are chainable, return this
const cmChained: SlidingCountMin = cm.add(1, 42).add(2, 42, 3);
const cmCounted: SlidingCountMin = cm2.add(undefined, 7);
void cmChained; void cmCounted;

const cmBuf = new Float64Array([1, 42, 3]);
const cmFrom: SlidingCountMin = cm2.addFrom(cmBuf, 0).addFrom(cmBuf, 0);
const cmAdv: SlidingCountMin = cm2.advance(500).advanceFrom(cmBuf, 0);
void cmFrom; void cmAdv;

// estimate returns a number (double), with an optional sub-window
const cmEst: number = cm.estimate(42);
const cmEstW: number = cm.estimate(42, 500);
void cmEst; void cmEstW;

const cmCleared: SlidingCountMin = cm.clear();
void cmCleared;

// getters
const cmMode: 'unset' | 'explicit' | 'count' = cm.mode;
const cmNums: number = cm.d + cm.w + cm.panes + cm.W + cm.seed + cm.saturated + cm.epsilon + cm.delta + cm.lastNow + cm.bytes;
const cmCons: boolean = cm.conservative;
void cmMode; void cmNums; void cmCons;

const cmOpts: SlidingCountMinOptions = { epsilon: 0.01, delta: 0.01, w: 2048, d: 5, panes: 32, seed: 3, conservative: true };
void cmOpts;

// @ts-expect-error -- W must be a number.
new SlidingCountMin('1000');

// @ts-expect-error -- epsilon option must be a number.
new SlidingCountMin(1000, { epsilon: '0.01' });

// @ts-expect-error -- panes option must be a number.
new SlidingCountMin(1000, { panes: '32' });

// @ts-expect-error -- conservative option must be a boolean.
new SlidingCountMin(1000, { conservative: 1 });

// @ts-expect-error -- unknown option key.
new SlidingCountMin(1000, { width: 2048 });

// @ts-expect-error -- add key must be a number.
cm.add(1, 'x');

// @ts-expect-error -- addFrom buf must be a Float64Array.
cm.addFrom([1, 42, 3], 0);

// @ts-expect-error -- advance now must be a number.
cm.advance('500');

// @ts-expect-error -- advanceFrom buf must be a Float64Array.
cm.advanceFrom([1], 0);

// @ts-expect-error -- estimate key must be a number.
cm.estimate('42');

// @ts-expect-error -- a readonly getter is not assignable.
cm.saturated = 0;

// --- DecayedReservoir --------------------------------------------------------
const dr = new DecayedReservoir(32, 1000);
const dr2 = new DecayedReservoir(16, 60000, { seed: 0 });

// add / addFrom are chainable, return this; value is optional (defaults to 1); count mode via undefined now
const drChained: DecayedReservoir = dr.add(1, 3.5).add(2, -1.5);
const drDefaulted: DecayedReservoir = dr2.add(1);
const drCounted: DecayedReservoir = new DecayedReservoir(4, 100).add(undefined, 9);
void drChained; void drDefaulted; void drCounted;

const drBuf = new Float64Array([1, 3.5]);
const drFrom: DecayedReservoir = dr2.addFrom(drBuf, 0).addFrom(drBuf, 0);
void drFrom;

// sampleInto returns the count written; forEach takes a (value) => void
const drOut = new Float64Array(32);
const drN: number = dr.sampleInto(drOut);
dr.forEach((v: number): void => { void v; });
void drN;

const drCleared: DecayedReservoir = dr.clear();
void drCleared;

// getters
const drMode: 'unset' | 'explicit' | 'count' = dr.mode;
const drNums: number = dr.k + dr.halfLife + dr.lambda + dr.seed + dr.size + dr.bytes;
void drMode; void drNums;

const drOpts: DecayedReservoirOptions = { seed: 7 };
void drOpts;

// @ts-expect-error -- k must be a number.
new DecayedReservoir('32', 1000);

// @ts-expect-error -- halfLife must be a number.
new DecayedReservoir(32, '1000');

// @ts-expect-error -- seed option must be a number.
new DecayedReservoir(32, 1000, { seed: '0' });

// @ts-expect-error -- unknown option key.
new DecayedReservoir(32, 1000, { halfLife: 500 });

// @ts-expect-error -- add value must be a number.
dr.add(1, 'x');

// @ts-expect-error -- addFrom buf must be a Float64Array.
dr.addFrom([1, 3.5], 0);

// @ts-expect-error -- sampleInto buf must be a Float64Array.
dr.sampleInto([0, 0]);

// @ts-expect-error -- forEach fn must be a function.
dr.forEach(42);

// @ts-expect-error -- DecayedReservoir has no advance() (it is a sample, not a hard window).
dr.advance(500);

// @ts-expect-error -- a readonly getter is not assignable.
dr.size = 0;
