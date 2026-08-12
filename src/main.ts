/**
 * Bootstrap. Owner: architecture lead.
 *
 * Module registration order is authoritative: simulation modules (order < 800)
 * run before presentation modules. Subsystem agents register their module here
 * and nowhere else.
 */

import * as THREE from 'three';
import { Engine, createMatchState } from '@/core/engine';
import { RenderModule } from '@/render/renderer';
import { RtsCamera } from '@/render/camera';
import { createWorldModules } from '@/world';
import { createUnitModules } from '@/units';
import { TerrainKey, RenderKey } from '@/core/services';

const boot = document.getElementById('boot')!;
const bootBar = boot.querySelector('#boot-bar > i') as HTMLElement;
const bootLabel = document.getElementById('boot-label')!;

function setBootProgress(done: number, total: number, label: string): void {
  bootBar.style.width = `${Math.round((done / total) * 100)}%`;
  bootLabel.textContent = label;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // SMAA runs in the composer
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  const rtsCamera = new RtsCamera(window.innerWidth / window.innerHeight);

  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed') ?? 20260812);
  const showcase = params.get('showcase') === '1';
  const match = createMatchState(seed, '1v1');

  const renderModule = new RenderModule(renderer, scene, rtsCamera.camera);

  const engine = new Engine({
    scene,
    camera: rtsCamera.camera,
    renderer,
    match,
    seed,
    present: (alpha, dt) => renderModule.render(alpha, dt),
  });

  // Registration order does not matter; Engine sorts by `order`.
  for (const module of createWorldModules()) engine.add(module);
  for (const module of createUnitModules(showcase)) engine.add(module);
  engine.add(renderModule);

  await engine.initAll(setBootProgress);

  // Camera reads terrain height so it never clips into cliffs.
  const terrain = engine.ctx.services.get(TerrainKey);
  rtsCamera.setHeightSampler((x, z) => terrain.heightAt(x, z));
  rtsCamera.setLimits({ minX: -105, maxX: 105, minZ: -105, maxZ: 105 });
  rtsCamera.setFocus({ x: -55, z: 10 }, true);

  engine.ctx.bus.on('camera:shake', ({ intensity, duration }) =>
    rtsCamera.shake(intensity, duration),
  );

  setupInput(rtsCamera);

  // Camera updates before presentation so the composer sees the final transform.
  engine.add({
    id: 'camera',
    order: 850,
    init: () => {},
    update: (dt) => rtsCamera.update(dt),
  });

  const onResize = (): void => {
    engine.ctx.services.get(RenderKey).resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  engine.start();

  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 600);

  // Exposed for automated visual QA and the review loop.
  (window as unknown as { __GAME__: unknown }).__GAME__ = {
    engine,
    camera: rtsCamera,
    renderer,
    scene,
    stats: engine.stats,
  };
}

function setupInput(cam: RtsCamera): void {
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener(
    'wheel',
    (e) => {
      cam.zoomBy(Math.sign(e.deltaY));
      e.preventDefault();
    },
    { passive: false },
  );

  let rotating = false;
  let lastX = 0;
  window.addEventListener('pointerdown', (e) => {
    if (e.button === 1) {
      rotating = true;
      lastX = e.clientX;
    }
  });
  window.addEventListener('pointerup', () => {
    rotating = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!rotating) return;
    cam.rotateBy((e.clientX - lastX) * -0.006);
    lastX = e.clientX;
  });

  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    let dx = 0;
    let dz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) dz -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) dz += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;
    if (dx !== 0 || dz !== 0) cam.pan(dx, dz, dt);
    requestAnimationFrame(tick);
  };
  tick();
}

main().catch((err: unknown) => {
  console.error('[boot] fatal', err);
  bootLabel.textContent = 'Error de arranque — ver consola';
});
