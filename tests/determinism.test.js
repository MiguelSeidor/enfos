/**
 * Guards the one rule that lockstep play cannot survive without: simulation
 * code must not call the `Math` functions whose results are implementation
 * defined. See ARCHITECTURE.md § Determinism rules.
 *
 * Run with `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Directories whose code runs inside the simulation. */
const SIM_DIRS = ['src/gameplay', 'src/economy', 'src/core'];
/** World files the simulation reads: heights decide walkability and sight. */
const SIM_FILES = ['src/world/field.ts', 'src/world/layout.ts', 'src/world/scatter.ts', 'src/world/validate.ts'];
/** The deterministic implementations themselves, which naturally mention them. */
const EXEMPT = ['src/core/detmath.ts'];

const BANNED = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt|sinh|cosh|tanh)\s*\(/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name).replaceAll('\\', '/');
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('simulation code uses only deterministic math', () => {
  const files = [...SIM_DIRS.flatMap((d) => walk(d)), ...SIM_FILES].filter((f) => !EXEMPT.includes(f));
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(BANNED)) {
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${file}:${line} ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Use core/detmath.ts instead — these differ between JS engines:\n${offenders.join('\n')}`,
  );
});
