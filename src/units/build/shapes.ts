/**
 * Procedural shape primitives. Owner: CHARACTERS agent.
 *
 * Everything a character is made of is generated here from parameters — no mesh
 * file, no imported model, no third-party asset of any kind (hard legal
 * constraint, ARCHITECTURE.md).
 *
 * Two workhorses carry almost all of the silhouette work:
 *
 *  - `loft()`   sweeps a rounded-rectangle cross-section along a list of rings.
 *               Limbs, torsos, boots, horns, blades, spikes, tails.
 *  - `shell()`  thickens an arbitrary parametric mid-surface into a closed
 *               solid with a rim. Pauldrons, shields, capes, robe skirts,
 *               tabards, fins, banners.
 *
 * Both emit real UVs (u around / across, v along) so the material library's
 * albedo/normal/ORM maps land correctly — untextured geometry is an automatic
 * review rejection.
 */

import * as THREE from 'three';

export const TAU = Math.PI * 2;

// ─────────────────────────────────────────────────────────────────────────────
// Cross-sections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A superellipse sample. `round` controls how boxy the section reads:
 * 2 = ellipse, 4 = squircle, 8+ = nearly rectangular with soft corners.
 * Chunky boxy sections are what make a silhouette readable at RTS distance.
 */
function sectionPoint(w: number, d: number, round: number, t: number, out: THREE.Vector2): THREE.Vector2 {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const e = 2 / round;
  out.x = w * Math.sign(c) * Math.pow(Math.abs(c), e);
  out.y = d * Math.sign(s) * Math.pow(Math.abs(s), e);
  return out;
}

export interface Ring {
  /** Ring centre in local space. */
  x?: number;
  y: number;
  z?: number;
  /** Half-extent along local X. */
  w: number;
  /** Half-extent along local Z. */
  d: number;
  /** Superellipse exponent; 2 = ellipse, 8 = boxy. Default 4. */
  round?: number;
  /** Twist of the section about its own axis, radians. */
  twist?: number;
  /** Tilt of the section plane, radians. */
  tiltX?: number;
  tiltZ?: number;
}

export interface LoftOptions {
  /** Points around the cross-section. 8/12/16 are the useful values. */
  segments?: number;
  capStart?: boolean;
  capEnd?: boolean;
  /** Multiplies the generated UVs; raises texel density on small parts. */
  uvScale?: number;
  /** Hard-edge threshold in degrees. Below this, normals are averaged. */
  smoothAngle?: number;
}

/**
 * Sweeps a rounded-rect section through `rings`. Rings are ordered along +Y but
 * may translate in X/Z, so curved horns, hunched spines and bent blades all come
 * out of the same call.
 */
export function loft(rings: Ring[], opts: LoftOptions = {}): THREE.BufferGeometry {
  const segments = opts.segments ?? 12;
  const uvScale = opts.uvScale ?? 1;
  const n = rings.length;
  if (n < 2) throw new Error('loft needs at least two rings');

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const p = new THREE.Vector2();
  const v3 = new THREE.Vector3();
  const centres: THREE.Vector3[] = [];
  let arc = 0;
  const vCoord: number[] = [];

  for (let i = 0; i < n; i++) {
    const r = rings[i]!;
    const cx = r.x ?? 0;
    const cz = r.z ?? 0;
    centres.push(new THREE.Vector3(cx, r.y, cz));
    if (i > 0) arc += centres[i]!.distanceTo(centres[i - 1]!);
    vCoord.push(arc);
  }
  const totalArc = arc > 1e-5 ? arc : 1;

  for (let i = 0; i < n; i++) {
    const r = rings[i]!;
    const round = r.round ?? 4;
    const twist = r.twist ?? 0;
    const tiltX = r.tiltX ?? 0;
    const tiltZ = r.tiltZ ?? 0;
    const c = centres[i]!;
    for (let s = 0; s <= segments; s++) {
      const t = (s / segments) * TAU + twist;
      sectionPoint(r.w, r.d, round, t, p);
      v3.set(p.x, 0, p.y);
      if (tiltX !== 0) v3.applyAxisAngle(AXIS_X, tiltX);
      if (tiltZ !== 0) v3.applyAxisAngle(AXIS_Z, tiltZ);
      positions.push(c.x + v3.x, c.y + v3.y, c.z + v3.z);
      uvs.push((s / segments) * uvScale, (vCoord[i]! / totalArc) * uvScale * (totalArc / Math.max(r.w + r.d, 0.15)) * 0.5);
    }
  }

  const stride = segments + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < segments; s++) {
      const a = i * stride + s;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  if (opts.capStart !== false) capRing(positions, uvs, indices, rings[0]!, segments, 0, -1);
  if (opts.capEnd !== false) capRing(positions, uvs, indices, rings[n - 1]!, segments, (n - 1) * stride, 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return finishNormals(geo, opts.smoothAngle ?? 55);
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function capRing(
  positions: number[],
  uvs: number[],
  indices: number[],
  ring: Ring,
  segments: number,
  ringStart: number,
  dir: number,
): void {
  const centreIndex = positions.length / 3;
  positions.push(ring.x ?? 0, ring.y, ring.z ?? 0);
  uvs.push(0.5, 0.5);
  // Re-emit the rim so the cap gets its own planar UVs instead of the tube's.
  const rimStart = positions.length / 3;
  for (let s = 0; s <= segments; s++) {
    const i = (ringStart + s) * 3;
    positions.push(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    const t = (s / segments) * TAU;
    uvs.push(0.5 + Math.cos(t) * 0.5, 0.5 + Math.sin(t) * 0.5);
  }
  for (let s = 0; s < segments; s++) {
    const a = rimStart + s;
    const b = rimStart + s + 1;
    if (dir > 0) indices.push(centreIndex, a, b);
    else indices.push(centreIndex, b, a);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell — thickened parametric surface
// ─────────────────────────────────────────────────────────────────────────────

export interface ShellOptions {
  nu: number;
  nv: number;
  /** Mid-surface point for (u, v) in [0,1]². */
  surface: (u: number, v: number, out: THREE.Vector3) => void;
  /** Half-thickness at (u, v). A lens profile here turns a plate into a blade. */
  thickness: (u: number, v: number) => number;
  uvScale?: number;
  smoothAngle?: number;
}

/**
 * Thickens a mid-surface into a closed solid: front sheet, back sheet and a rim
 * strip so the piece has a real silhouette edge instead of reading as paper.
 */
export function shell(opts: ShellOptions): THREE.BufferGeometry {
  const { nu, nv, surface, thickness } = opts;
  const uvScale = opts.uvScale ?? 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const mid: THREE.Vector3[] = [];
  const nrm: THREE.Vector3[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const du = new THREE.Vector3();
  const dv = new THREE.Vector3();
  const eps = 1e-3;

  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const v = j / nv;
      surface(u, v, a);
      surface(Math.min(u + eps, 1), v, b);
      surface(u, Math.min(v + eps, 1), c);
      du.copy(b).sub(a);
      dv.copy(c).sub(a);
      if (u > 1 - eps) {
        surface(u - eps, v, b);
        du.copy(a).sub(b);
      }
      if (v > 1 - eps) {
        surface(u, v - eps, c);
        dv.copy(a).sub(c);
      }
      const n = new THREE.Vector3().crossVectors(du, dv);
      if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
      n.normalize();
      mid.push(a.clone());
      nrm.push(n);
    }
  }

  const stride = nu + 1;
  const at = (i: number, j: number): number => j * stride + i;

  // Front and back sheets.
  const sheetBase: number[] = [];
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    const base = positions.length / 3;
    sheetBase.push(base);
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const k = at(i, j);
        const u = i / nu;
        const v = j / nv;
        const t = thickness(u, v);
        const m = mid[k]!;
        const n = nrm[k]!;
        positions.push(m.x + n.x * t * sign, m.y + n.y * t * sign, m.z + n.z * t * sign);
        uvs.push(u * uvScale, v * uvScale);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p0 = base + at(i, j);
        const p1 = base + at(i + 1, j);
        const p2 = base + at(i, j + 1);
        const p3 = base + at(i + 1, j + 1);
        if (sign > 0) indices.push(p0, p2, p1, p1, p2, p3);
        else indices.push(p0, p1, p2, p1, p3, p2);
      }
    }
  }

  // Rim: walk the border and bridge front to back.
  const border: number[] = [];
  for (let i = 0; i <= nu; i++) border.push(at(i, 0));
  for (let j = 1; j <= nv; j++) border.push(at(nu, j));
  for (let i = nu - 1; i >= 0; i--) border.push(at(i, nv));
  for (let j = nv - 1; j >= 1; j--) border.push(at(0, j));

  const rimBase = positions.length / 3;
  const front = sheetBase[0]!;
  const back = sheetBase[1]!;
  for (let k = 0; k < border.length; k++) {
    const idx = border[k]!;
    const fi = (front + idx) * 3;
    const bi = (back + idx) * 3;
    positions.push(positions[fi]!, positions[fi + 1]!, positions[fi + 2]!);
    uvs.push((k / border.length) * uvScale * 2, 0);
    positions.push(positions[bi]!, positions[bi + 1]!, positions[bi + 2]!);
    uvs.push((k / border.length) * uvScale * 2, 0.25 * uvScale);
  }
  for (let k = 0; k < border.length; k++) {
    const k2 = (k + 1) % border.length;
    const f0 = rimBase + k * 2;
    const b0 = f0 + 1;
    const f1 = rimBase + k2 * 2;
    const b1 = f1 + 1;
    indices.push(f0, b0, f1, f1, b0, b1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return finishNormals(geo, opts.smoothAngle ?? 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Angle-weighted smoothing. Faces meeting under `angleDeg` share a normal;
 * sharper joins keep their crease. This is what stops a chunky armour plate
 * from reading as a soft blob under the key light.
 */
export function finishNormals(geo: THREE.BufferGeometry, angleDeg: number): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  const faceCount = count / 3;
  const faceN = new Float32Array(faceCount * 3);
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();

  for (let f = 0; f < faceCount; f++) {
    ax.fromBufferAttribute(pos, f * 3);
    bx.fromBufferAttribute(pos, f * 3 + 1);
    cx.fromBufferAttribute(pos, f * 3 + 2);
    e1.subVectors(bx, ax);
    e2.subVectors(cx, ax);
    fn.crossVectors(e1, e2);
    const len = fn.length();
    if (len > 1e-12) fn.multiplyScalar(1 / len);
    else fn.set(0, 1, 0);
    faceN[f * 3] = fn.x;
    faceN[f * 3 + 1] = fn.y;
    faceN[f * 3 + 2] = fn.z;
  }

  // Bucket vertices by quantised position so coincident verts can share.
  const buckets = new Map<string, number[]>();
  const q = 1e4;
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(i);
  }

  const cosLimit = Math.cos(angleDeg * (Math.PI / 180));
  const out = new Float32Array(count * 3);
  const acc = new THREE.Vector3();
  for (const arr of buckets.values()) {
    for (const i of arr) {
      const fi = (i / 3) | 0;
      const nx = faceN[fi * 3]!;
      const ny = faceN[fi * 3 + 1]!;
      const nz = faceN[fi * 3 + 2]!;
      acc.set(0, 0, 0);
      for (const j of arr) {
        const fj = (j / 3) | 0;
        const mx = faceN[fj * 3]!;
        const my = faceN[fj * 3 + 1]!;
        const mz = faceN[fj * 3 + 2]!;
        if (nx * mx + ny * my + nz * mz >= cosLimit) acc.x += mx, acc.y += my, acc.z += mz;
      }
      if (acc.lengthSq() < 1e-12) acc.set(nx, ny, nz);
      acc.normalize();
      out[i * 3] = acc.x;
      out[i * 3 + 1] = acc.y;
      out[i * 3 + 2] = acc.z;
    }
  }

  src.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  if (src !== geo) geo.dispose();
  return src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience builders
// ─────────────────────────────────────────────────────────────────────────────

/** Tapered chunky prism — the default limb / torso segment. */
export function prism(opts: {
  h: number;
  w0: number;
  d0: number;
  w1: number;
  d1: number;
  round?: number;
  segments?: number;
  /** Lateral drift of the top ring, for shoulders that flare outward. */
  shiftX?: number;
  shiftZ?: number;
  /** Adds a mid ring at this fraction with this bulge multiplier. */
  bulge?: number;
  bulgeAt?: number;
  smoothAngle?: number;
}): THREE.BufferGeometry {
  const round = opts.round ?? 4;
  const rings: Ring[] = [{ y: 0, w: opts.w0, d: opts.d0, round }];
  if (opts.bulge !== undefined) {
    const t = opts.bulgeAt ?? 0.45;
    rings.push({
      y: opts.h * t,
      x: (opts.shiftX ?? 0) * t,
      z: (opts.shiftZ ?? 0) * t,
      w: (opts.w0 + (opts.w1 - opts.w0) * t) * opts.bulge,
      d: (opts.d0 + (opts.d1 - opts.d0) * t) * opts.bulge,
      round,
    });
  }
  rings.push({ y: opts.h, x: opts.shiftX ?? 0, z: opts.shiftZ ?? 0, w: opts.w1, d: opts.d1, round });
  return loft(rings, {
    segments: opts.segments ?? 12,
    smoothAngle: opts.smoothAngle ?? 55,
  });
}

/** Curved horn / spike / claw. Sweeps and tapers along an arc. */
export function spike(opts: {
  length: number;
  baseW: number;
  baseD?: number;
  curve?: number;
  segments?: number;
  rings?: number;
  round?: number;
  taper?: number;
  twist?: number;
}): THREE.BufferGeometry {
  const rings: Ring[] = [];
  const n = opts.rings ?? 6;
  const curve = opts.curve ?? 0.4;
  const taper = opts.taper ?? 2.2;
  const baseD = opts.baseD ?? opts.baseW;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const shrink = Math.pow(1 - t, taper) + 0.02;
    rings.push({
      y: opts.length * t,
      z: curve * opts.length * t * t,
      w: opts.baseW * shrink,
      d: baseD * shrink,
      round: opts.round ?? 3,
      twist: (opts.twist ?? 0) * t,
    });
  }
  return loft(rings, { segments: opts.segments ?? 8, smoothAngle: 60 });
}

/**
 * A blade: flat in Z, wide in X, with a lens cross-section and an optional
 * curve. Oversized weapons are half the silhouette read at RTS distance.
 */
export function blade(opts: {
  length: number;
  width: number;
  thickness: number;
  /** 0 = straight, 1 = heavily curved cleaver. */
  curve?: number;
  /** Widest point along the blade, 0..1. */
  belly?: number;
  /** Fraction of the width remaining at the tip. */
  tip?: number;
  /** Extra width at the base, for cleavers. */
  heel?: number;
}): THREE.BufferGeometry {
  const curve = opts.curve ?? 0;
  const belly = opts.belly ?? 0.55;
  const tip = opts.tip ?? 0.08;
  const heel = opts.heel ?? 0.7;
  const widthAt = (v: number): number => {
    const shape =
      v < belly
        ? heel + (1 - heel) * (v / belly)
        : 1 + (tip - 1) * Math.pow((v - belly) / (1 - belly), 1.6);
    return opts.width * shape;
  };
  return shell({
    nu: 6,
    nv: 14,
    surface: (u, v, out) => {
      const w = widthAt(v);
      // Edge on -X, spine on +X, so the profile reads as a cutting edge.
      out.set(-w * 0.5 + u * w, opts.length * v, curve * opts.length * v * v * 0.5);
    },
    thickness: (u, v) => {
      const spine = Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.72 + 0.14)), 1.1);
      return opts.thickness * spine * (1 - 0.55 * v);
    },
    uvScale: 1.4,
    smoothAngle: 34,
  });
}

/** Curved armour plate: pauldron, shield face, breastplate, tasset. */
export function plate(opts: {
  width: number;
  height: number;
  thickness: number;
  /** Bulge toward +Z across the width. */
  bow?: number;
  /** Bulge toward +Z along the height. */
  arch?: number;
  /** Width multiplier at the top and the bottom. */
  topScale?: number;
  bottomScale?: number;
  /** Sweeps the plate downward at the edges, like a shoulder cop. */
  droop?: number;
  nu?: number;
  nv?: number;
  uvScale?: number;
  smoothAngle?: number;
}): THREE.BufferGeometry {
  const bow = opts.bow ?? 0.25;
  const arch = opts.arch ?? 0;
  const top = opts.topScale ?? 1;
  const bottom = opts.bottomScale ?? 1;
  const droop = opts.droop ?? 0;
  return shell({
    nu: opts.nu ?? 10,
    nv: opts.nv ?? 8,
    surface: (u, v, out) => {
      const s = bottom + (top - bottom) * v;
      const x = (u - 0.5) * opts.width * s;
      const k = (u - 0.5) * 2;
      out.set(
        x,
        opts.height * v - droop * k * k * opts.height,
        bow * opts.width * (1 - k * k) + arch * opts.height * (1 - Math.pow(2 * v - 1, 2)),
      );
    },
    thickness: () => opts.thickness,
    uvScale: opts.uvScale ?? 1,
    smoothAngle: opts.smoothAngle ?? 38,
  });
}

/** Lathe profile helper: takes [radius, height] pairs and revolves them. */
export function lathe(points: [number, number][], segments = 14): THREE.BufferGeometry {
  const pts = points.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y));
  const geo = new THREE.LatheGeometry(pts, segments);
  return finishNormals(geo, 50);
}

/** Faceted gem / orb. Reads as a crystal rather than a sphere at distance. */
export function gem(radius: number, detail = 0): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  applySphericalUv(geo);
  return finishNormals(geo, 15);
}

export function sphereish(radius: number, wSeg = 12, hSeg = 9, squashY = 1): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, wSeg, hSeg);
  geo.scale(1, squashY, 1);
  return finishNormals(geo, 60);
}

export function torus(radius: number, tube: number, radialSeg = 8, tubularSeg = 20): THREE.BufferGeometry {
  return finishNormals(new THREE.TorusGeometry(radius, tube, radialSeg, tubularSeg), 60);
}

function applySphericalUv(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos as THREE.BufferAttribute, i).normalize();
    uv[i * 2] = Math.atan2(v.z, v.x) / TAU + 0.5;
    uv[i * 2 + 1] = Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)) / Math.PI + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Deforms a geometry with low-frequency value noise. Breaks the "primitive
 * soup" read: every surface gets a hand-carved wobble instead of a perfect
 * machine curve.
 */
export function roughen(geo: THREE.BufferGeometry, amount: number, frequency = 3.2, seed = 1): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const h = hash3(v.x * frequency + seed, v.y * frequency + seed * 1.7, v.z * frequency + seed * 2.3);
    if (nrm) {
      n.fromBufferAttribute(nrm, i);
      v.addScaledVector(n, h * amount);
    } else {
      v.multiplyScalar(1 + h * amount);
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  return geo;
}

function hash3(x: number, y: number, z: number): number {
  // Smooth value noise from three sinusoid octaves; deterministic, cheap, and
  // only ever runs at build time.
  let s = 0;
  let amp = 1;
  let f = 1;
  for (let o = 0; o < 3; o++) {
    s += amp * Math.sin(x * f * 1.7 + Math.cos(y * f * 1.3) * 2.1 + z * f * 0.9);
    amp *= 0.5;
    f *= 2.07;
  }
  return s * 0.5;
}
