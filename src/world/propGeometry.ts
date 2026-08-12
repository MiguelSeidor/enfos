/**
 * Procedural prop geometry. Owner: TERRAIN agent.
 *
 * Every doodad in the world is generated here from primitives — no meshes ship
 * with the project (GDD legal note). Each builder returns geometry in a
 * canonical pose: origin at the base, +Y up, roughly unit scale, so the scatter
 * pass can place it with a single matrix.
 *
 * Geometry is built once per variant and drawn through `InstancedMesh`, so a
 * forest of six hundred trees costs two draw calls.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Rng } from '@/core/rng';
import { clamp01, lerp } from '@/core/mathx';

export interface TreeGeometry {
  trunk: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
}

/**
 * Per-face axis-aligned UVs. Icosahedron and lathe UVs stretch badly on an
 * irregular blob; projecting each triangle onto its dominant axis gives even
 * texel density with no shader cost and no visible seams on a rock.
 */
function bakeTriplanarUv(geo: THREE.BufferGeometry, scale: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array((pos.count / 3) * 6);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let t = 0; t < pos.count / 3; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c;
      let u: number;
      let w: number;
      if (ax >= ay && ax >= az) {
        u = v.z;
        w = v.y;
      } else if (ay >= az) {
        u = v.x;
        w = v.z;
      } else {
        u = v.x;
        w = v.y;
      }
      uv[(t * 3 + k) * 2] = u * scale;
      uv[(t * 3 + k) * 2 + 1] = w * scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (g !== geo) geo.dispose();
  return g;
}

/** Radially displaces a sphere-like geometry into an irregular boulder. */
function roughen(geo: THREE.BufferGeometry, rng: Rng, amount: number, squash: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // Three random lobes give a boulder a readable large-scale silhouette; pure
  // per-vertex noise just makes it look furry.
  const lobes: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    lobes.push(new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize());
  }
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const dir = v.clone().normalize();
    let d = 0;
    for (let l = 0; l < lobes.length; l++) d += Math.max(0, dir.dot(lobes[l]!)) * (0.4 + l * 0.12);
    const jitter = Math.sin(v.x * 7.3 + v.y * 5.1) * Math.cos(v.z * 6.7 - v.x * 3.3);
    const k = 1 + (d - 0.45) * amount + jitter * amount * 0.35;
    v.multiplyScalar(k);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
}

/** Adds a per-vertex wind weight so the shader knows what may sway. */
export function bakeSway(
  geo: THREE.BufferGeometry,
  height: number,
  base: number,
  power: number,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp01(pos.getY(i) / Math.max(0.001, height));
    sway[i] = base + (1 - base) * Math.pow(t, power);
  }
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
}

function branchSegment(r0: number, r1: number, len: number, radial: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, true);
  g.translate(0, len / 2, 0);
  return g;
}

/**
 * Recursive broadleaf: a tapering trunk that forks into progressively thinner
 * limbs, with foliage clusters at the tips. Trunk and foliage come back as
 * separate geometries so each can use its own material.
 */
export function buildBroadleaf(rng: Rng): TreeGeometry {
  const trunkParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const height = rng.range(6.5, 9.5);

  const grow = (
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    length: number,
    depth: number,
  ): void => {
    const seg = branchSegment(radius, radius * 0.72, length, depth === 0 ? 7 : 5);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    m.compose(origin, q, new THREE.Vector3(1, 1, 1));
    seg.applyMatrix4(m);
    trunkParts.push(seg);

    const tip = origin.clone().addScaledVector(dir, length);

    if (depth >= 2 || radius < 0.12) {
      // Leaf cluster: a few overlapping blobs read as a canopy mass and hold a
      // chunky silhouette at RTS distance, which a billboard card does not.
      const blobs = rng.int(2, 3);
      for (let i = 0; i < blobs; i++) {
        const r = rng.range(0.9, 1.5);
        const blob = new THREE.IcosahedronGeometry(r, 0);
        roughen(blob, rng, 0.45, rng.range(0.7, 0.95));
        blob.translate(
          tip.x + rng.range(-0.7, 0.7),
          tip.y + rng.range(-0.3, 0.8),
          tip.z + rng.range(-0.7, 0.7),
        );
        leafParts.push(blob);
      }
      return;
    }

    const children = depth === 0 ? rng.int(3, 4) : rng.int(2, 3);
    for (let i = 0; i < children; i++) {
      const spread = lerp(0.55, 0.95, depth / 3);
      const angle = (i / children) * Math.PI * 2 + rng.range(-0.5, 0.5);
      const child = dir
        .clone()
        .add(
          new THREE.Vector3(Math.cos(angle) * spread, rng.range(0.05, 0.4), Math.sin(angle) * spread),
        )
        .normalize();
      grow(tip, child, radius * rng.range(0.6, 0.74), length * rng.range(0.62, 0.8), depth + 1);
    }
  };

  grow(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), rng.range(0.3, 0.42), height * 0.42, 0);

  const trunk = mergeGeometries(trunkParts, false)!;
  const foliage = mergeGeometries(leafParts, false)!;
  for (const p of trunkParts) p.dispose();
  for (const p of leafParts) p.dispose();
  trunk.computeVertexNormals();
  foliage.computeVertexNormals();
  bakeSway(trunk, height, 0, 2.2);
  bakeSway(foliage, height, 0.35, 1.4);
  return { trunk, foliage };
}

/** Stacked-cone conifer: cheaper, and gives the highlands a different skyline. */
export function buildConifer(rng: Rng): TreeGeometry {
  const height = rng.range(8, 12);
  const trunkG = branchSegment(0.34, 0.12, height * 0.92, 6);
  const tiers = rng.int(4, 6);
  const leafParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = lerp(height * 0.2, height * 0.94, t);
    const r = lerp(2.5, 0.5, t) * rng.range(0.88, 1.12);
    const h = lerp(3.0, 1.3, t);
    const cone = new THREE.ConeGeometry(r, h, 7, 1, true);
    cone.translate(rng.range(-0.12, 0.12), y + h * 0.3, rng.range(-0.12, 0.12));
    leafParts.push(cone);
  }
  const foliage = mergeGeometries(leafParts, false)!;
  for (const p of leafParts) p.dispose();
  trunkG.computeVertexNormals();
  foliage.computeVertexNormals();
  bakeSway(trunkG, height, 0, 2.6);
  bakeSway(foliage, height, 0.2, 1.8);
  return { trunk: trunkG, foliage };
}

/** Dead, leafless tree — used to dress the churned ground near the lane. */
export function buildDeadTree(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const height = rng.range(5, 7.5);
  const grow = (
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    length: number,
    depth: number,
  ): void => {
    const seg = branchSegment(radius, radius * 0.6, length, depth === 0 ? 6 : 4);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    seg.applyMatrix4(new THREE.Matrix4().compose(origin, q, new THREE.Vector3(1, 1, 1)));
    parts.push(seg);
    if (depth >= 2 || radius < 0.07) return;
    const tip = origin.clone().addScaledVector(dir, length);
    const children = rng.int(2, 3);
    for (let i = 0; i < children; i++) {
      const angle = (i / children) * Math.PI * 2 + rng.range(-0.7, 0.7);
      const child = dir
        .clone()
        .add(new THREE.Vector3(Math.cos(angle) * 0.9, rng.range(-0.1, 0.35), Math.sin(angle) * 0.9))
        .normalize();
      grow(tip, child, radius * 0.6, length * 0.65, depth + 1);
    }
  };
  grow(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0.3, height * 0.5, 0);
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  geo.computeVertexNormals();
  bakeSway(geo, height, 0, 2.6);
  return geo;
}

export function buildRock(rng: Rng, detail: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  roughen(geo, rng, rng.range(0.5, 0.85), rng.range(0.55, 0.9));
  const out = bakeTriplanarUv(geo, 0.55);
  out.computeVertexNormals();
  return out;
}

/** Fallen log with a couple of broken stubs. */
export function buildLog(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const len = rng.range(3.5, 6);
  const r = rng.range(0.28, 0.45);
  const main = new THREE.CylinderGeometry(r * 0.8, r, len, 7, 1, false);
  main.rotateZ(Math.PI / 2);
  main.rotateY(rng.range(-0.25, 0.25));
  main.translate(0, r, 0);
  parts.push(main);
  const stubs = rng.int(1, 3);
  for (let i = 0; i < stubs; i++) {
    const s = new THREE.CylinderGeometry(r * 0.15, r * 0.3, rng.range(0.5, 1.1), 5, 1, false);
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rng.range(-1.1, 1.1), rng.range(0, 6.28), rng.range(-0.7, 0.7)),
    );
    s.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(rng.range(-len * 0.4, len * 0.4), r * 1.1, 0),
        q,
        new THREE.Vector3(1, 1, 1),
      ),
    );
    parts.push(s);
  }
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  geo.computeVertexNormals();
  bakeSway(geo, 1, 0, 1);
  return geo;
}

export function buildStump(rng: Rng): THREE.BufferGeometry {
  const h = rng.range(0.6, 1.2);
  const geo = new THREE.CylinderGeometry(rng.range(0.35, 0.5), rng.range(0.5, 0.7), h, 8, 1, false);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // Splinter the top rim so it reads as broken rather than sawn.
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > h * 0.4) {
      pos.setY(i, pos.getY(i) + Math.abs(Math.sin(pos.getX(i) * 9 + pos.getZ(i) * 7)) * 0.35);
    }
  }
  geo.translate(0, h / 2, 0);
  geo.computeVertexNormals();
  bakeSway(geo, 1, 0, 1);
  return geo;
}

/** Low leafy bush; the filler that removes bare ground between the big props. */
export function buildBush(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs = rng.int(3, 5);
  let top = 0;
  for (let i = 0; i < blobs; i++) {
    const r = rng.range(0.5, 0.95);
    const b = new THREE.IcosahedronGeometry(r, 0);
    roughen(b, rng, 0.4, 0.75);
    const y = rng.range(r * 0.5, r * 1.1);
    b.translate(rng.range(-0.6, 0.6), y, rng.range(-0.6, 0.6));
    top = Math.max(top, y + r);
    parts.push(b);
  }
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  geo.computeVertexNormals();
  bakeSway(geo, top, 0.15, 1.5);
  return geo;
}

/** Broken masonry: column drums, wall fragments, toppled blocks. */
export function buildRuin(rng: Rng, kind: 'column' | 'wall' | 'block'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'column') {
    const drums = rng.int(2, 5);
    let y = 0;
    for (let i = 0; i < drums; i++) {
      const h = rng.range(0.7, 1.2);
      const r = rng.range(0.42, 0.55) * (1 - i * 0.04);
      const d = new THREE.CylinderGeometry(r, r * 1.05, h, 9, 1, false);
      d.translate(rng.range(-0.09, 0.09), y + h / 2, rng.range(-0.09, 0.09));
      d.rotateY(rng.range(0, 6.28));
      parts.push(d);
      y += h;
    }
  } else if (kind === 'wall') {
    const blocks = rng.int(4, 9);
    for (let i = 0; i < blocks; i++) {
      const w = rng.range(0.7, 1.3);
      const h = rng.range(0.4, 0.62);
      const b = new THREE.BoxGeometry(w, h, rng.range(0.5, 0.8));
      const row = Math.floor(i / 3);
      b.translate(
        (i % 3) * 1.15 + rng.range(-0.1, 0.1) - 1.15,
        row * 0.62 + h / 2,
        rng.range(-0.12, 0.12),
      );
      b.rotateY(rng.range(-0.06, 0.06));
      parts.push(b);
    }
  } else {
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const b = new THREE.BoxGeometry(rng.range(0.6, 1.4), rng.range(0.5, 0.9), rng.range(0.6, 1.2));
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rng.range(-0.35, 0.35), rng.range(0, 6.28), rng.range(-0.35, 0.35)),
      );
      b.applyMatrix4(
        new THREE.Matrix4().compose(
          new THREE.Vector3(rng.range(-0.8, 0.8), rng.range(0.2, 0.5), rng.range(-0.8, 0.8)),
          q,
          new THREE.Vector3(1, 1, 1),
        ),
      );
      parts.push(b);
    }
  }
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  const geo = bakeTriplanarUv(merged, 0.7);
  geo.computeVertexNormals();
  bakeSway(geo, 1, 0, 1);
  return geo;
}

/**
 * A tuft of grass: three blades crossed at different angles. Each blade is a
 * tapered strip of three triangles with normals fanned outward, so a tuft
 * catches the key light softly instead of reading as flat cardboard.
 */
export function buildGrassTuft(rng: Rng): THREE.BufferGeometry {
  const blades = 3;
  const vertsPerBlade = 5;
  const trisPerBlade = 3;
  const positions = new Float32Array(blades * vertsPerBlade * 3);
  const normals = new Float32Array(blades * vertsPerBlade * 3);
  const uvs = new Float32Array(blades * vertsPerBlade * 2);
  const sway = new Float32Array(blades * vertsPerBlade);
  const indices: number[] = [];

  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI + rng.range(-0.4, 0.4);
    const h = rng.range(0.55, 1.15);
    const w = rng.range(0.055, 0.085);
    const lean = rng.range(0.1, 0.4);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const ox = rng.range(-0.22, 0.22);
    const oz = rng.range(-0.22, 0.22);

    // (x offset across the blade, height fraction, width fraction)
    const spec: [number, number, number][] = [
      [-1, 0, 1],
      [1, 0, 1],
      [-1, 0.55, 0.62],
      [1, 0.55, 0.62],
      [0, 1, 0],
    ];
    for (let k = 0; k < vertsPerBlade; k++) {
      const [side, hy, wf] = spec[k]!;
      const across = side * w * wf;
      const bend = lean * hy * hy;
      const px = ox + cos * across + sin * bend;
      const pz = oz - sin * across + cos * bend;
      const idx = b * vertsPerBlade + k;
      positions[idx * 3] = px;
      positions[idx * 3 + 1] = hy * h;
      positions[idx * 3 + 2] = pz;
      // Fan the normal outward from the tuft centre so lighting reads as volume.
      const nx = sin * 0.55 + px * 0.4;
      const nz = cos * 0.55 + pz * 0.4;
      const ny = 0.85;
      const inv = 1 / Math.hypot(nx, ny, nz);
      normals[idx * 3] = nx * inv;
      normals[idx * 3 + 1] = ny * inv;
      normals[idx * 3 + 2] = nz * inv;
      uvs[idx * 2] = side * 0.5 + 0.5;
      uvs[idx * 2 + 1] = hy;
      sway[idx] = hy * hy;
    }
    const o = b * vertsPerBlade;
    indices.push(o, o + 1, o + 2, o + 2, o + 1, o + 3, o + 2, o + 3, o + 4);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  geo.setIndex(indices);
  void trisPerBlade;
  return geo;
}
