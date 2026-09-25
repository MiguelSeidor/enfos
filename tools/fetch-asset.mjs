/**
 * Downloads a generated asset into `public/models/` and reports what arrived.
 *
 * Generated GLBs come back as signed, expiring URLs. Pulling them into the repo
 * immediately is not optional bookkeeping — the link dies, and an asset we
 * cannot re-fetch is an asset we cannot ship.
 *
 * Usage:
 *   node tools/fetch-asset.mjs --url "https://…" --name bulwark.glb
 *   node tools/fetch-asset.mjs --url "https://…" --name bulwark.glb --dir public/models
 *
 * After downloading it prints the glTF's own summary — node count, mesh count,
 * animation names, and the bounding box in metres — because those are exactly
 * the things that decide whether a model drops into the game or needs fixing:
 * a model 40 units tall or pivoted at the hips looks fine in a viewer and is
 * broken in the scene.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.name) {
  console.error('usage: node tools/fetch-asset.mjs --url <URL> --name <file.glb> [--dir public/models]');
  process.exit(1);
}

const dir = path.resolve(args.dir ?? 'public/models');
const target = path.join(dir, args.name);

await mkdir(dir, { recursive: true });

const response = await fetch(args.url);
if (!response.ok) {
  console.error(`download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const buffer = Buffer.from(await response.arrayBuffer());
await writeFile(target, buffer);

const info = await stat(target);
console.log(`saved ${target} (${(info.size / 1024 / 1024).toFixed(2)} MB)`);

if (args.name.endsWith('.glb')) {
  try {
    describeGlb(buffer);
  } catch (err) {
    console.log(`(could not parse glTF header: ${String(err)})`);
  }
}

/**
 * Reads the JSON chunk out of a binary glTF and summarises it.
 *
 * Parsing the container by hand rather than pulling in a loader: this runs in
 * plain node with no DOM, and all we need is the JSON chunk, which the GLB
 * layout puts at a fixed offset.
 */
function describeGlb(buffer) {
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB (bad magic)');

  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));

  const meshes = json.meshes?.length ?? 0;
  const nodes = json.nodes?.length ?? 0;
  const materials = json.materials?.length ?? 0;
  const images = json.images?.length ?? 0;
  const skins = json.skins?.length ?? 0;
  const animations = (json.animations ?? []).map((a, i) => a.name || `clip${i}`);

  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const accessor = json.accessors?.[prim.indices];
      if (accessor) triangles += accessor.count / 3;
    }
  }

  console.log(
    `glTF: ${nodes} nodes, ${meshes} meshes, ${Math.round(triangles)} triangles, ` +
      `${materials} materials, ${images} textures, ${skins} skins`,
  );
  console.log(
    animations.length > 0
      ? `animations: ${animations.join(', ')}`
      : 'animations: none — needs rigging before it can walk',
  );

  // Bounding box from the POSITION accessors' own min/max, which glTF requires.
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (!acc?.min || !acc?.max) continue;
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], acc.min[i]);
        hi[i] = Math.max(hi[i], acc.max[i]);
      }
    }
  }
  if (Number.isFinite(lo[0])) {
    const size = hi.map((h, i) => +(h - lo[i]).toFixed(3));
    console.log(`bounds: ${size[0]} x ${size[1]} x ${size[2]} (height on Y = ${size[1]})`);
    console.log(`origin: min Y = ${lo[1].toFixed(3)} (0 means the pivot is at the feet)`);
    const suggested = size[1] > 0 ? (1.8 / size[1]).toFixed(3) : '1';
    console.log(`suggested manifest scale for a 1.8 m hero: ${suggested}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = 'true';
    }
  }
  return out;
}
