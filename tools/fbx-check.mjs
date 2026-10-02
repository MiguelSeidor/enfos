/**
 * Answers in one command whether an asset pack can be used at all.
 *
 * Usage, with the dev server running:
 *   node tools/fbx-check.mjs <file.fbx|file.glb> [more files...]
 *
 * A creature needs three things to walk and attack: a skeleton, a mesh bound to
 * that skeleton, and clips. Most models on sale have none of them, and nothing
 * on the product page says so plainly. This prints the three numbers.
 *
 * It exists because two packs were bought, downloaded and staged before anyone
 * established that both were static: an archer of 589,953 triangles with zero
 * bones and zero animations, and a spider with the same. Running this first
 * would have cost ten seconds.
 *
 * It only reads. Nothing is written and nothing is installed.
 */

import { chromium } from 'playwright';
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

const PAGE = 'http://127.0.0.1:5173/play/';
const STAGE = 'public/_check';

const inPage = async (names) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { FBXLoader } = await import('/node_modules/three/examples/jsm/loaders/FBXLoader.js');
  const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');

  const out = [];
  for (const name of names) {
    const url = '/_check/' + name;
    try {
      // A glTF keeps its clips beside the scene rather than inside it, so the
      // wrapper has to survive: reaching for `.scene` straight away reports
      // every animated GLB as having none.
      const loaded = /\.fbx$/i.test(name)
        ? await new FBXLoader().loadAsync(url)
        : await new GLTFLoader().loadAsync(url);
      const root = loaded.scene ?? loaded;
      const animations = loaded.animations ?? root.animations ?? [];
      root.updateMatrixWorld(true);

      let bones = 0;
      let nodes = 0;
      let verts = 0;
      let tris = 0;
      let skinned = 0;
      const meshes = [];
      root.traverse((o) => {
        nodes++;
        if (o.isBone) bones++;
        if (!o.isMesh) return;
        const g = o.geometry;
        const n = g.getAttribute('position').count;
        const t = Math.round((g.index ? g.index.count : n) / 3);
        verts += n;
        tris += t;
        if (o.isSkinnedMesh && g.getAttribute('skinIndex')) skinned++;
        meshes.push({ name: String(o.name).slice(0, 22), tris: t });
      });
      const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
      out.push({
        name, nodes, bones, meshes: meshes.length, skinnedMeshes: skinned,
        verts, tris, animations: animations.length,
        clips: animations.map((c) => `${c.name}:${c.duration.toFixed(2)}s`),
        biggest: meshes.sort((a, b) => b.tris - a.tris).slice(0, 4),
        size: size.toArray().map((v) => +v.toFixed(1)),
      });
    } catch (err) {
      out.push({ name, error: String(err).slice(0, 160) });
    }
  }
  return out;
};

const main = async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/fbx-check.mjs <file.fbx|file.glb> [...]');
    process.exit(2);
  }
  mkdirSync(STAGE, { recursive: true });
  const names = [];
  for (const file of files) {
    const path = resolve(file);
    if (!existsSync(path)) {
      console.error(`  missing: ${file}`);
      continue;
    }
    const name = basename(path).replace(/[^\w.-]/g, '_');
    copyFileSync(path, `${STAGE}/${name}`);
    names.push(name);
  }

  const browser = await chromium.launch({ args: ['--use-gl=angle'] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  page.on('pageerror', (e) => console.error('PAGE ERROR', String(e).slice(0, 200)));
  await page.goto(PAGE, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 5000));
  const report = await page.evaluate(inPage, names);
  await browser.close();
  rmSync(STAGE, { recursive: true, force: true });

  for (const r of report) {
    console.log(`\n=== ${r.name} ===`);
    if (r.error) {
      console.log(`  could not load: ${r.error}`);
      continue;
    }
    // A clip file exported "without skin" is a skeleton and a motion and no
    // mesh, which is correct and not a failure. Judging it as if it had to be
    // a whole creature reports every animation download as broken.
    const animationOnly = r.bones > 0 && r.meshes === 0 && r.animations > 0;
    const usable = animationOnly || (r.bones > 0 && r.skinnedMeshes > 0 && r.animations > 0);
    console.log(`  bones          ${r.bones}`);
    console.log(`  skinned meshes ${r.skinnedMeshes} of ${r.meshes}`);
    console.log(`  animations     ${r.animations}${r.clips.length ? '  ' + r.clips.join(', ') : ''}`);
    console.log(`  triangles      ${r.tris.toLocaleString()}   (budget is about 3,500)`);
    console.log(`  biggest meshes ${r.biggest.map((m) => `${m.name}:${m.tris.toLocaleString()}`).join(', ')}`);
    console.log(`  bounds         ${r.size.join(' x ')}`);
    console.log(animationOnly ? '  ANIMATION FILE: a skeleton and a clip, no mesh. Correct for a clip download.'
      : usable ? '  USABLE: has a skeleton, a bound mesh and clips.' : '  NOT USABLE as a creep: ' +
      [r.bones === 0 ? 'no skeleton' : null,
       r.skinnedMeshes === 0 ? 'no mesh bound to one' : null,
       r.animations === 0 ? 'no animations' : null].filter(Boolean).join(', ') + '.');
  }
};

main().catch((e) => {
  rmSync(STAGE, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
