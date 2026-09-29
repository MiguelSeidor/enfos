/**
 * Strips a GLB down to a named set of animation clips.
 *
 * KayKit ships each character with 76 clips, and the animation data is 1.6 MB
 * of a 3.5 MB file. The game plays seven of them. Shipping the other 69 would
 * put 14 MB of characters in front of a player whose entire landing page is
 * currently 1.2 MB, which is not a trade worth making for animations nothing
 * ever triggers.
 *
 * This does the surgery directly on the glTF JSON rather than going through a
 * loader and an exporter: the operation is only "drop some animations, then
 * drop whatever is now unreferenced", and a round trip through three.js would
 * rebuild buffers, rename nodes and risk changing the skeleton the clips are
 * authored against.
 *
 *   node tools/glb-keep-clips.mjs in.glb out.glb Idle Walking_A Running_A ...
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inFile, outFile, ...keep] = process.argv;
if (!inFile || !outFile || keep.length === 0) {
  console.error('usage: glb-keep-clips.mjs <in.glb> <out.glb> <clip> [clip...]');
  process.exit(1);
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${inFile} is not a GLB`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin: bin ?? Buffer.alloc(0) };
}

/** 4-byte alignment is required for the BIN chunk and for every bufferView. */
const pad4 = (n) => (n + 3) & ~3;

function rewrite(json, bin) {
  const wanted = new Set(keep);
  const found = new Set();
  const animations = (json.animations ?? []).filter((a) => {
    if (!wanted.has(a.name)) return false;
    found.add(a.name);
    return true;
  });
  for (const name of wanted) {
    if (!found.has(name)) console.warn(`  ! clip not in file, skipped: ${name}`);
  }
  json.animations = animations;

  // Everything that can still reach an accessor after the cut.
  const liveAccessors = new Set();
  const use = (i) => { if (i !== undefined && i !== null) liveAccessors.add(i); };
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const key of Object.keys(prim.attributes ?? {})) use(prim.attributes[key]);
      use(prim.indices);
      for (const target of prim.targets ?? []) for (const k of Object.keys(target)) use(target[k]);
    }
  }
  for (const skin of json.skins ?? []) use(skin.inverseBindMatrices);
  for (const anim of animations) {
    for (const s of anim.samplers ?? []) { use(s.input); use(s.output); }
  }

  // Accessors keep their order; only the dead ones go, so the remap is dense.
  const accessorMap = new Map();
  const accessors = [];
  (json.accessors ?? []).forEach((a, i) => {
    if (!liveAccessors.has(i)) return;
    accessorMap.set(i, accessors.length);
    accessors.push(a);
  });

  // Surviving bufferViews: those an accessor still points at, plus those an
  // image points at. Images matter because the texture atlas lives in the BIN
  // chunk and nothing in the accessor graph mentions it.
  const liveViews = new Set();
  for (const a of accessors) {
    if (a.bufferView !== undefined) liveViews.add(a.bufferView);
    if (a.sparse) {
      liveViews.add(a.sparse.indices.bufferView);
      liveViews.add(a.sparse.values.bufferView);
    }
  }
  for (const image of json.images ?? []) if (image.bufferView !== undefined) liveViews.add(image.bufferView);

  const viewMap = new Map();
  const views = [];
  const chunks = [];
  let cursor = 0;
  (json.bufferViews ?? []).forEach((v, i) => {
    if (!liveViews.has(i)) return;
    const start = v.byteOffset ?? 0;
    const slice = bin.subarray(start, start + v.byteLength);
    const next = { ...v, byteOffset: cursor, buffer: 0 };
    viewMap.set(i, views.length);
    views.push(next);
    chunks.push(slice);
    cursor = pad4(cursor + v.byteLength);
    if (cursor > chunks.reduce((n, c) => n + c.length, 0)) {
      chunks.push(Buffer.alloc(cursor - chunks.reduce((n, c) => n + c.length, 0)));
    }
  });

  const remapView = (i) => (i === undefined ? undefined : viewMap.get(i));
  for (const a of accessors) {
    if (a.bufferView !== undefined) a.bufferView = remapView(a.bufferView);
    if (a.sparse) {
      a.sparse.indices.bufferView = remapView(a.sparse.indices.bufferView);
      a.sparse.values.bufferView = remapView(a.sparse.values.bufferView);
    }
  }
  for (const image of json.images ?? []) {
    if (image.bufferView !== undefined) image.bufferView = remapView(image.bufferView);
  }
  const remapAccessor = (i) => (i === undefined ? undefined : accessorMap.get(i));
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const key of Object.keys(prim.attributes ?? {})) {
        prim.attributes[key] = remapAccessor(prim.attributes[key]);
      }
      if (prim.indices !== undefined) prim.indices = remapAccessor(prim.indices);
      for (const target of prim.targets ?? []) {
        for (const k of Object.keys(target)) target[k] = remapAccessor(target[k]);
      }
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) {
      skin.inverseBindMatrices = remapAccessor(skin.inverseBindMatrices);
    }
  }
  for (const anim of animations) {
    for (const s of anim.samplers ?? []) {
      s.input = remapAccessor(s.input);
      s.output = remapAccessor(s.output);
    }
  }

  json.accessors = accessors;
  json.bufferViews = views;
  const newBin = Buffer.concat(chunks, cursor);
  json.buffers = [{ byteLength: newBin.length }];
  return { json, bin: newBin };
}

function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20); // spaces
  const binPad = Buffer.alloc(pad4(bin.length) - bin.length, 0);
  const jsonLen = jsonBuf.length + jsonPad.length;
  const binLen = bin.length + binPad.length;
  const total = 12 + 8 + jsonLen + (binLen ? 8 + binLen : 0);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonLen, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);

  const parts = [header, jsonHeader, jsonBuf, jsonPad];
  if (binLen) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binLen, 0);
    binHeader.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(binHeader, bin, binPad);
  }
  return Buffer.concat(parts, total);
}

const before = readFileSync(inFile);
const parsed = readGlb(before);
const { json, bin } = rewrite(parsed.json, parsed.bin);
const out = writeGlb(json, bin);
writeFileSync(outFile, out);

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(
  `${inFile.split(/[\\/]/).pop()} -> ${outFile.split(/[\\/]/).pop()}  ` +
    `${kb(before.length)} -> ${kb(out.length)}  (${json.animations.length} clips kept)`,
);
