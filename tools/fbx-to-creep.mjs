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
/**
 * Every creature this converter knows how to build.
 *
 * `base` and the clip files are names inside public/_src; `atlas` says which
 * texture belongs to which material and where it lands, so a character with a
 * single material gets a single image and one with several gets them packed
 * side by side. `budget` is triangles per material after decimation.
 */
const CHARACTERS = {
  orc: {
    out: 'public/models/orc.glb',
    base: 'base.fbx',
    atlas: {
      width: 2048,
      height: 1024,
      parts: [
        { material: 'lambert1', file: 'ork.tga', x: 0, y: 0, w: 1024, h: 1024 },
        { material: 'lambert2', file: 'axe.tga', x: 1024, y: 0, w: 512, h: 512 },
      ],
    },
    budget: { lambert1: 2600, lambert2: 1000 },
    // Named so the conversion fails loudly if the axes ever stop surviving it
    // again, checked against the FINAL skeleton rather than the numbering
    // before the bone reduction renumbers every slot.
    verifyBones: ['ork_right_axe_1', 'ork_left_axe_1'],
    clips: {
    idle: { file: 'ork@idle1.fbx', trim: 'loop' },
    walk: { file: 'ork@walk.fbx', trim: 'loop' },
    run: { file: 'ork@run.fbx', trim: 'loop' },
    // atack1 is the spinning attack: the torso turns a full 360 degrees between
    // 0.15 s and 1.07 s and then holds the end pose for the remaining eight
    // seconds. Sampling it once a second makes it look like a character standing
    // with its arms out, which is how it got rejected twice; measuring the yaw
    // is what found it.
    //
    // The window is given by hand because no automatic rule gets it right. The
    // energy peak lands on the arms opening at the end of the spin, and the
    // span rule takes the whole padded file. 0 to 1.2 s is the spin, and it
    // happens to be the 1.18 s a cleaver has between blows.
    // Played at nearly four times the pace it was animated at. The turn is
    // authored for a cutscene -- 1.17 s for a full circle -- and every step down
    // from there still read as a pirouette to the person watching it: 0.80 s was
    // too slow, 0.60 s was too slow. 3.9x puts the whole spin in 0.30 s, which is
    // a whirl rather than a dance.
    //
    // This is the only knob for how fast the SWING looks. How long the orc waits
    // between swings is attackSpeed in gameplay/defs.ts, which is balance. The
    // two are easy to confuse when watching, because a short spin on a slow
    // cadence leaves the orc standing still for most of its cycle.
    attack: { file: 'ork@atack1.fbx', trim: 'window', window: [0, 1.2], speed: 3.9 },
    cast: { file: 'ork@roar.fbx', trim: 'burst' },
    hit: { file: 'ork@gethit.fbx', trim: 'burst' },
    // A death is not a burst: the body falls once and then stays down, so the
    // cut runs from the first movement to the last rather than around a peak.
    death: { file: 'ork@death.fbx', trim: 'span' },

    },
  },

  erika: {
    out: 'public/models/erika.glb',
    base: 'base.fbx',
    // Mixamo embeds its textures in the FBX, so there are no files to name:
    // the converter takes each material's own map and lays them out itself.
    // 1024 across six cells. The body lands at 341x512, which is more than a
    // creature 79 pixels tall can show, and keeps the file near a megabyte.
    atlas: { embedded: true, size: 1024 },
    // Explicit per material, NOT a single number shared out in proportion.
    // Proportional allocation starves exactly what matters: the bow is 400 of
    // 21,004 triangles, so it was given 100, and a long thin object at 100
    // triangles collapses into slivers that lance through the character. The
    // eyelashes, meanwhile, are the densest mesh in the file and invisible at
    // 79 pixels. The bow and arrow keep every triangle they came with.
    budget: {
      Body_MAT1: 1700,   // body and head
      Akai_MAT1: 1000,   // clothing
      Bow_MAT: 400,      // the bow, untouched
      Arrow_MAT: 80,     // the arrow, untouched
      EyeSpec_MAT1: 100, // eyes, invisible at this distance
      phong1: 100,
    },
    clips: {
      idle: { file: 'idle.fbx', trim: 'loop' },
      walk: { file: 'walk.fbx', trim: 'loop' },
      run: { file: 'run.fbx', trim: 'loop' },
      // Five seconds of draw, hold and release. The ballestero shoots every
      // 1.43 s, so the hold has to go: one burst around the release.
      attack: { file: 'attack.fbx', trim: 'burst', maxSeconds: 1.2 },
      cast: { file: 'attack.fbx', trim: 'burst', maxSeconds: 1.2 },
      hit: { file: 'hit.fbx', trim: 'burst' },
      death: { file: 'death.fbx', trim: 'span' },
    },
  },

  crusader: {
    out: 'public/models/crusader.glb',
    base: 'base.fbx',
    // Both materials take the same sheet, which is not a mistake.
    //
    // The pack ships two albedos, `1_body_Albedo` at 4096 and `1_weapon_Albedo`
    // at 2048, and the obvious reading -- body material gets the body sheet,
    // weapon material gets the weapon sheet -- is wrong twice over. There is no
    // weapon material: `lambert2` is the single body mesh and `lambert1` is all
    // 26 loose pieces, the 19 armour plates AND the flail and shield together,
    // so one texture has to serve both. And the sheet that serves them is the
    // body one: rendered against the source, the pauldrons, knee cops, belt and
    // boots are right with it and grey smears without it, and the tabard, mail
    // and heraldry only resolve with it on the body mesh too.
    //
    // The weapon sheet holds the shield face and the flail head, and nothing in
    // the base mesh's materials references it; it belongs to the separate
    // weapon prefab in the Unity folder. The cost is that the flail handle,
    // 48 triangles, samples the body sheet and reads a little off up close.
    // At 79 pixels it does not show. Splitting that material would be the fix
    // if it ever does.
    //
    // Decide this by rendering, never by the filename, and beware of the trap
    // that cost an hour here: a comparison script that swaps materials in place
    // destroys the names it is keying on, so the second render silently paints
    // everything with one texture and looks like a clean result.
    atlas: {
      width: 2048,
      height: 1024,
      parts: [
        // `lambert1` and `lambert2` share a cell on purpose: they are different
        // materials that use the same sheet, each with its own 0..1 UVs, so one
        // copy of the body texture serves both.
        { material: 'lambert2', file: 'body.tga', x: 0, y: 0, w: 1024, h: 1024 },
        { material: 'lambert1', file: 'body.tga', x: 0, y: 0, w: 1024, h: 1024 },
        { material: 'weapon', file: 'weapon.tga', x: 1024, y: 0, w: 1024, h: 1024 },
      ],
    },
    // Taken from the pack's own prefab rather than guessed: seven renderers
    // carry the blunt material and they are exactly weapon1 through weapon7.
    materialByMesh: [{ test: '^weapon', material: 'weapon' }],
    // Generous on lambert1 on purpose: it carries the chain, and a chain is the
    // shape decimation destroys first. 4,863 down to 3,200 is a 34% cut rather
    // than the half it would take to hit the usual budget, and the flail is the
    // whole reason this creature reads as a flail.
    // The flail and shield now have a budget of their own, which is what the
    // chain needed: it is the shape decimation destroys first, and sharing a
    // number with nineteen armour plates hid that.
    budget: { lambert1: 2100, lambert2: 1100, weapon: 1100 },
    // The flail is a bone chain: ball, twelve links and a handle. Bone
    // reduction has already eaten a weapon on this project twice, so name the
    // pieces and let the conversion fail loudly instead of shipping a knight
    // swinging at nothing.
    verifyBones: ['ball_on_a_club1', 'stick_of_a_club1', 'chain1', 'chain12', 'shield1'],
    clips: {
      idle: { file: 'crusadershield@idle1.fbx', trim: 'loop' },
      walk: { file: 'crusadershield@walk.fbx', trim: 'loop' },
      run: { file: 'crusadershield@run.fbx', trim: 'loop' },
      // Measured rather than guessed. Every file in this pack declares 8.33 s
      // or 14.17 s and then holds its last pose: tracking the flail head
      // through atack1 puts the swing between 1.27 s and 3.23 s with the peak
      // at 2.03 s, and nothing moves on either side of that.
      //
      // 3.5x puts the 2.1 s window into 0.6 s. Slower than the orc's 0.30 s
      // spin on purpose -- this is a weighted head on a chain, and a flail that
      // snaps reads as a stick. The Rompehuesos swings every 1.67 s, so 0.6 s
      // of swing leaves the blow legible with the recovery still visible.
      attack: { file: 'crusadershield@atack1.fbx', trim: 'window', window: [1.2, 3.3], speed: 3.5 },
      // Both measured off the hips rather than left to the automatic rules,
      // which this pack defeats. The flinch runs the full 2.47 s, which is a
      // stagger and not a reaction, so it is capped at a beat. The fall takes
      // 0.13 s to 4.13 s and then lies still; `span` read the stillness as
      // motion and kept 11.69 s of corpse.
      hit: { file: 'crusadershield@gethit.fbx', trim: 'burst', maxSeconds: 0.9 },
      death: { file: 'crusadershield@death.fbx', trim: 'window', window: [0.1, 4.2] },
    },
  },

  mutant: {
    out: 'public/models/mutant.glb',
    base: 'base_mesh.fbx',
    // One material over the whole creature and UVs inside 0..1, so the atlas is
    // just the texture.
    atlas: {
      width: 1024,
      height: 1024,
      parts: [{ material: 'blinn1', file: 'mutant.png', x: 0, y: 0, w: 1024, h: 1024 }],
    },
    budget: { blinn1: 3400 },
    clips: {
      idle: { file: 'mutant01@idle01.fbx', trim: 'loop' },
      walk: { file: 'mutant01@walk.fbx', trim: 'loop' },
      run: { file: 'mutant01@Run01.fbx', trim: 'loop' },
      // attack02 over attack01: half the length for the same lunge.
      attack: { file: 'mutant01@attack02.fbx', trim: 'burst', maxSeconds: 1.1 },
      cast: { file: 'mutant01@Rage_01.fbx', trim: 'burst', maxSeconds: 1.4 },
      // gethit declares a duration of 226,081 seconds, which is nonsense the
      // file shipped with. An explicit window ignores what it claims and takes
      // the first second, which is where the flinch is.
      hit: { file: 'mutant01@gethit.fbx', trim: 'window', window: [0, 1] },
      death: { file: 'mutant01@death01.fbx', trim: 'span' },
    },
  },
};

const NAME = process.argv[2] ?? 'orc';
const CHARACTER = CHARACTERS[NAME];
if (!CHARACTER) {
  console.error(`unknown character "${NAME}"; known: ${Object.keys(CHARACTERS).join(', ')}`);
  process.exit(2);
}
const OUT = CHARACTER.out;
const inPage = async (character) => {
  const clipSources = character.clips;
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { FBXLoader } = await import('/node_modules/three/examples/jsm/loaders/FBXLoader.js');
  const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
  const { TGALoader } = await import('/node_modules/three/examples/jsm/loaders/TGALoader.js');

  const report = { steps: [] };
  const say = (k, v) => report.steps.push(`${k}: ${v}`);

  // ── 1. The base mesh, and the one skeleton everything will answer to ───────
  const base = await new FBXLoader().loadAsync('/_src/' + character.base);
  base.updateMatrixWorld(true);

  const parts = [];
  base.traverse((o) => {
    if (o.isSkinnedMesh && o.geometry.getAttribute('skinIndex')) parts.push(o);
  });
  say('submeshes', parts.length);

  // Bones are shared scene nodes; only the per-skeleton ORDER differs. Keying
  // by name collapses the 49 orderings into one.
  const boneByName = new Map();
  // The bind inverse has to be carried along with the bone, because three will
  // happily invent one and the one it invents is wrong for any bone the file
  // does not currently hold at its bind pose. See `inverses` below.
  const inverseByName = new Map();
  for (const part of parts) {
    part.skeleton.bones.forEach((bone, i) => {
      if (boneByName.has(bone.name)) return;
      boneByName.set(bone.name, bone);
      inverseByName.set(bone.name, part.skeleton.boneInverses[i].clone());
    });
  }
  const bones = [...boneByName.values()];
  /**
   * The bind pose, taken from the file rather than recomputed.
   *
   * `new THREE.Skeleton(bones)` with no inverses calls `calculateInverses`,
   * which treats wherever the bones happen to be standing as the bind pose.
   * That is true for most of a character and false for exactly the parts that
   * matter: a prop is modelled at the origin and then posed into the hand, so
   * its bones sit far from their own bind pose in the file as shipped.
   *
   * On this crusader 101 of 125 bones are at bind and 24 are not, and the 24
   * are the shield, the flail handle, its twelve chain links, the three bones
   * of the head and the fingertips. Recomputing their inverses bakes the
   * displacement in permanently: the mace head and the shield render half a
   * metre off the hands that hold them and drift alongside the character, which
   * is what a floating weapon actually is. The body looks perfect throughout,
   * because the body IS at bind.
   */
  const inverses = bones.map((b) => inverseByName.get(b.name));
  const slotOf = new Map(bones.map((b, i) => [b.name, i]));
  say('bones', bones.length);
  say('axeBones', bones.filter((b) => /_axe_/i.test(b.name)).map((b) => b.name).join(', ') || 'NONE');

  // ── 2. Merge, remapping indices and baking each submesh's bind matrix ──────
  const byMaterial = new Map();
  let vertexTotal = 0;
  for (const part of parts) {
    const g = part.geometry;
    const count = g.getAttribute('position').count;
    // Which group this submesh belongs to.
    //
    // Normally the FBX material name, but a pack can need a finer split than
    // the FBX records. This crusader is the case that forced it: its author
    // left ONE material on the armour plates and on the flail and shield
    // together, and fixed it up per object in the Unity prefab, which assigns
    // `Crusader tank_body` to the nineteen body meshes and `Crusader tank_blunt`
    // to the seven weapon ones. Follow the FBX and no assignment is right --
    // put that material on the body sheet and the shield renders in tabard
    // checks, put it on the weapon sheet and the pauldrons and knee cops turn
    // to grey smears. The split has to come from the mesh names.
    let name = (Array.isArray(part.material) ? part.material[0] : part.material).name || 'default';
    for (const rule of character.materialByMesh ?? []) {
      if (new RegExp(rule.test, 'i').test(part.name)) { name = rule.material; break; }
    }
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
  const plain = new THREE.TextureLoader();
  const shrink = async (url, size) => {
    // TGA arrives as raw rows bottom-up and has to be drawn flipped; a PNG
    // arrives as an image the canvas already orients correctly. Treating both
    // the same turns one of them upside down.
    const isTga = /.tga$/i.test(url);
    const tex = isTga ? await tga.loadAsync(url) : await plain.loadAsync(url);
    const src = tex.image;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (isTga) {
      const tmp = document.createElement('canvas');
      tmp.width = src.width; tmp.height = src.height;
      tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0);
      ctx.save();
      ctx.scale(1, -1);
      ctx.drawImage(tmp, 0, -size, size, size);
      ctx.restore();
    } else {
      ctx.drawImage(src, 0, 0, size, size);
    }
    const out = new THREE.CanvasTexture(canvas);
    out.colorSpace = THREE.SRGBColorSpace;
    out.flipY = false;
    return { texture: out, from: [src.width, src.height] };
  };
  // Two ways to get textures. A pack that ships them as files names each one
  // against a material; a Mixamo export carries them INSIDE the FBX, where
  // three decodes them into ordinary images that load asynchronously -- read
  // too early they are all blank, which looks exactly like a broken atlas.
  const atlas = document.createElement('canvas');
  const actx = () => atlas.getContext('2d');
  const RECT = {};
  const loadedFrom = [];
  if (character.atlas.embedded) {
    const used = [...byMaterial.keys()];
    const sourceOf = new Map();
    base.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) sourceOf.set(m.name, m);
    });
    // Wait until the pixels are actually there. An image's "complete" flag is
    // not a sign of that: it reads true on one that has not started, so
    // trusting it drew every cell of the atlas as the grey fallback and shipped
    // a character with no texture at all. Width is the only honest test.
    // Wait for the pixels in two stages, because both can be absent and they
    // are absent for different reasons. The texture object exists from the
    // moment the file is parsed, but three fills in its `image` later, so a
    // check that gives up when the image is missing gives up every time. And
    // once the image does appear, its "complete" flag reads true before it has
    // any pixels. Width is the only honest test, and it has to be waited for.
    //
    // Getting this wrong is silent: every cell falls back to flat grey and the
    // character ships with no texture.
    await Promise.all(used.map(async (name) => {
      const material = sourceOf.get(name);
      if (!material || !material.map) return;
      for (let waited = 0; !material.map.image && waited < 8000; waited += 100) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const img = material.map.image;
      if (!img) return;
      if (img.decode) {
        try {
          await img.decode();
        } catch {
          // Falls through to the poll below; a decode that throws is not fatal.
        }
      }
      for (let waited = 0; !img.width && waited < 8000; waited += 100) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }));
    const size = character.atlas.size ?? 2048;
    const cols = Math.ceil(Math.sqrt(used.length));
    const rows = Math.ceil(used.length / cols);
    atlas.width = size; atlas.height = size;
    const cw = Math.floor(size / cols), ch = Math.floor(size / rows);
    const ctx = actx();
    used.forEach((name, i) => {
      const rect = { x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: cw, h: ch };
      RECT[name] = rect;
      const m = sourceOf.get(name);
      const img = m && m.map && m.map.image;
      if (img && img.width) {
        // Drawn upside down, on purpose. These textures come from an FBX, and
        // three samples an FBX texture with flipY = true: v = 0 is the BOTTOM
        // row of the stored image. The atlas is sampled with flipY = false, so
        // v = 0 is the TOP row, and the UV remap further down is a plain linear
        // scale into the cell with no flip of its own. Drawing the image the
        // way it is stored therefore mirrors every UV island vertically.
        //
        // It is not subtle once seen and it is invisible until it is: the
        // archer's face sits at the top of her texture, her head UVs landed
        // 0.7 of the way down the cell, over the chest, and she shipped with a
        // blank head. Skin over skin looks like bad shading rather than like a
        // wrong lookup, which is why it survived a build.
        //
        // The file path does this already, inside `shrink`, which is why the
        // orc and the mutant are correct and only this path was wrong.
        ctx.save();
        ctx.translate(rect.x, rect.y + rect.h);
        ctx.scale(1, -1);
        ctx.drawImage(img, 0, 0, rect.w, rect.h);
        ctx.restore();
      }
      else { ctx.fillStyle = '#808080'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
      // Say WHICH link broke. "MISSING" on its own sent the last build out with
      // a flat grey atlas and no clue where to look.
      const why = !m ? 'no material' : !m.map ? 'no map' : !img ? 'no image' : !img.width ? 'zero width' : null;
      loadedFrom.push(name + (why ? ' MISSING(' + why + ')' : ' ' + img.width + 'px'));
    });
  } else {
    atlas.width = character.atlas.width;
    atlas.height = character.atlas.height;
    const ctx = actx();
    for (const part of character.atlas.parts) {
      const img = await shrink('/_src/tex/' + part.file, Math.max(part.w, part.h));
      ctx.drawImage(img.texture.image, part.x, part.y, part.w, part.h);
      RECT[part.material] = part;
      loadedFrom.push(part.file + ' ' + img.from.join('x') + '->' + part.w);
    }
  }
  const atlasTexture = new THREE.CanvasTexture(atlas);
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.flipY = false;
  say('textures', loadedFrom.join(', ') + '  into ' + atlas.width + 'x' + atlas.height);

  let uvCursor = 0;
  for (const [name, chunks] of byMaterial) {
    const r = RECT[name];
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.count; i++) {
        const at = (uvCursor + i) * 2;
        if (r) {
          uvs[at] = (r.x + uvs[at] * r.w) / atlas.width;
          uvs[at + 1] = (r.y + uvs[at + 1] * r.h) / atlas.height;
        }
      }
      uvCursor += chunk.count;
    }
  }
  geometry.getAttribute('uv').needsUpdate = true;

  const materials = [
    new THREE.MeshStandardMaterial({ name: 'creature', map: atlasTexture, roughness: 0.85, metalness: 0.0 }),
  ];

  // ── 4. The skinned mesh ───────────────────────────────────────────────────
  const skeleton = new THREE.Skeleton(bones, inverses);
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
      // Measured against the first key at the head and the LAST key at the
      // tail, which is not symmetry for its own sake. A padded clip holds a
      // pose, and which pose it holds is up to whoever exported it: the orc's
      // files return to their first frame, the crusader's freeze on their last.
      // Judging the tail by its distance from the FIRST key only trims the
      // first kind, and the second kind sails through untouched -- a 14.17 s
      // walk whose cycle is one second, so the creature takes fourteen seconds
      // to complete a stride and reads as gliding. Judging the tail by its
      // distance from the last key finds where the hold begins in both, and for
      // a clip that returns to its start the two tests are the same test.
      let first = -1;
      let last = -1;
      const lastAt = (n - 1) * size;
      for (let i = 0; i < n; i++) {
        let fromHead = 0;
        let fromTail = 0;
        for (let c = 0; c < size; c++) {
          const v = track.values[i * size + c];
          fromHead = Math.max(fromHead, Math.abs(v - track.values[c]));
          fromTail = Math.max(fromTail, Math.abs(v - track.values[lastAt + c]));
        }
        if (first < 0 && fromHead > eps) first = i;
        if (fromTail > eps) last = i;
      }
      if (first < 0 || last < 0) continue;
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
    // Bones by traversal, not through the mesh. An animation exported
    // "without skin" -- which is how Mixamo and most clip libraries ship --
    // has a skeleton and no mesh at all, so asking the mesh for its bones
    // returns nothing and every burst trim silently degrades to the padding
    // trim, leaving a five second attack at five seconds.
    let bones = skinned ? skinned.skeleton.bones : [];
    if (!bones.length) { const found = []; fbx.traverse((o) => { if (o.isBone) found.push(o); }); bones = found; }
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

  const windowClip = (clip, id, span, speed = 1) => {
    const tracks = [];
    for (const track of clip.tracks) {
      const size = track.getValueSize();
      const times = [];
      const values = [];
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        if (t < span[0] - 1e-6 || t > span[1] + 1e-6) continue;
        times.push((t - span[0]) / speed);
        for (let c = 0; c < size; c++) values.push(track.values[i * size + c]);
      }
      if (times.length < 2) continue;
      tracks.push(new track.constructor(track.name, times, values));
    }
    return new THREE.AnimationClip(id, (span[1] - span[0]) / speed, tracks);
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
    if (source.trim === 'window') {
      cut = windowClip(whole, id, source.window, source.speed ?? 1);
    } else if (source.trim === 'loop') {
      cut = trimClip(whole, id);
    } else {
      let animated = null;
      fbx.traverse((o) => { if (!animated && o.isSkinnedMesh) animated = o; });
      const span = burstWindow(fbx, clip, animated, source.trim === 'span');
      // A clip longer than the gap between attacks is a clip whose end nobody
      // ever sees, so the tail is cut here rather than mid-playback.
      if (span && source.maxSeconds && span[1] - span[0] > source.maxSeconds) {
        span[1] = span[0] + source.maxSeconds;
      }
      cut = span ? windowClip(whole, id, span, source.speed ?? 1) : trimClip(whole, id);
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
  // A number shares the whole budget out in proportion to what each material
  // already covers, so a character with six materials does not need six
  // numbers picked by hand.
  let BUDGET = character.budget;
  if (typeof BUDGET === 'number') {
    const totalTris = groups.reduce((n, g) => n + g.count / 3, 0);
    BUDGET = {};
    for (const g of groups) BUDGET[g.name] = Math.max(60, Math.round((g.count / 3 / totalTris) * character.budget));
  }
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

  // ── 6b. Drop bones too small to read, and the branches that hang off them ──
  // The rig is built for cinematics: 139 bones, with joints for every finger,
  // each belt knife, each strand of rope and the fringe of the kilt. A creep is
  // 79 pixels tall on screen and none of that survives the trip. The cost does:
  // at 30 orcs the skeletons alone took 7.8 ms of a 16.6 ms frame.
  //
  // A bone is kept when it drives at least 20 of the 3,548 vertices, plus every
  // ancestor of one that is. A dropped bone's vertices go to its nearest kept
  // ancestor, which is where they would have followed anyway once the joint
  // between them stopped existing. Nothing is left orphaned and no weight is
  // lost: the weights that land on the same bone are summed and renormalised.
  {
    // One vertex is enough to keep a bone. The old threshold of twenty was a
    // performance idea that broke two characters in two different ways: it
    // deleted the hips the orc rotates its whole attack on, and it mangled the
    // archer's bow. Most of the saving was never in the bones anyway, it was
    // in collapsing the node tree, which is untouched. A bone that drives
    // nothing at all and holds nothing up still goes.
    const KEEP_AT = character.keepBonesAbove ?? 1;
    const outSkinIndex = outGeometry.getAttribute('skinIndex');
    const outSkinWeight = outGeometry.getAttribute('skinWeight');
    const drives = new Array(bones.length).fill(0);
    for (let v = 0; v < outSkinIndex.count; v++) {
      for (let k = 0; k < 4; k++) {
        if (outSkinWeight.getComponent(v, k) > 0.05) drives[outSkinIndex.getComponent(v, k)]++;
      }
    }
    // Ancestors are collected BY NAME, not by object identity. With 49 source
    // skeletons the same bone can arrive as more than one node instance, so an
    // identity walk up the tree quietly fails to recognise its own ancestors.
    //
    // And a bone is kept for being an ancestor even when it drives nothing at
    // all. ork_Hips drives exactly zero vertices here, because this rig skins
    // the pelvis to the spine and the thighs and uses the hips purely as the
    // root everything hangs from. Dropping it for having no vertices threw away
    // the rotation of the entire body, which is how an attack whose whole
    // content is a 360 degree turn arrived in the game as a character waving
    // its arms.
    // The vertex count is the wrong test for the end of a limb. An ankle skins
    // almost nothing and is the joint that makes a walk read; dropping it
    // leaves a character gliding on stiff legs. These are kept whatever they
    // drive, and the list is deliberately about locomotion and reach rather
    // than about detail: no fingers, no jaw, no cloth.
    const CORE = /(hips?|spined*$|spine$|neck|head$|shoulder|upperarm|upleg|thigh|(^|[^a-z])arm|forearm|hand$|leg$|calf|foot$|ankle|toebase|pelvis)/i;
    const keptNames = new Set();
    for (let i = 0; i < bones.length; i++) {
      if (drives[i] < KEEP_AT && !CORE.test(bones[i].name)) continue;
      keptNames.add(bones[i].name);
      for (let n = bones[i].parent; n; n = n.parent) {
        if (slotOf.has(n.name)) keptNames.add(n.name);
      }
    }
    const keep = new Set(bones.filter((b) => keptNames.has(b.name)));
    const kept = bones.filter((b) => keep.has(b));
    const newSlot = new Map(kept.map((b, i) => [b, i]));
    const redirect = new Int32Array(bones.length);
    for (let i = 0; i < bones.length; i++) {
      let n = bones[i];
      // Same reasoning as above: walk by name, and keep walking past anything
      // that is not a bone rather than giving up on it.
      while (n && !keptNames.has(n.name)) n = n.parent;
      redirect[i] = n && newSlot.has(n) ? newSlot.get(n) : 0;
    }

    for (let v = 0; v < outSkinIndex.count; v++) {
      const merged = new Map();
      for (let k = 0; k < 4; k++) {
        const w = outSkinWeight.getComponent(v, k);
        if (w <= 0) continue;
        const slot = redirect[outSkinIndex.getComponent(v, k)];
        merged.set(slot, (merged.get(slot) ?? 0) + w);
      }
      const ranked = [...merged.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 4);
      const sum = ranked.reduce((t, [, w]) => t + w, 0) || 1;
      const idx = [0, 0, 0, 0];
      const wts = [0, 0, 0, 0];
      ranked.forEach(([slot, w], k) => { idx[k] = slot; wts[k] = w / sum; });
      outSkinIndex.setXYZW(v, idx[0], idx[1], idx[2], idx[3]);
      outSkinWeight.setXYZW(v, wts[0], wts[1], wts[2], wts[3]);
    }
    outSkinIndex.needsUpdate = true;
    outSkinWeight.needsUpdate = true;

    // A branch with no kept bone under it drives nothing and can leave the tree
    // entirely, which takes its wrapper chain with it.
    const holdsKept = (node) => {
      if (keep.has(node)) return true;
      for (const child of node.children) if (holdsKept(child)) return true;
      return false;
    };
    const doomed = [];
    root.traverse((node) => {
      if (node === root || node.isMesh) return;
      if (node.parent && !node.parent.isMesh && !holdsKept(node)) doomed.push(node);
    });
    for (const node of doomed) if (node.parent) node.removeFromParent();

    for (const clip of clips) {
      clip.tracks = clip.tracks.filter((t) => keep.has(boneByName.get(t.name.split('.')[0])));
    }

    root.updateMatrixWorld(true);
    // Same reason as above: rebuilding from a subset must carry each kept
    // bone's own bind inverse, or the reduction undoes the fix.
    const reduced = new THREE.Skeleton(kept, kept.map((b2) => inverseByName.get(b2.name)));
    mesh.bind(reduced, new THREE.Matrix4());
    let left = 0;
    root.traverse(() => left++);
    say('bones', `${bones.length} -> ${kept.length}, nodes now ${left}`);
    // Bones kept purely for holding the body together carry rotation that no
    // vertex count can reveal, so they are reported: if the list is empty on a
    // humanoid, the ancestor rule has stopped working and the character will
    // animate limbs while refusing to turn.
    const structural = kept.filter((b2) => drives[bones.indexOf(b2)] === 0).map((b2) => b2.name);
    say('structuralBones', structural.length ? structural.join(', ') : 'NONE -- suspicious');
  }

  // ── 7. Did the axes survive all of that? ──────────────────────────────────
  const outSi = outGeometry.getAttribute('skinIndex');
  const outSw = outGeometry.getAttribute('skinWeight');
  // Against the FINAL skeleton: the bone reduction renumbered every slot, and
  // checking the old numbering is how a passing test can mean nothing.
  const finalSlot = new Map(mesh.skeleton.bones.map((b, i) => [b.name, i]));
  const check = {};
  for (const bn of character.verifyBones ?? []) {
    const slot = finalSlot.get(bn);
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
        // Not protected by name: every wrapper shares its name with the bone
        // it fronts, so a name test protects exactly what should go. Tracks
        // only ever target skeleton bones, which protectedNodes already covers.
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

  const report = await page.evaluate(inPage, CHARACTER);
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

export { CHARACTERS };
