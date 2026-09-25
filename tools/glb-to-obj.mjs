/**
 * Converts a binary glTF into OBJ + MTL + texture, for tools that do not accept
 * glTF — Mixamo being the one that matters here: it takes FBX, OBJ or a ZIP,
 * and rejects `.glb` with a misleading "unable to map your existing skeleton".
 *
 * Usage:
 *   node tools/glb-to-obj.mjs --in public/models/bulwark.glb --out export/bulwark
 *
 * Writes `<out>/model.obj`, `<out>/model.mtl` and any embedded textures. Zip the
 * folder and upload the zip.
 *
 * Node transforms are baked into the vertices. Mixamo reads a flat OBJ with no
 * scene graph, so a mesh whose orientation lives in a parent node would arrive
 * lying on its side.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.in || !args.out) {
  console.error('usage: node tools/glb-to-obj.mjs --in <file.glb> --out <folder>');
  process.exit(1);
}

const COMPONENT = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

const raw = await readFile(path.resolve(args.in));
if (raw.readUInt32LE(0) !== 0x46546c67) {
  console.error('not a GLB (bad magic)');
  process.exit(1);
}

const jsonLength = raw.readUInt32LE(12);
const json = JSON.parse(raw.subarray(20, 20 + jsonLength).toString('utf8'));
// The BIN chunk follows the JSON chunk, both 4-byte aligned.
const binStart = 20 + jsonLength + 8;
const bin = raw.subarray(binStart);

const outDir = path.resolve(args.out);
await mkdir(outDir, { recursive: true });

function readAccessor(index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const comp = COMPONENT[acc.componentType];
  const per = TYPE_COUNT[acc.type];
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new Array(acc.count * per);

  // byteStride only applies to vertex attributes; when absent the data is tight.
  const stride = view.byteStride ?? comp.size * per;
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    for (let c = 0; c < per; c++) {
      const o = at + c * comp.size;
      out[i * per + c] =
        comp.array === Float32Array
          ? bin.readFloatLE(o)
          : comp.array === Uint32Array
            ? bin.readUInt32LE(o)
            : comp.array === Uint16Array
              ? bin.readUInt16LE(o)
              : comp.array === Int16Array
                ? bin.readInt16LE(o)
                : comp.array === Int8Array
                  ? bin.readInt8(o)
                  : bin.readUInt8(o);
    }
  }
  return out;
}

/** Column-major 4x4 multiply, matching glTF's matrix convention. */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function applyPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

const positions = [];
const normals = [];
const uvs = [];
const faces = [];
let vertexBase = 1; // OBJ indices are 1-based

const scene = json.scenes?.[json.scene ?? 0];
const stack = (scene?.nodes ?? json.nodes.map((_, i) => i)).map((i) => ({
  index: i,
  parent: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
}));

while (stack.length > 0) {
  const { index, parent } = stack.pop();
  const node = json.nodes[index];
  const world = multiply(parent, nodeMatrix(node));

  for (const child of node.children ?? []) stack.push({ index: child, parent: world });
  if (node.mesh === undefined) continue;

  for (const prim of json.meshes[node.mesh].primitives ?? []) {
    const pos = readAccessor(prim.attributes.POSITION);
    const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
    const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;
    const idx = prim.indices !== undefined ? readAccessor(prim.indices) : null;
    const count = pos.length / 3;

    for (let i = 0; i < count; i++) {
      const [x, y, z] = applyPoint(world, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      positions.push(`v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`);
      if (nrm) {
        // Normals ignore translation; for uniform scale the rotation part is enough.
        const nx = world[0] * nrm[i * 3] + world[4] * nrm[i * 3 + 1] + world[8] * nrm[i * 3 + 2];
        const ny = world[1] * nrm[i * 3] + world[5] * nrm[i * 3 + 1] + world[9] * nrm[i * 3 + 2];
        const nz = world[2] * nrm[i * 3] + world[6] * nrm[i * 3 + 1] + world[10] * nrm[i * 3 + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        normals.push(`vn ${(nx / len).toFixed(6)} ${(ny / len).toFixed(6)} ${(nz / len).toFixed(6)}`);
      }
      // OBJ's V axis runs opposite to glTF's.
      if (uv) uvs.push(`vt ${uv[i * 2].toFixed(6)} ${(1 - uv[i * 2 + 1]).toFixed(6)}`);
    }

    const indices = idx ?? Array.from({ length: count }, (_, i) => i);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] + vertexBase;
      const b = indices[i + 1] + vertexBase;
      const c = indices[i + 2] + vertexBase;
      const f = (v) => (uv && nrm ? `${v}/${v}/${v}` : uv ? `${v}/${v}` : nrm ? `${v}//${v}` : `${v}`);
      faces.push(`f ${f(a)} ${f(b)} ${f(c)}`);
    }
    vertexBase += count;
  }
}

// Embedded textures, written out beside the OBJ so the MTL can reference them.
const written = [];
for (const [i, image] of (json.images ?? []).entries()) {
  if (image.bufferView === undefined) continue;
  const view = json.bufferViews[image.bufferView];
  const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const name = `texture_${i}.${ext}`;
  await writeFile(path.join(outDir, name), data);
  written.push(name);
}

const mtl = [
  'newmtl material_0',
  'Ka 1.000 1.000 1.000',
  'Kd 1.000 1.000 1.000',
  'Ks 0.000 0.000 0.000',
  'd 1.0',
  'illum 2',
  written[0] ? `map_Kd ${written[0]}` : '',
].filter(Boolean);

await writeFile(path.join(outDir, 'model.mtl'), mtl.join('\n') + '\n');
await writeFile(
  path.join(outDir, 'model.obj'),
  ['mtllib model.mtl', 'usemtl material_0', ...positions, ...uvs, ...normals, ...faces].join('\n') + '\n',
);

console.log(`wrote ${outDir}`);
console.log(`  model.obj — ${positions.length} vertices, ${faces.length} triangles`);
console.log(`  model.mtl${written.length ? ` + ${written.join(', ')}` : ' (no embedded textures)'}`);
console.log('');
console.log('Zip the folder and upload the ZIP to Mixamo (it accepts FBX, OBJ or ZIP — not GLB).');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = 'true';
  }
  return out;
}
