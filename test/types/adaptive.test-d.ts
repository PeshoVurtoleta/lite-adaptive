/**
 * @zakkster/lite-adaptive -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between Adaptive.d.ts and the runtime fails
 * `npm run test:types`. Not executed; only type-checked.
 */

import { ExponentialHistogram, ADWIN, ForwardDecay, VERSION } from '../../Adaptive.js';
import type {
    ExponentialHistogramMode, ExponentialHistogramOptions, ADWINOptions,
    ForwardDecayMode, ForwardDecayOptions,
} from '../../Adaptive.js';

// VERSION is a string.
const v: string = VERSION;
void v;

// --- ExponentialHistogram --------------------------------------------------
const eh = new ExponentialHistogram(1000, 0.01);
const eh2 = new ExponentialHistogram(65536, 0.1, {});

// getters
const w: number = eh.windowSize;
const e: number = eh.epsilon;
const bc: number = eh.bucketCount;
const cap: number = eh.capacity;
const k: number = eh.k;
const lv: number = eh.levels;
const mode: ExponentialHistogramMode = eh.mode;
void w; void e; void bc; void cap; void k; void lv; void mode;

// add: chainable, both entry shapes
const chained: ExponentialHistogram = eh.add(1).add(2, 3);
const counted: ExponentialHistogram = eh2.add();
void chained; void counted;

// addFrom: zero-box packed [now, value] entry, chainable
const ehBuf = new Float64Array([1, 3]);
const ehFrom: ExponentialHistogram = eh2.addFrom(ehBuf, 0).addFrom(ehBuf, 0);
void ehFrom;

// @ts-expect-error -- addFrom buf must be a Float64Array.
eh2.addFrom([1, 3], 0);

// @ts-expect-error -- addFrom index must be a number.
eh2.addFrom(ehBuf, 'x');

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
