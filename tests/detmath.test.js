/**
 * The deterministic math must also be *correct* math: identical everywhere is
 * worthless if `sin` is wrong. Checked against the platform's own `Math`,
 * which is accurate even where it is not reproducible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const D = await import(pathToFileURL(resolve('src/core/detmath.ts')).href);

let seed = 20260918;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/** Worst absolute error over `n` samples drawn from `span`. */
function maxAbsError(ours, theirs, span, n = 50000) {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * span;
    worst = Math.max(worst, Math.abs(ours(x) - theirs(x)));
  }
  return worst;
}

/** Worst relative error over `n` samples. */
function maxRelError(ours, theirs, sample, n = 50000) {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const x = sample();
    const b = theirs(x);
    if (!Number.isFinite(b) || b === 0) continue;
    worst = Math.max(worst, Math.abs(ours(x) - b) / Math.abs(b));
  }
  return worst;
}

test('sin and cos match Math to the last bits, at any angle', () => {
  assert.ok(maxAbsError(D.sin, Math.sin, 12) < 1e-15);
  assert.ok(maxAbsError(D.cos, Math.cos, 12) < 1e-15);
  // Large arguments exercise the range reduction.
  assert.ok(maxAbsError(D.sin, Math.sin, 4000) < 1e-14);
  assert.ok(maxAbsError(D.cos, Math.cos, 4000) < 1e-14);
});

test('atan and atan2 match Math', () => {
  assert.ok(maxAbsError(D.atan, Math.atan, 2000) < 1e-15);
  let worst = 0;
  for (let i = 0; i < 50000; i++) {
    const y = (rnd() - 0.5) * 200;
    const x = (rnd() - 0.5) * 200;
    worst = Math.max(worst, Math.abs(D.atan2(y, x) - Math.atan2(y, x)));
  }
  assert.ok(worst < 1e-15, `atan2 off by ${worst}`);
});

test('exp, log and pow match Math', () => {
  assert.ok(maxRelError(D.exp, Math.exp, () => (rnd() - 0.5) * 60) < 1e-14);
  assert.ok(maxRelError(D.log, Math.log, () => rnd() * 1000 + 1e-6) < 1e-14);
  assert.ok(maxRelError(D.log2, Math.log2, () => rnd() * 1000 + 1e-6) < 1e-14);
  let worst = 0;
  for (let i = 0; i < 50000; i++) {
    const base = rnd() * 4 + 1e-3;
    const e = (rnd() - 0.3) * 8;
    const b = Math.pow(base, e);
    worst = Math.max(worst, Math.abs(D.pow(base, e) - b) / Math.abs(b));
  }
  assert.ok(worst < 1e-13, `pow off by ${worst}`);
  // Integer exponents take the exact path.
  assert.equal(D.pow(2, 10), 1024);
  assert.equal(D.pow(3, -2), 1 / 9);
  assert.equal(D.pow(7, 0), 1);
});

test('hypot matches Math', () => {
  assert.equal(D.hypot(3, 4), 5);
  assert.equal(D.hypot(0, 0), 0);
  let worst = 0;
  for (let i = 0; i < 50000; i++) {
    const a = (rnd() - 0.5) * 200;
    const b = (rnd() - 0.5) * 200;
    worst = Math.max(worst, Math.abs(D.hypot(a, b) - Math.hypot(a, b)) / Math.hypot(a, b));
  }
  assert.ok(worst < 1e-15, `hypot off by ${worst}`);
});
