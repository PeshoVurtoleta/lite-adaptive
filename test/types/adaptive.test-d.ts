/**
 * @zakkster/lite-adaptive -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between Adaptive.d.ts and the runtime fails
 * `npm run test:types`. Not executed; only type-checked.
 */

import { ExponentialHistogram, VERSION } from '../../Adaptive.js';
import type { ExponentialHistogramMode, ExponentialHistogramOptions } from '../../Adaptive.js';

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
