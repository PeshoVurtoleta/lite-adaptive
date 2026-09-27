// @zakkster/lite-adaptive -- PURE-APPEND parity gate for the 1.9.0 SlidingAggregate append (repo-only;
//   run: node --test test/differential/AppendParity.test.mjs).
//
// The 1.9.0 SlidingAggregate work is a PURE APPEND: the nine class bodies frozen at the 1.8.0 commit
// (ExponentialHistogram, ADWIN, ForwardDecay, HeavyKeeper, SlidingHyperLogLog, DriftDetector,
// SlidingDDSketch, SlidingCountMin, DecayedReservoir) must stay BYTE-IDENTICAL. `git diff HEAD` on
// Adaptive.js may touch ONLY the header docblock, the optDoor docblock count, and the append after
// DecayedReservoir. This test recomputes a sha256 of each class body on the WORKING TREE and compares
// it to the golden map cut from the 1.8.0 commit (test/differential/classes-1.8.0.sha256.json).
//
// A class body is `export class NAME {` through its column-0 closing `}` (inclusive), verbatim bytes.
//
// TEETH: an in-memory one-byte-flip control mutates a single byte inside one extracted body and asserts
// its sha256 no longer matches the golden -- so a real drift inside any of the nine bodies cannot pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const CLASSES = [
    'ExponentialHistogram', 'ADWIN', 'ForwardDecay', 'HeavyKeeper',
    'SlidingHyperLogLog', 'DriftDetector', 'SlidingDDSketch',
    'SlidingCountMin', 'DecayedReservoir',
];

const SRC = readFileSync(fileURLToPath(new URL('../../Adaptive.js', import.meta.url)), 'utf8');
const GOLDEN = JSON.parse(readFileSync(
    fileURLToPath(new URL('./classes-1.8.0.sha256.json', import.meta.url)), 'utf8'));

/** Extract the verbatim body of `export class NAME {` through its column-0 closing `}` (inclusive). */
function extractBody(src, name) {
    const lines = src.split('\n');
    const startRe = new RegExp('^export class ' + name + '\\b');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (startRe.test(lines[i])) { start = i; break; }
    }
    assert.ok(start >= 0, 'class not found: ' + name);
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i] === '}') { end = i; break; }
    }
    assert.ok(end >= 0, 'class close not found: ' + name);
    return lines.slice(start, end + 1).join('\n');
}

function sha(body) {
    return createHash('sha256').update(body, 'utf8').digest('hex');
}

test('AppendParity: all nine 1.8.0 class bodies are byte-identical on the working tree', () => {
    for (const name of CLASSES) {
        const body = extractBody(SRC, name);
        const g = GOLDEN[name];
        assert.ok(g, 'no golden entry for ' + name);
        assert.equal(Buffer.byteLength(body, 'utf8'), g.bytes,
            name + ' body byte length drifted (' + Buffer.byteLength(body, 'utf8') + ' != ' + g.bytes + ')');
        assert.equal(sha(body), g.sha256, name + ' body sha256 drifted -- a PURE-APPEND rule was violated');
    }
});

// ---------------------------------------------------------------------------
// Non-class region check: the ONLY allowed differences between HEAD:Adaptive.js and the working tree
// are (1) the header docblock (before `export const VERSION`), (2) the VERSION const line itself (bumped
// by /release), (3) the optDoor docblock (the comment block immediately above `function optDoor`), and
// (4) the append after the DecayedReservoir close. Everything else -- SEG_A (the line AFTER VERSION
// through just before the optDoor docblock) and SEG_B (`function optDoor` through the DecayedReservoir
// class close) -- must be BYTE-IDENTICAL to HEAD. SEG_A EXCLUDES the VERSION line so a `/release 1.9.0`
// bump does not turn this gate RED (blocker 4); a const edit ELSEWHERE in SEG_A still trips it.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HEAD_SRC = execSync('git show HEAD:Adaptive.js', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });

/** Compute the two invariant segments [segA, segB] of an Adaptive.js source (SEG_A excludes the VERSION line). */
function segments(src) {
    const lines = src.split('\n');
    let versionIdx = -1, optDoorFnIdx = -1, decayIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (versionIdx < 0 && /^export const VERSION\b/.test(lines[i])) versionIdx = i;
        if (optDoorFnIdx < 0 && lines[i] === 'function optDoor(options, known, label) {') optDoorFnIdx = i;
        if (decayIdx < 0 && /^export class DecayedReservoir\b/.test(lines[i])) decayIdx = i;
    }
    assert.ok(versionIdx >= 0 && optDoorFnIdx >= 0 && decayIdx >= 0, 'anchors present');
    // optDoor docblock start = nearest `/**` above the function line.
    let docStart = -1;
    for (let i = optDoorFnIdx - 1; i >= 0; i--) { if (lines[i] === '/**') { docStart = i; break; } }
    assert.ok(docStart > versionIdx, 'optDoor docblock start found');
    // DecayedReservoir class close = first column-0 `}` after the class start.
    let decayClose = -1;
    for (let i = decayIdx + 1; i < lines.length; i++) { if (lines[i] === '}') { decayClose = i; break; } }
    assert.ok(decayClose > decayIdx, 'DecayedReservoir close found');
    return [
        lines.slice(versionIdx + 1, docStart).join('\n'),    // SEG_A: AFTER VERSION .. before optDoor docblock
        lines.slice(optDoorFnIdx, decayClose + 1).join('\n'), // SEG_B: function optDoor .. DecayedReservoir close
    ];
}

/** The gate: list the invariant segments of `candSrc` that drifted from `baseSrc`. Empty == clean. */
function segmentViolations(candSrc, baseSrc) {
    const [a, b] = segments(candSrc);
    const [ha, hb] = segments(baseSrc);
    const v = [];
    if (a !== ha) v.push('SEG_A');
    if (b !== hb) v.push('SEG_B');
    return v;
}

test('AppendParity: the non-class diff vs HEAD is confined to header + VERSION + optDoor docblock + the append', () => {
    const v = segmentViolations(SRC, HEAD_SRC);
    assert.deepEqual(v, [],
        'invariant segment(s) ' + v.join(', ') + ' drifted -- an edit landed outside the allowed regions');
});

test('AppendParity: a VERSION bump alone stays GREEN (SEG_A excludes the VERSION line)', () => {
    // Simulate `/release 1.9.0`: only the VERSION const line changes.
    const bumped = HEAD_SRC.replace(/^export const VERSION = '[^']*';/m, "export const VERSION = '1.9.0';");
    assert.notEqual(bumped, HEAD_SRC, 'sanity: the VERSION line changed');
    assert.deepEqual(segmentViolations(bumped, HEAD_SRC), [],
        'a VERSION bump must not trip the segment gate (blocker 4)');
});

test('AppendParity CONTROL: an edit to a const in SEG_A / SEG_B trips the SAME gate function', () => {
    // Mutate a const inside SEG_A (MODE_UNSET lives after VERSION, before the optDoor docblock) and
    // run it through the SAME segmentViolations gate -- the control must actually be able to fail.
    assert.ok(HEAD_SRC.includes('const MODE_UNSET = 0;'), 'sanity: HEAD contains MODE_UNSET');
    const mutA = HEAD_SRC.replace('const MODE_UNSET = 0;', 'const MODE_UNSET = 9;');
    assert.notEqual(mutA, HEAD_SRC, 'sanity: the MODE_UNSET edit changed the source');
    assert.deepEqual(segmentViolations(mutA, HEAD_SRC), ['SEG_A'],
        'a SEG_A const edit must be reported by the gate (toothless otherwise)');
    // Mutate a const inside SEG_B (EH_DEFAULT_MAXCOUNT lives between optDoor and DecayedReservoir).
    assert.ok(HEAD_SRC.includes('const EH_DEFAULT_MAXCOUNT = 4294967296;'), 'sanity: HEAD contains EH_DEFAULT_MAXCOUNT');
    const mutB = HEAD_SRC.replace('const EH_DEFAULT_MAXCOUNT = 4294967296;', 'const EH_DEFAULT_MAXCOUNT = 4294967297;');
    assert.notEqual(mutB, HEAD_SRC, 'sanity: the EH_DEFAULT_MAXCOUNT edit changed the source');
    assert.deepEqual(segmentViolations(mutB, HEAD_SRC), ['SEG_B'],
        'a SEG_B const edit must be reported by the gate (toothless otherwise)');
});

test('AppendParity CONTROL: a one-byte flip inside any body goes RED', () => {
    // Prove the gate has teeth: flip a single byte inside each extracted body and confirm the sha diverges.
    for (const name of CLASSES) {
        const body = extractBody(SRC, name);
        const bytes = Buffer.from(body, 'utf8');
        const mid = bytes.length >> 1;
        const flipped = Buffer.from(bytes);
        flipped[mid] = flipped[mid] ^ 0x01;   // one-byte flip
        const mutated = createHash('sha256').update(flipped).digest('hex');
        assert.notEqual(mutated, GOLDEN[name].sha256,
            name + ': a one-byte flip must not match the golden sha (gate is toothless)');
    }
});
