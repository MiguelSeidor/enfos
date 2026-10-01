/**
 * Rebuilds a creep GLB from an artist's FBX package. Owner: CHARACTERS.
 *
 * Usage, with the dev server running:
 *
 *   mkdir -p public/_src/anim public/_src/tex
 *   unzip -j 'Base+mesh+FBX.zip' '*Base mesh.fbx' -d public/_src
 *   mv 'public/_src/Base mesh.fbx' public/_src/base.fbx
 *   unzip -j 'animation+fbx.zip' '*.fbx' -d public/_src/anim
 *   unzip -j texture.zip '*ork_Albedo.tga' -d public/_src/tex
 *   unzip -j texture.zip '*axe_Albedo.tga' -d public/_src/tex
 *   mv public/_src/tex/ork_Albedo.tga public/_src/tex/ork.tga
 *   mv public/_src/tex/axe_Albedo.tga public/_src/tex/axe.tga
 *   node tools/fbx-to-creep.mjs
 *   rm -rf public/_src
 *
 * The staging directory is temporary and must NOT be committed: it is a quarter
 * of a gigabyte of source art, and `public/` ships to the browser.
 *
 * Why this exists, and why the previous conversion had to be thrown away.
 *
 * This orc's base mesh arrives as 49 submeshes, and every one of them carries
 * its OWN skeleton object: 49 skeletons, each holding the same 136 bones in a
 * different order. A submesh's `skinIndex` is an index into its own bone array
 * and means nothing against anyone else's. The first conversion merged the
 * geometry and kept those indices as they were, so every submesh after the
 * first ended up driven by whatever bone happened to sit at that slot in the
 * first skeleton. That is how an axe bound to `ork_right_axe_1` came out of the
 * pipeline welded to the hips, floating beside the character.
 *
 * So the one thing this file must get right is the remap: build a single
 * skeleton keyed by bone NAME, and rewrite every submesh's indices through it.
 *
 * The rest is ordinary. Vertices are pre-transformed by each submesh's bind
 * matrix so the merged mesh binds at identity. The body and the axe textures
 * are packed into one atlas so the character stays a single mesh with a single
 * material. Clips come from twelve animation files whose bone names
 * match the base mesh, so they need no retargeting, only renaming to the ids
 * this project uses.
 *
 * The conversion runs inside a browser page because three's FBXLoader wants a
 * DOM and a WebGL context for textures; Playwright drives it and writes the
 * result to disk.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PAGE = 'http://127.0.0.1:5173/play/';
const OUT = 'public/models/orc.glb';

/** Source file -> the clip id this project animates with. */
const CLIP_SOURCES = {
  idle: { file: 'ork@idle1.fbx', trim: 'loop' },
  walk: { file: 'ork@walk.fbx', trim: 'loop' },
  run: { file: 'ork@run.fbx', trim: 'loop' },
  // These files hold several swings back to back, so one burst is taken.
  attack: { file: 'ork@atack1.fbx', trim: 'burst' },
  cast: { file: 'ork@roar.fbx', trim: 'burst' },
  hit: { file: 'ork@gethit.fbx', trim: 'burst' },
  // A death is not a burst: the body falls once and then stays down, so the
  // cut runs from the first movement to the last rather than around a peak.
  death: { file: 'ork@death.fbx', trim: 'span' },
};

const inPage = async (clipSources) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { FBXLoader } = await import('/node_modules/three/examples/jsm/loaders/FBXLoader.js');
  const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
  const { TGALoader } = await import('/node_modules/three/examples/jsm/loaders/TGALoader.js');

  const report = { steps: [] };
  const say = (k, v) => report.steps.push(`${k}: ${v}`);

  // ── 1. The base mesh, and the one skeleton everything will answer to ───────
  const base = await new FBXLoader().loadAsync('/_src/base.fbx');
  base.updateMatrixWorld(true);

  const parts = [];
  base.traverse((o) => {
    if (o.isSkinnedMesh && o.geometry.getAttribute('skinIndex')) parts.push(o);
  });
  say('submeshes', parts.length);

  // Bones are shared scene nodes; only the per-skeleton ORDER differs. Keying
  // by name collapses the 49 orderings into one.
  const boneByName = new Map();
  for (const part of parts) {
    for (const bone of part.skeleton.bones) {
      if (!boneByName.has(bone.name)) boneByName.set(bone.name, bone);
    }
  }
  const bones = [...boneByName.values()];
  const slotOf = new Map(bones.map((b, i) => [b.name, i]));
  say('bones', bones.length);
  say('axeBones', bones.filter((b) => /_axe_/i.test(b.name)).map((b) => b.name).join(', ') || 'NONE');

  // ── 2. Merge, remapping indices and baking each submesh's bind matrix ──────
  const byMaterial = new Map();
  let vertexTotal = 0;
  for (const part of parts) {
    const g = part.geometry;
    const count = g.getAttribute('position').count;
    const name = (Array.isArray(part.material) ? part.material[0] : part.material).name || 'default';
    if (!byMaterial.has(name)) byMaterial.set(name, []);

    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const si = new Uint16Array(count * 4);
    const sw = new Float32Array(count * 4);

    // At bind pose the skinned result is `bindMatrix * v`, so baking that in
    // puts every submesh in one shared space and lets the merged mesh bind at
    // identity.
    const bind = part.bindMatrix.clone();
    const normalBind = new THREE.Matrix3().getNormalMatrix(bind);
    const aPos = g.getAttribute('position');
    const aNrm = g.getAttribute('normal');
    const aUv = g.getAttribute('uv');
    const aSi = g.getAttribute('skinIndex');
    const aSw = g.getAttribute('skinWeight');
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(aPos, i).applyMatrix4(bind);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      if (aNrm) {
        n.fromBufferAttribute(aNrm, i).applyMatrix3(normalBind).normalize();
        nrm[i * 3] = n.x; nrm[i * 3 + 1] = n.y; nrm[i * 3 + 2] = n.z;
      }
      if (aUv) { uv[i * 2] = aUv.getX(i); uv[i * 2 + 1] = aUv.getY(i); }
      for (let k = 0; k < 4; k++) {
        const local = aSi.getComponent(i, k);
        const bone = part.skeleton.bones[local];
        si[i * 4 + k] = bone ? slotOf.get(bone.name) ?? 0 : 0;
        sw[i * 4 + k] = aSw.getComponent(i, k);
      }
    }
    const index = g.index ? Array.from(g.index.array) : [...Array(count).keys()];
    byMaterial.get(name).push({ count, pos, nrm, uv, si, sw, index });
    vertexTotal += count;
  }
  say('mergedVerts', vertexTotal);
  say('materials', [...byMaterial.keys()].join(', '));

  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const uvs = new Float32Array(vertexTotal * 2);
  const skinIndices = new Uint16Array(vertexTotal * 4);
  const skinWeights = new Float32Array(vertexTotal * 4);
  const indices = [];
  const groups = [];
  let vCursor = 0;
  for (const [name, chunks] of byMaterial) {
    const start = indices.length;
    for (const c of chunks) {
      positions.set(c.pos, vCursor * 3);
      normals.set(c.nrm, vCursor * 3);
      uvs.set(c.uv, vCursor * 2);
      skinIndices.set(c.si, vCursor * 4);
      skinWeights.set(c.sw, vCursor * 4);
      for (const i of c.index) indices.push(i + vCursor);
      vCursor += c.count;
    }
    groups.push({ name, start, count: indices.length - start });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
  say('groups', groups.map((g) => `${g.name}:${g.count / 3}tri`).join(' '));

  // ── 3. Textures ───────────────────────────────────────────────────────────
  const tga = new TGALoader();
  const shrink = async (url, size) => {
    const tex = await tga.loadAsync(url);
    const src = tex.image;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const tmp = document.createElement('canvas');
    tmp.width = src.width; tmp.height = src.height;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0);
    ctx.save();
    // TGA rows arrive bottom-up relative to what three expects here.
    ctx.scale(1, -1);
    ctx.drawImage(tmp, 0, -size, size, size);
    ctx.restore();
    const out = new THREE.CanvasTexture(canvas);
    out.colorSpace = THREE.SRGBColorSpace;
    out.flipY = false;
    return { texture: out, from: [src.width, src.height] };
  };
  const bodyTex = await shrink('/_src/tex/ork.tga', 1024);
  const axeTex = await shrink('/_src/tex/axe.tga', 512);

  // One atlas, not two materials. Two materials mean two draw groups, and the
  // exporter writes a draw group as its own glTF mesh with its own full copy of
  // the vertex buffer: 3,553 vertices became 7,106, skinned twice per frame,
  // for two draw calls per orc. Packing the body into the left half and the
  // axes into the right collapses that back to one mesh, one material and one
  // skinning pass, and the UVs just scale into their half.
  const atlas = document.createElement('canvas');
  atlas.width = 2048;
  atlas.height = 1024;
  const actx = atlas.getContext('2d');
  const RECT = {
    lambert1: { x: 0, y: 0, w: 1024, h: 1024 },
    lambert2: { x: 1024, y: 0, w: 512, h: 512 },
  };
  actx.drawImage(bodyTex.texture.image, RECT.lambert1.x, RECT.lambert1.y, RECT.lambert1.w, RECT.lambert1.h);
  actx.drawImage(axeTex.texture.image, RECT.lambert2.x, RECT.lambert2.y, RECT.lambert2.w, RECT.lambert2.h);
  const atlasTexture = new THREE.CanvasTexture(atlas);
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.flipY = false;
  say('textures', `body ${bodyTex.from.join('x')}->1024 + axe ${axeTex.from.join('x')}->512, packed into one 2048x1024 atlas`);

  let uvCursor = 0;
  for (const [name, chunks] of byMaterial) {
    const r = RECT[name] ?? RECT.lambert1;
    for (const c of chunks) {
      for (let i = 0; i < c.count; i++) {
        const at = (uvCursor + i) * 2;
        uvs[at] = (r.x + uvs[at] * r.w) / atlas.width;
        uvs[at + 1] = (r.y + uvs[at + 1] * r.h) / atlas.height;
      }
      uvCursor += c.count;
    }
  }
  geometry.getAttribute('uv').needsUpdate = true;

  const materials = [
    new THREE.MeshStandardMaterial({
      name: 'orc',
      map: atlasTexture,
      roughness: 0.85,
      metalness: 0.0,
    }),
  ];

  // ── 4. The skinned mesh ───────────────────────────────────────────────────
  const skeleton = new THREE.Skeleton(bones);
  const mesh = new THREE.SkinnedMesh(geometry, materials[0]);
  mesh.name = 'orc';
  // The bones live under the FBX root; keep that hierarchy and hang the mesh
  // beside it so the exporter writes a complete skin.
  const root = new THREE.Group();
  root.name = 'orc_root';
  const boneRoot = bones[0];
  let top = boneRoot;
  while (top.parent && top.parent.isBone) top = top.parent;
  root.add(top);
  root.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());
  root.updateMatrixWorld(true);

  // ── 5. Clips ──────────────────────────────────────────────────────────────
  /**
   * Cuts a clip down to the window where something actually moves.
   *
   * These files pad every animation to the same length with the bind pose: the
   * attack is 9.17 seconds long and the swing occupies under one of them. Left
   * alone that is nine seconds of identical frames in the file and a creature
   * that stands still for eight of them.
   */
  const trimClip = (clip, id) => {
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const track of clip.tracks) {
      const n = track.times.length;
      const size = track.getValueSize();
      if (n < 2) continue;
      let range = 0;
      for (let c = 0; c < size; c++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < n; i++) {
          const value = track.values[i * size + c];
          if (value < lo) lo = value;
          if (value > hi) hi = value;
        }
        range = Math.max(range, hi - lo);
      }
      if (range < 1e-4) continue; // a track that holds one pose says nothing
      const eps = range * 0.02;
      let first = -1;
      let last = -1;
      for (let i = 0; i < n; i++) {
        let delta = 0;
        for (let c = 0; c < size; c++) {
          delta = Math.max(delta, Math.abs(track.values[i * size + c] - track.values[c]));
        }
        if (delta > eps) {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first < 0) continue;
      t0 = Math.min(t0, track.times[Math.max(0, first - 1)]);
      t1 = Math.max(t1, track.times[Math.min(n - 1, last + 1)]);
    }
    if (!Number.isFinite(t0) || t1 <= t0) return new THREE.AnimationClip(id, clip.duration, clip.tracks);

    const tracks = [];
    for (const track of clip.tracks) {
      const size = track.getValueSize();
      const times = [];
      const values = [];
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        if (t < t0 - 1e-6 || t > t1 + 1e-6) continue;
        times.push(t - t0);
        for (let c = 0; c < size; c++) values.push(track.values[i * size + c]);
      }
      if (times.length < 2) {
        // A bone that never moves still has to hold its pose for the clip.
        times.length = 0;
        values.length = 0;
        times.push(0, t1 - t0);
        for (let r = 0; r < 2; r++) for (let c = 0; c < size; c++) values.push(track.values[c]);
      }
      tracks.push(new track.constructor(track.name, times, values));
    }
    return new THREE.AnimationClip(id, t1 - t0, tracks);
  };

  /**
   * For a one-shot, finds the single burst of movement around the strongest
   * moment in the file.
   *
   * `trimClip` cuts away padding, which is enough for a loop, but these attack
   * files hold several swings back to back: the first is 9.17 seconds of
   * continuous motion. A creep that plays all of it stands around for most of
   * its attack, which is what made the swing impossible to see. Walking out
   * from the peak while movement stays above a tenth of it isolates one swing.
   *
   * Movement is measured over every bone relative to the hips, not over one
   * limb, because a flinch or a death is the whole body and a hand-only metric
   * reports zero for them.
   */
  const burstWindow = (fbx, clip, skinned, wholeSpan) => {
    const bones = skinned ? skinned.skeleton.bones : [];
    if (!bones.length) return null;
    const hips = bones.find((b) => /_Hips$/i.test(b.name)) ?? bones[0];
    const mixer = new THREE.AnimationMixer(fbx);
    const action = mixer.clipAction(clip);
    action.reset();
    action.play();
    const STEPS = 120;
    const here = new THREE.Vector3();
    const base = new THREE.Vector3();
    let previous = null;
    const energy = [];
    for (let s = 0; s <= STEPS; s++) {
      mixer.setTime((s / STEPS) * clip.duration);
      fbx.updateMatrixWorld(true);
      hips.getWorldPosition(base);
      const pose = new Float64Array(bones.length * 3);
      for (let i = 0; i < bones.length; i++) {
        bones[i].getWorldPosition(here).sub(base);
        pose[i * 3] = here.x; pose[i * 3 + 1] = here.y; pose[i * 3 + 2] = here.z;
      }
      let delta = 0;
      if (previous) for (let i = 0; i < pose.length; i++) delta += Math.abs(pose[i] - previous[i]);
      energy.push(delta);
      previous = pose;
    }
    action.stop();
    mixer.uncacheClip(clip);
    const peak = Math.max(...energy);
    if (peak <= 0) return null;
    const floor = peak * (wholeSpan ? 0.05 : 0.1);
    let lo;
    let hi;
    if (wholeSpan) {
      lo = energy.findIndex((e) => e > floor);
      hi = energy.length - 1 - [...energy].reverse().findIndex((e) => e > floor);
    } else {
      const at = energy.indexOf(peak);
      lo = at; hi = at;
      while (lo > 0 && energy[lo - 1] > floor) lo--;
      while (hi < STEPS && energy[hi + 1] > floor) hi++;
    }
    // A couple of steps of lead-in and follow-through keep the swing from
    // starting and ending on a hard cut.
    lo = Math.max(0, lo - 3);
    hi = Math.min(STEPS, hi + 3);
    return [(lo / STEPS) * clip.duration, (hi / STEPS) * clip.duration];
  };

  const windowClip = (clip, id, span) => {
    const tracks = [];
    for (const track of clip.tracks) {
      const size = track.getValueSize();
      const times = [];
      const values = [];
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        if (t < span[0] - 1e-6 || t > span[1] + 1e-6) continue;
        times.push(t - span[0]);
        for (let c = 0; c < size; c++) values.push(track.values[i * size + c]);
      }
      if (times.length < 2) continue;
      tracks.push(new track.constructor(track.name, times, values));
    }
    return new THREE.AnimationClip(id, span[1] - span[0], tracks);
  };

    const clips = [];
  const clipInfo = [];
  const unmatched = new Set();
  const loader = new FBXLoader();
  for (const [id, source] of Object.entries(clipSources)) {
    const fbx = await loader.loadAsync('/_src/anim/' + source.file);
    const clip = fbx.animations[0];
    if (!clip) continue;
    // Bone names match the base mesh exactly, so the tracks need no retarget.
    // What does not match is helper nodes the animation rig carries and the
    // mesh does not; those are dropped, and named here so a real mismatch
    // cannot hide among them.
    const kept = [];
    for (const track of clip.tracks) {
      const node = track.name.split('.')[0];
      if (boneByName.has(node)) kept.push(track);
      else unmatched.add(node);
    }
    const whole = new THREE.AnimationClip(id, clip.duration, kept);
    let cut;
    if (source.trim === 'loop') {
      cut = trimClip(whole, id);
    } else {
      let animated = null;
      fbx.traverse((o) => { if (!animated && o.isSkinnedMesh) animated = o; });
      const span = burstWindow(fbx, clip, animated, source.trim === 'span');
      cut = span ? windowClip(whole, id, span) : trimClip(whole, id);
    }
    clips.push(cut);
    clipInfo.push({ id, from: +clip.duration.toFixed(2), to: +cut.duration.toFixed(2), tracks: cut.tracks.length });
  }
  say('clips', clipInfo.map((c) => `${c.id} ${c.from}s->${c.to}s`).join('  '));
  say('unmatchedNodes', [...unmatched].slice(0, 8).join(', ') + (unmatched.size > 8 ? ` (+${unmatched.size - 8})` : ''));
  report.clips = clipInfo;

  // ── 6. Weld, then decimate each material group on its own ─────────────────
  const { MeshoptSimplifier } = await import('/node_modules/meshoptimizer/meshopt_simplifier.module.js');
  await MeshoptSimplifier.ready;

  // Welding keys on the skin binding as well as the surface. Two vertices in
  // the same place driven by different bones are genuinely different vertices,
  // and merging them tears a seam open the moment those bones separate.
  const key = (i) => {
    const q = (x) => Math.round(x * 2048);
    let s = `${q(positions[i * 3])},${q(positions[i * 3 + 1])},${q(positions[i * 3 + 2])}`;
    s += `|${Math.round(normals[i * 3] * 64)},${Math.round(normals[i * 3 + 1] * 64)},${Math.round(normals[i * 3 + 2] * 64)}`;
    s += `|${Math.round(uvs[i * 2] * 4096)},${Math.round(uvs[i * 2 + 1] * 4096)}`;
    for (let k = 0; k < 4; k++) s += `|${skinIndices[i * 4 + k]}:${Math.round(skinWeights[i * 4 + k] * 255)}`;
    return s;
  };
  const weldMap = new Int32Array(vertexTotal);
  const seen = new Map();
  const keepOrder = [];
  for (let i = 0; i < vertexTotal; i++) {
    const k = key(i);
    let at = seen.get(k);
    if (at === undefined) {
      at = keepOrder.length;
      seen.set(k, at);
      keepOrder.push(i);
    }
    weldMap[i] = at;
  }
  const welded = keepOrder.length;
  say('welded', `${vertexTotal} -> ${welded}`);

  const take = (src, stride) => {
    const out = new src.constructor(welded * stride);
    for (let i = 0; i < welded; i++) {
      const from = keepOrder[i];
      for (let c = 0; c < stride; c++) out[i * stride + c] = src[from * stride + c];
    }
    return out;
  };
  const wPos = take(positions, 3);
  const wNrm = take(normals, 3);
  const wUv = take(uvs, 2);
  const wSi = take(skinIndices, 4);
  const wSw = take(skinWeights, 4);

  // Budgets are per group rather than global so the axes, which are a fifth of
  // the triangles and most of the silhouette, do not get optimised away in
  // favour of folds in a kilt.
  const BUDGET = { lambert1: 2600, lambert2: 1000 };
  const finalIndex = [];
  const finalGroups = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const sub = new Uint32Array(g.count);
    for (let i = 0; i < g.count; i++) sub[i] = weldMap[indices[g.start + i]];
    const target = Math.min(sub.length, (BUDGET[g.name] ?? 1500) * 3);
    const simplified = MeshoptSimplifier.simplify(sub, wPos, 3, target - (target % 3), 0.02, ['LockBorder']);
    const kept = simplified[0];
    const start = finalIndex.length;
    for (const v of kept) finalIndex.push(v);
    finalGroups.push({ name: g.name, start, count: kept.length });
    say(`decimate:${g.name}`, `${g.count / 3} -> ${kept.length / 3} tri`);
  }

  // Drop vertices nothing points at any more.
  const used = new Int32Array(welded).fill(-1);
  for (const v of finalIndex) used[v] = 0;
  let live = 0;
  for (let i = 0; i < welded; i++) if (used[i] === 0) used[i] = live++;
  const pack = (src, stride) => {
    const out = new src.constructor(live * stride);
    for (let i = 0; i < welded; i++) {
      if (used[i] < 0) continue;
      for (let c = 0; c < stride; c++) out[used[i] * stride + c] = src[i * stride + c];
    }
    return out;
  };
  const outGeometry = new THREE.BufferGeometry();
  outGeometry.setAttribute('position', new THREE.BufferAttribute(pack(wPos, 3), 3));
  outGeometry.setAttribute('normal', new THREE.BufferAttribute(pack(wNrm, 3), 3));
  outGeometry.setAttribute('uv', new THREE.BufferAttribute(pack(wUv, 2), 2));
  outGeometry.setAttribute('skinIndex', new THREE.BufferAttribute(pack(wSi, 4), 4));
  outGeometry.setAttribute('skinWeight', new THREE.BufferAttribute(pack(wSw, 4), 4));
  outGeometry.setIndex(finalIndex.map((v) => used[v]));
  // A single group, because the atlas gave the character a single material.
  outGeometry.addGroup(0, finalIndex.length, 0);
  say('final', `${live} verts, ${finalIndex.length / 3} tris`);

  mesh.geometry = outGeometry;
  root.updateMatrixWorld(true);

  // ── 7. Did the axes survive all of that? ──────────────────────────────────
  const outSi = outGeometry.getAttribute('skinIndex');
  const outSw = outGeometry.getAttribute('skinWeight');
  const check = {};
  for (const bn of ['ork_right_axe_1', 'ork_left_axe_1']) {
    const slot = slotOf.get(bn);
    if (slot === undefined) { check[bn] = 'MISSING'; continue; }
    let n = 0;
    for (let i = 0; i < outSi.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (outSi.getComponent(i, k) === slot && outSw.getComponent(i, k) > 0.5) { n++; break; }
      }
    }
    check[bn] = n;
  }
  report.axeVertices = check;

  // ── 8. Flatten the hierarchy before writing it ────────────────────────────
  // The FBX leaves an empty node in front of every bone, nested forty deep, so
  // the skeleton reaches the file as 5,599 nodes to express 139 bones. The
  // runtime loader already collapses them, but doing it here means the file is
  // smaller and every boot does less work. A node goes only when it is not a
  // bone, not a mesh, has exactly one child, carries an identity transform and
  // is named by no animation track.
  {
    const protectedNodes = new Set(bones);
    const animatedNames = new Set();
    for (const clip of clips) for (const t of clip.tracks) animatedNames.add(t.name.split('.')[0]);
    let before = 0;
    root.traverse(() => before++);
    for (;;) {
      const candidates = [];
      root.traverse((o) => candidates.push(o));
      let cut = 0;
      for (const node of candidates) {
        if (node === root || !node.parent) continue;
        // The wrappers are Bone instances too, so membership in the skeleton is
        // what protects a node, not its class.
        if (protectedNodes.has(node) || node.isMesh) continue;
        if (node.children.length !== 1) continue;
        if (animatedNames.has(node.name)) continue;
        node.updateMatrix();
        const e = node.matrix.elements;
        let identity = true;
        for (let i = 0; i < 16; i++) {
          const want = i % 5 === 0 ? 1 : 0;
          if (Math.abs(e[i] - want) > 1e-6) { identity = false; break; }
        }
        if (!identity) continue;
        node.parent.add(node.children[0]);
        node.removeFromParent();
        cut++;
      }
      if (cut === 0) break;
    }
    let after = 0;
    root.traverse(() => after++);
    root.updateMatrixWorld(true);
    say('nodes', `${before} -> ${after}`);
  }

  // ── 9. Write the GLB ──────────────────────────────────────────────────────
  const buffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (result) => resolve(result),
      (err) => reject(err),
      { binary: true, animations: clips, includeCustomExtensions: false },
    );
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

const main = async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.error('PAGE ERROR', String(e).slice(0, 400)));
  await page.goto(PAGE, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 5000));

  const report = await page.evaluate(inPage, CLIP_SOURCES);
  for (const line of report.steps) console.log('  ' + line);
  console.log('  axeVertices:', JSON.stringify(report.axeVertices));

  if (!report.glbBase64) throw new Error('conversion produced no file');
  const out = Buffer.from(report.glbBase64, 'base64');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`  wrote ${OUT} (${(out.length / 1048576).toFixed(2)} MB)`);

  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { CLIP_SOURCES };
