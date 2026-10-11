/**
 * Shrinks a generated prop into something a browser can carry. Owner: PROPS.
 *
 * Usage, with the dev server running:
 *
 *   mkdir -p public/_src
 *   cp bulwark/hammer.glb bulwark/shield.glb public/_src/
 *   node tools/prop-to-glb.mjs
 *   rm -rf public/_src
 *
 * Why this exists next to `fbx-to-creep.mjs` rather than inside it: that tool's
 * whole substance is skinning -- merging submeshes that each carry their own
 * skeleton, remapping bone indices, carrying bind inverses. A hammer has no
 * bones. Everything it would need from that file is the part that is not about
 * skin, and the part that is would all have to be stepped around.
 *
 * What a prop needs is small: weld, decimate, shrink the maps, write it out.
 *
 * The one piece of hard-won knowledge it does inherit is the weld. A mesh out
 * of Rodin arrives with nothing shared -- the hammer is 325,124 vertices for
 * 500,000 triangles -- and the simplifier collapses EDGES, which only exist
 * where two triangles share a vertex index. Welding with the normal in the key
 * leaves a hard-surface object still shredded, and the simplifier then returns
 * the mesh it was given. So the topology handed to it is welded by position and
 * UV alone, and each surviving corner is given back the normal variant that
 * belongs to its new face. See the long note in `fbx-to-creep.mjs` step 6.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PAGE = 'http://127.0.0.1:5173/play/';

/**
 * Every prop this tool knows how to build.
 *
 * `budget` is triangles after decimation. A prop is read at the same distance
 * as the hero carrying it and has a far simpler shape, so it needs a fraction
 * of his 7,000: these are blocky objects whose silhouette is a rectangle and a
 * kite. `texture` is the square the maps are resampled to.
 */
const PROPS = {
  // The hammer holds up at 700: it is a box on a stick and the shape survives.
  // The shield does not. At 875 its face tore open and its boss collapsed --
  // it is one broad curved surface covered in low relief, which is the shape
  // decimation ruins first, and the same lesson the orc's chain and Erika's
  // bow taught in `fbx-to-creep.mjs`. Geometry is nearly free here next to the
  // textures, so it gets what it needs.
  'bulwark-hammer': { in: 'hammer.glb', out: 'public/models/parts/bulwark-hammer.glb', budget: 900, texture: 512 },
  'bulwark-shield': { in: 'shield.glb', out: 'public/models/parts/bulwark-shield.glb', budget: 2600, texture: 512 },
};

const inPage = async (prop) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
  const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
  const { MeshoptSimplifier } = await import('/node_modules/meshoptimizer/meshopt_simplifier.module.js');
  await MeshoptSimplifier.ready;

  const report = { steps: [] };
  const say = (k, v) => report.steps.push(`${k}: ${v}`);

  const gltf = await new GLTFLoader().loadAsync('/_src/' + prop.in);
  gltf.scene.updateMatrixWorld(true);

  // Collapse whatever came in into one geometry in world space. Rodin ships a
  // single mesh, but nothing here depends on that staying true.
  let source = null;
  gltf.scene.traverse((o) => { if (!source && o.isMesh) source = o; });
  if (!source) throw new Error('no mesh in ' + prop.in);
  const srcGeo = source.geometry.clone().applyMatrix4(source.matrixWorld);
  const material = Array.isArray(source.material) ? source.material[0] : source.material;

  const P = srcGeo.getAttribute('position').array;
  const N = srcGeo.getAttribute('normal').array;
  const U = srcGeo.getAttribute('uv').array;
  const count = srcGeo.getAttribute('position').count;
  const index = srcGeo.index ? Array.from(srcGeo.index.array) : [...Array(count).keys()];
  say('in', `${count} verts, ${index.length / 3} tris`);

  // ── Weld, twice. ──────────────────────────────────────────────────────────
  // First with everything in the key, which is what the output keeps; then by
  // position and UV alone, which is what the simplifier is given.
  const q = (x, s) => Math.round(x * s);
  const fullKey = (i) =>
    `${q(P[i * 3], 4096)},${q(P[i * 3 + 1], 4096)},${q(P[i * 3 + 2], 4096)}`
    + `|${q(N[i * 3], 64)},${q(N[i * 3 + 1], 64)},${q(N[i * 3 + 2], 64)}`
    + `|${q(U[i * 2], 4096)},${q(U[i * 2 + 1], 4096)}`;
  const weldMap = new Int32Array(count);
  const seen = new Map();
  const keep = [];
  for (let i = 0; i < count; i++) {
    const k = fullKey(i);
    let at = seen.get(k);
    if (at === undefined) { at = keep.length; seen.set(k, at); keep.push(i); }
    weldMap[i] = at;
  }
  const welded = keep.length;
  const take = (src, stride) => {
    const out = new Float32Array(welded * stride);
    for (let i = 0; i < welded; i++) {
      for (let c = 0; c < stride; c++) out[i * stride + c] = src[keep[i] * stride + c];
    }
    return out;
  };
  const wPos = take(P, 3), wNrm = take(N, 3), wUv = take(U, 2);

  const posOf = new Int32Array(welded);
  const variants = [];
  const seenPos = new Map();
  for (let i = 0; i < welded; i++) {
    const k = `${q(wPos[i * 3], 4096)},${q(wPos[i * 3 + 1], 4096)},${q(wPos[i * 3 + 2], 4096)}`
      + `|${q(wUv[i * 2], 4096)},${q(wUv[i * 2 + 1], 4096)}`;
    let at = seenPos.get(k);
    if (at === undefined) { at = variants.length; seenPos.set(k, at); variants.push([]); }
    posOf[i] = at;
    variants[at].push(i);
  }
  const pPos = new Float32Array(variants.length * 3);
  for (let i = 0; i < welded; i++) {
    const a = posOf[i];
    pPos[a * 3] = wPos[i * 3]; pPos[a * 3 + 1] = wPos[i * 3 + 1]; pPos[a * 3 + 2] = wPos[i * 3 + 2];
  }
  say('weld', `${count} -> ${welded} -> ${variants.length} for the simplifier`);

  // ── Decimate. ─────────────────────────────────────────────────────────────
  const sub = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) sub[i] = posOf[weldMap[index[i]]];
  const target = Math.min(sub.length, prop.budget * 3);
  const [kept] = MeshoptSimplifier.simplify(sub, pPos, 3, target - (target % 3), 0.02, ['LockBorder']);

  const pick = (p, n) => {
    const list = variants[p];
    if (list.length === 1) return list[0];
    let best = list[0], bestDot = -2;
    for (const v of list) {
      const d = wNrm[v * 3] * n[0] + wNrm[v * 3 + 1] * n[1] + wNrm[v * 3 + 2] * n[2];
      if (d > bestDot) { bestDot = d; best = v; }
    }
    return best;
  };
  const finalIndex = [];
  const n = [0, 0, 0];
  for (let i = 0; i < kept.length; i += 3) {
    const a = kept[i], b = kept[i + 1], c = kept[i + 2];
    const ax = pPos[a * 3], ay = pPos[a * 3 + 1], az = pPos[a * 3 + 2];
    const ux = pPos[b * 3] - ax, uy = pPos[b * 3 + 1] - ay, uz = pPos[b * 3 + 2] - az;
    const vx = pPos[c * 3] - ax, vy = pPos[c * 3 + 1] - ay, vz = pPos[c * 3 + 2] - az;
    n[0] = uy * vz - uz * vy; n[1] = uz * vx - ux * vz; n[2] = ux * vy - uy * vx;
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= len; n[1] /= len; n[2] /= len;
    finalIndex.push(pick(a, n), pick(b, n), pick(c, n));
  }
  say('decimate', `${index.length / 3} -> ${finalIndex.length / 3} tri`);

  // Drop vertices nothing points at any more.
  const used = new Int32Array(welded).fill(-1);
  for (const v of finalIndex) used[v] = 0;
  let live = 0;
  for (let i = 0; i < welded; i++) if (used[i] === 0) used[i] = live++;
  const pack = (src, stride) => {
    const out = new Float32Array(live * stride);
    for (let i = 0; i < welded; i++) {
      if (used[i] < 0) continue;
      for (let c = 0; c < stride; c++) out[used[i] * stride + c] = src[i * stride + c];
    }
    return out;
  };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pack(wPos, 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(pack(wNrm, 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(pack(wUv, 2), 2));
  geo.setIndex(finalIndex.map((v) => used[v]));

  // ── Shrink the maps. ──────────────────────────────────────────────────────
  // 2048 on an object this size is most of the file. The colour and the normal
  // both come down; the normal is kept because a prop decimated to 700
  // triangles has no relief of its own left, and its rivets and bands live
  // entirely in that map.
  const S = prop.texture;
  const shrink = (tex, srgb) => {
    if (!tex || !tex.image) return null;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tex.image, 0, 0, S, S);
    const out = new THREE.CanvasTexture(c);
    out.flipY = false;                 // glTF convention; the source is a GLB
    out.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    out.needsUpdate = true;
    return out;
  };
  // Metalness is forced to zero rather than inherited, and that is not a
  // cosmetic preference. Rodin ships these with metalness 1.0 and a metalness
  // map; the map is dropped here, so inheriting the scalar leaves a fully
  // metallic surface with nothing to reflect -- this scene has no environment
  // map -- and both props came out almost black. The rest of the game's art is
  // non-metal and lit by its own lights, and these now match it.
  const outMat = new THREE.MeshStandardMaterial({
    name: 'prop',
    map: shrink(material.map, true),
    normalMap: shrink(material.normalMap, false),
    roughness: 0.8,
    metalness: 0,
  });
  say('textures', `${material.map?.image?.width ?? '?'} -> ${S}`
    + (material.normalMap ? ` (+ normal ${S})` : ' (no normal map)'));

  const mesh = new THREE.Mesh(geo, outMat);
  mesh.name = prop.id;
  const root = new THREE.Group();
  root.name = prop.id;
  root.add(mesh);

  const box = new THREE.Box3().setFromObject(root);
  report.box = box.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3));
  report.min = box.min.toArray().map((v) => +v.toFixed(3));

  const buffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(root, resolve, reject, { binary: true, includeCustomExtensions: false });
  });
  const bytes = new Uint8Array(buffer);
  say('glb', `${(bytes.length / 1048576).toFixed(2)} MB`);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  report.glbBase64 = btoa(binary);
  return report;
};

const only = process.argv[2];
const browser = await chromium.launch({ args: ['--use-gl=angle'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('ERR ' + String(e).slice(0, 300)));
await page.goto(PAGE, { waitUntil: 'load' });

for (const [id, prop] of Object.entries(PROPS)) {
  if (only && only !== id) continue;
  console.log(`\n${id}`);
  const report = await page.evaluate(inPage, { ...prop, id });
  for (const s of report.steps) console.log('  ' + s);
  console.log(`  box: ${report.box.join(' x ')}  min ${report.min.join(', ')}`);
  mkdirSync(dirname(prop.out), { recursive: true });
  writeFileSync(prop.out, Buffer.from(report.glbBase64, 'base64'));
  console.log(`  wrote ${prop.out}`);
}
await browser.close();
