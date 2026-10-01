/**
 * Prepares a generated mesh for use as a rigid character part.
 *
 * TRELLIS hands back roughly 95,000 triangles and 3 MB for one head. The game
 * draws that head 15 pixels tall, and creeps are baked into a vertex animation
 * texture that stores every vertex for every frame, so the part costs memory
 * per frame even though it never deforms. Shipping the raw mesh is not an
 * option; this is the step between the generator and `public/models/parts/`.
 *
 * Three things happen here, in this order for a reason.
 *
 * 1. **Trim.** A single-view reconstruction invents whatever it could not see.
 *    On a head cropped at the shoulders that shows up as a hollow flared collar
 *    behind the jaw, and as a featureless slab where the back of the skull
 *    should be. Cutting the collar BEFORE simplifying matters: the simplifier
 *    spends its triangle budget on whatever is present, and half of it would go
 *    on geometry about to be deleted.
 *
 * 2. **Simplify**, with meshoptimizer rather than a naive collapse. At a 190:1
 *    reduction the difference is whether the tusks and ears survive.
 *
 * 3. **Strip.** Materials and textures go. A part is merged into the character
 *    and takes one of its material slots, so the faction colour law and the
 *    procedural skin apply to it; the generated texture would never be sampled
 *    and is pure payload.
 *
 *   node tools/glb-part-prepare.mjs in.glb out.glb [--tris=800]
 *     [--rot=x,y,z] [--keep=minX,maxX,minY,maxY,minZ,maxZ]
 *
 * `--keep` is in the model's own units, after centring and after `--rot`, and
 * any bound may be omitted with `_`. Run once with neither and read the printed
 * bounds first.
 *
 * `--rot` (XYZ Euler, radians) runs before the cut, which is what makes a limb
 * usable: TRELLIS returns arms angled out from a body, and an axis-aligned box
 * cannot separate an angled arm at the elbow. Stand it upright first and the
 * cut is one horizontal plane.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const [inFile, outFile] = args.filter((a) => !a.startsWith('--'));
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const targetTris = Number(flag('tris') ?? 800);
const keepSpec = flag('keep');

if (!inFile || !outFile) {
  console.error('usage: glb-part-prepare.mjs <in.glb> <out.glb> [--tris=N] [--keep=minY,maxY,minZ,maxZ]');
  process.exit(1);
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const pad4 = (n) => (n + 3) & ~3;

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${inFile} is not a GLB`);
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

const COMPONENT = {
  5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2],
  5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Reads one accessor out, honouring a bufferView's byteStride. */
function readAccessor(json, bin, index) {
  const a = json.accessors[index];
  const [Type, bytes] = COMPONENT[a.componentType];
  const n = COMPONENTS_PER[a.type];
  const out = new Type(a.count * n);
  if (a.bufferView === undefined) return out;
  const view = json.bufferViews[a.bufferView];
  const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = view.byteStride ?? n * bytes;
  for (let i = 0; i < a.count; i++) {
    const at = base + i * stride;
    for (let c = 0; c < n; c++) {
      const o = at + c * bytes;
      out[i * n + c] =
        Type === Float32Array ? bin.readFloatLE(o)
        : Type === Uint32Array ? bin.readUInt32LE(o)
        : Type === Uint16Array ? bin.readUInt16LE(o)
        : Type === Int16Array ? bin.readInt16LE(o)
        : Type === Uint8Array ? bin.readUInt8(o)
        : bin.readInt8(o);
    }
  }
  return out;
}

/** Node world matrices, so a mesh parented under a transform is not misplaced. */
function worldMatrices(json) {
  const out = new Map();
  const mul = (a, b) => {
    const r = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let rI = 0; rI < 4; rI++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rI] * b[c * 4 + k];
      r[c * 4 + rI] = s;
    }
    return r;
  };
  const local = (node) => {
    if (node.matrix) return Float64Array.from(node.matrix);
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return Float64Array.from([
      (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
      (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
      (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
      tx, ty, tz, 1,
    ]);
  };
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const m = mul(parent, local(node));
    out.set(index, m);
    for (const child of node.children ?? []) walk(child, m);
  };
  const identity = Float64Array.from([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? json.nodes.map((_, i) => i)) walk(root, identity);
  return out;
}

const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

// ── Gather every primitive into one indexed mesh ────────────────────────────
const source = readFileSync(inFile);
const { json, bin } = readGlb(source);
const mats = worldMatrices(json);

const positions = [];
const uvs = [];
const indices = [];
for (const [nodeIndex, node] of json.nodes.entries()) {
  if (node.mesh === undefined) continue;
  const m = mats.get(nodeIndex);
  for (const prim of json.meshes[node.mesh].primitives) {
    if (prim.attributes.POSITION === undefined) continue;
    const pos = readAccessor(json, bin, prim.attributes.POSITION);
    const uv = prim.attributes.TEXCOORD_0 !== undefined
      ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null;
    const idx = prim.indices !== undefined
      ? readAccessor(json, bin, prim.indices)
      : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
    const base = positions.length / 3;
    for (let i = 0; i < pos.length / 3; i++) {
      const [x, y, z] = apply(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      positions.push(x, y, z);
      uvs.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
    }
    for (let i = 0; i < idx.length; i++) indices.push(base + idx[i]);
  }
}
if (positions.length === 0) throw new Error('no mesh data in the file');

// Centre on the bounding box: the part is placed by the recipe relative to a
// bone, so an arbitrary authoring origin is noise.
let min = [Infinity, Infinity, Infinity];
let max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3) {
  for (let c = 0; c < 3; c++) {
    if (positions[i + c] < min[c]) min[c] = positions[i + c];
    if (positions[i + c] > max[c]) max[c] = positions[i + c];
  }
}
const centre = [0, 1, 2].map((c) => (min[c] + max[c]) / 2);
for (let i = 0; i < positions.length; i += 3) for (let c = 0; c < 3; c++) positions[i + c] -= centre[c];

// Optional reorientation, before anything measures or cuts. Applied here so the
// printed bounds and the --keep box are both in the rotated frame, which is the
// only frame a person can reason about when aiming a cut.
const rotSpec = flag('rot');
if (rotSpec) {
  const [rx, ry, rz] = rotSpec.split(',').map(Number);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  for (let i = 0; i < positions.length; i += 3) {
    let x = positions[i], y = positions[i + 1], z = positions[i + 2];
    // XYZ order, matching three's default Euler so a value found here can be
    // moved into a manifest entry unchanged.
    let ty = y * cx - z * sx; let tz = y * sx + z * cx; y = ty; z = tz;
    let tx = x * cy + z * sy; tz = -x * sy + z * cy; x = tx; z = tz;
    tx = x * cz - y * sz; ty = x * sz + y * cz; x = tx; y = ty;
    positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
  }
  // Re-measure: the box that mattered before the turn is not the box now.
  min = [Infinity, Infinity, Infinity];
  max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (positions[i + c] < min[c]) min[c] = positions[i + c];
      if (positions[i + c] > max[c]) max[c] = positions[i + c];
    }
  }
  centre[0] = centre[1] = centre[2] = 0;
}

// Weld co-located vertices before anything else. A generated mesh splits
// vertices along every UV seam, so 95,170 triangles arrive carrying 58,513
// vertices where a closed surface needs about 47,600. Those duplicates are
// invisible but they are distinct indices, and an edge collapse cannot cross
// one -- which is why simplification plateaus at three times the budget no
// matter how loose the error bound is. The UVs lost in the merge do not matter
// here: the part takes a material slot and its own texture is discarded.
{
  const map = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const welded = [];
  const weldedUv = [];
  const q = 1e5; // 10 micrometres at this scale, well below anything visible
  for (let i = 0; i < positions.length / 3; i++) {
    const key =
      `${Math.round(positions[i * 3] * q)},` +
      `${Math.round(positions[i * 3 + 1] * q)},` +
      `${Math.round(positions[i * 3 + 2] * q)}`;
    let at = map.get(key);
    if (at === undefined) {
      at = welded.length / 3;
      map.set(key, at);
      welded.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      weldedUv.push(uvs[i * 2], uvs[i * 2 + 1]);
    }
    remap[i] = at;
  }
  const before = positions.length / 3;
  // Copied element by element rather than by spread: these arrays hold hundreds
  // of thousands of entries and a spread that wide overflows the call stack.
  positions.length = welded.length;
  for (let i = 0; i < welded.length; i++) positions[i] = welded[i];
  uvs.length = weldedUv.length;
  for (let i = 0; i < weldedUv.length; i++) uvs[i] = weldedUv[i];
  for (let i = 0; i < indices.length; i++) indices[i] = remap[indices[i]];
  console.log(`weld ${before} -> ${positions.length / 3} verts`);
}

const fmt = (n) => n.toFixed(3);
console.log(`in   ${indices.length / 3} tris, ${positions.length / 3} verts`);
console.log(`bounds after centring  x ${fmt(min[0] - centre[0])}..${fmt(max[0] - centre[0])}` +
  `  y ${fmt(min[1] - centre[1])}..${fmt(max[1] - centre[1])}` +
  `  z ${fmt(min[2] - centre[2])}..${fmt(max[2] - centre[2])}`);

// ── Trim, applied AFTER simplification ──────────────────────────────────────
//
// Order matters more than it looks. Trimming first leaves an open boundary, and
// simplifying across an open boundary lets border vertices slide along the hole
// until the cut is a fringe of long thin spikes. Locking the border instead
// spends the whole budget on the boundary loop and hands back a featureless
// shell. Simplifying the closed mesh first avoids both: there is no border to
// mishandle, and the cut is made when nothing further will collapse.
//
// The budget is raised by the fraction about to be discarded, so the head still
// lands near the target after the collar goes.
function trim(indexArray) {
  if (!keepSpec) return indexArray;
  const raw = keepSpec.split(',');
  const bound = (i, fallback) => (raw[i] === undefined || raw[i] === '_' ? fallback : Number(raw[i]));
  const keep = {
    minX: bound(0, -Infinity), maxX: bound(1, Infinity),
    minY: bound(2, -Infinity), maxY: bound(3, Infinity),
    minZ: bound(4, -Infinity), maxZ: bound(5, Infinity),
  };
  const kept = [];
  for (let t = 0; t < indexArray.length; t += 3) {
    // By centroid, so a triangle straddling the cut goes whole rather than
    // leaving a ragged half-triangle behind.
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      cx += positions[indexArray[t + k] * 3];
      cy += positions[indexArray[t + k] * 3 + 1];
      cz += positions[indexArray[t + k] * 3 + 2];
    }
    cx /= 3; cy /= 3; cz /= 3;
    if (
      cx >= keep.minX && cx <= keep.maxX &&
      cy >= keep.minY && cy <= keep.maxY &&
      cz >= keep.minZ && cz <= keep.maxZ
    ) {
      kept.push(indexArray[t], indexArray[t + 1], indexArray[t + 2]);
    }
  }
  console.log(`trim ${indexArray.length / 3} -> ${kept.length / 3} tris`);
  return Uint32Array.from(kept);
}

/**
 * Re-centres the surviving triangles on their own bounding box.
 *
 * Centring happens before the cut, on the whole mesh, because the cut box has
 * to be expressed in some frame a person can read off the printed bounds. But
 * that leaves every piece carrying the WHOLE mesh's origin: a thigh cut from
 * y -0.25..0.05 sits a quarter of a unit below wherever you place it. Pieces
 * are far easier to place by their middle, so this moves the origin there and
 * reports the shift, which is also the offset from the original pivot if a
 * recipe ever needs it back.
 */
function recentre(indexArray) {
  // Mutates `posArray`, NOT `positions`. The simplifier works on a Float32Array
  // copy taken before the trim, and the writer reads that copy back; shifting
  // the original array instead is a silent no-op that prints a convincing
  // number and changes nothing in the file.
  const used = new Set(indexArray);
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const v of used) {
    for (let c = 0; c < 3; c++) {
      const value = posArray[v * 3 + c];
      if (value < lo[c]) lo[c] = value;
      if (value > hi[c]) hi[c] = value;
    }
  }
  const shift = [0, 1, 2].map((c) => (lo[c] + hi[c]) / 2);
  for (const v of used) for (let c = 0; c < 3; c++) posArray[v * 3 + c] -= shift[c];
  console.log(`recentre by ${shift.map((n) => n.toFixed(3)).join(', ')}`);
}

/** Share of the mesh the trim will take, so the budget can be raised to match. */
function survivingFraction() {
  if (!keepSpec) return 1;
  return trim(Uint32Array.from(indices)).length / indices.length;
}

// ── Simplify ────────────────────────────────────────────────────────────────
await MeshoptSimplifier.ready;
// `Prune` is gated behind this flag. It drops disconnected components too small
// to matter, which a single-view reconstruction always leaves lying around:
// stray shells behind the ears, a floating fleck where the background met the
// silhouette. Without it the simplifier spends budget keeping them.
MeshoptSimplifier.useExperimentalFeatures = true;
const posArray = Float32Array.from(positions);
// The error bound, not the triangle target, is usually what stops the collapse:
// at a tight bound the simplifier hands back ten times the budget, which is
// correct behaviour for preserving a surface and useless for a part that has to
// fit inside a VAT bake. So it is raised until the target bites, and the result
// is judged by looking at it rather than by this number.
//
// `Prune` is NOT used with a permissive bound. It drops components it considers
// too small to matter, and once the bound is loose enough to reach the target it
// decides the whole head qualifies and returns an empty mesh.
//
// It also runs to a fixed point rather than once. A generated mesh is not one
// clean surface: it carries internal shells and non-manifold seams that block
// edge collapses, so a single pass plateaus well above the target however loose
// the bound is. Re-feeding its own output lets the next pass collapse what the
// previous one just made collapsible.
//
// `LockBorder` is deliberately NOT used. It was tried: on a trimmed head it
// spends the entire budget holding the boundary loop and returns a featureless
// shell with no face left. Simplifying before the trim is what makes it
// unnecessary.
const bound = Number(flag('error') ?? 0.25);
// Clamped to what the mesh actually has: the budget is inflated by the share
// the trim is about to remove, and asking for more triangles than exist is an
// assertion failure inside the simplifier rather than a no-op.
// The index count must stay a multiple of three, so the rounding happens on
// triangles and the multiply comes after.
const budget = Math.min(
  Math.ceil(targetTris / survivingFraction()) * 3,
  Math.floor(indices.length / 3) * 3,
);
let working = Uint32Array.from(indices);
let error = 0;
for (let pass = 0; pass < 8; pass++) {
  const [next, err] = MeshoptSimplifier.simplify(working, posArray, 3, budget, bound);
  error = err;
  if (next.length === 0 || next.length >= working.length) break;
  working = next;
  if (working.length <= budget) break;
}
console.log(`simplify -> ${working.length / 3} tris (error ${(error * 100).toFixed(2)}%)`);
const simplified = trim(working);
// Trimmed pieces are re-centred by default: a piece is placed by its middle in
// every recipe, and leaving it on the whole mesh's origin makes every offset a
// puzzle. --no-recentre keeps the original pivot.
if (keepSpec && !args.includes('--no-recentre')) recentre(simplified);

// Compact: drop vertices the simplifier no longer references.
const used = new Map();
const outPos = [];
const outUv = [];
const outIdx = new Uint32Array(simplified.length);
for (let i = 0; i < simplified.length; i++) {
  const v = simplified[i];
  let n = used.get(v);
  if (n === undefined) {
    n = outPos.length / 3;
    used.set(v, n);
    outPos.push(posArray[v * 3], posArray[v * 3 + 1], posArray[v * 3 + 2]);
    outUv.push(uvs[v * 2], uvs[v * 2 + 1]);
  }
  outIdx[i] = n;
}

// Normals from the simplified surface, not carried over: a collapsed mesh's
// inherited normals describe edges that no longer exist and read as dents.
const outNrm = new Float32Array(outPos.length);
for (let t = 0; t < outIdx.length; t += 3) {
  const [a, b, c] = [outIdx[t], outIdx[t + 1], outIdx[t + 2]];
  const ax = outPos[a * 3], ay = outPos[a * 3 + 1], az = outPos[a * 3 + 2];
  const ux = outPos[b * 3] - ax, uy = outPos[b * 3 + 1] - ay, uz = outPos[b * 3 + 2] - az;
  const vx = outPos[c * 3] - ax, vy = outPos[c * 3 + 1] - ay, vz = outPos[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  for (const i of [a, b, c]) { outNrm[i * 3] += nx; outNrm[i * 3 + 1] += ny; outNrm[i * 3 + 2] += nz; }
}
for (let i = 0; i < outNrm.length; i += 3) {
  const l = Math.hypot(outNrm[i], outNrm[i + 1], outNrm[i + 2]) || 1;
  outNrm[i] /= l; outNrm[i + 1] /= l; outNrm[i + 2] /= l;
}

// ── Write ───────────────────────────────────────────────────────────────────
const buffers = [
  { name: 'POSITION', data: Float32Array.from(outPos), type: 'VEC3', comp: 5126 },
  { name: 'NORMAL', data: outNrm, type: 'VEC3', comp: 5126 },
  { name: 'TEXCOORD_0', data: Float32Array.from(outUv), type: 'VEC2', comp: 5126 },
];
const chunks = [];
const views = [];
const accessors = [];
let cursor = 0;
for (const b of buffers) {
  const bytes = Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength);
  views.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.length });
  const n = b.type === 'VEC3' ? 3 : 2;
  const mn = Array(n).fill(Infinity);
  const mx = Array(n).fill(-Infinity);
  for (let i = 0; i < b.data.length; i++) {
    const c = i % n;
    if (b.data[i] < mn[c]) mn[c] = b.data[i];
    if (b.data[i] > mx[c]) mx[c] = b.data[i];
  }
  accessors.push({ bufferView: views.length - 1, componentType: b.comp, count: b.data.length / n, type: b.type, min: mn, max: mx });
  chunks.push(bytes, Buffer.alloc(pad4(bytes.length) - bytes.length));
  cursor = pad4(cursor + bytes.length);
}
const idxBytes = Buffer.from(outIdx.buffer, outIdx.byteOffset, outIdx.byteLength);
views.push({ buffer: 0, byteOffset: cursor, byteLength: idxBytes.length });
accessors.push({ bufferView: views.length - 1, componentType: 5125, count: outIdx.length, type: 'SCALAR' });
chunks.push(idxBytes, Buffer.alloc(pad4(idxBytes.length) - idxBytes.length));
cursor = pad4(cursor + idxBytes.length);

const outBin = Buffer.concat(chunks, cursor);
const outJson = {
  asset: { version: '2.0', generator: 'enfos glb-part-prepare' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: outBin.length }],
};

const jsonBuf = Buffer.from(JSON.stringify(outJson), 'utf8');
const jsonPad = Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20);
const header = Buffer.alloc(12);
header.writeUInt32LE(GLB_MAGIC, 0); header.writeUInt32LE(2, 4);
const jsonLen = jsonBuf.length + jsonPad.length;
header.writeUInt32LE(12 + 8 + jsonLen + 8 + outBin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonLen, 0); jh.writeUInt32LE(CHUNK_JSON, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(outBin.length, 0); bh.writeUInt32LE(CHUNK_BIN, 4);
const out = Buffer.concat([header, jh, jsonBuf, jsonPad, bh, outBin]);
writeFileSync(outFile, out);

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`out  ${outIdx.length / 3} tris, ${outPos.length / 3} verts, ${kb(source.length)} -> ${kb(out.length)}`);
