/**
 * Headless visual capture harness.
 *
 * This is the backbone of the AAA review loop: it drives the running game in a
 * headless Chromium, poses the camera at a fixed set of shots, waits for the
 * frame to settle, and writes PNGs that a reviewer agent can open directly.
 *
 * Usage:
 *   node tools/capture.mjs --label baseline
 *   node tools/capture.mjs --label wave12 --shots hero,lane,core --width 2560
 *   node tools/capture.mjs --label perf --stress 800
 *
 * Output: qa/shots/<label>/<shot>.png  +  qa/shots/<label>/report.json
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const LABEL = args.label ?? 'default';
const URL_BASE = args.url ?? 'http://127.0.0.1:5173';
const WIDTH = Number(args.width ?? 1920);
const HEIGHT = Number(args.height ?? 1080);
const SEED = Number(args.seed ?? 20260812);
const SETTLE_FRAMES = Number(args.settle ?? 90);
const TIMEOUT = Number(args.timeout ?? 120000);

/**
 * Shot list. Each entry poses the camera deterministically so successive review
 * iterations are comparable frame-to-frame. Keep these stable — the whole point
 * is that iteration N and N+1 differ only by the art/code change under review.
 */
const SHOTS = {
  overview: { focus: [0, 0], zoom: 0.95, yaw: 0.0, desc: 'Full arena overview' },
  lane: { focus: [-64, -20], zoom: 0.45, yaw: 0.5, desc: 'Enemy lane, mid-height RTS view' },
  core: { focus: [-34, -8], zoom: 0.32, yaw: 2.4, desc: 'Core / defense zone close view' },
  hero: { focus: [-50, 8], zoom: 0.1, yaw: 0.9, desc: 'Hero close-up, cinematic pitch' },
  terrainDetail: { focus: [-78, 34], zoom: 0.05, yaw: 3.9, desc: 'Ground material detail' },
  skyline: { focus: [-20, 60], zoom: 0.8, yaw: 1.6, desc: 'Horizon, sky and fog readability' },
  combat: { focus: [-58, -30], zoom: 0.28, yaw: 1.1, desc: 'Combat cluster, VFX legibility' },
  characters: {
    focus: [0, -88],
    zoom: 0.06,
    yaw: 0,
    desc: 'Character showcase line-up (requires ?showcase=1)',
    showcase: true,
  },
};

const requestedShots = args.shots
  ? String(args.shots)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s in SHOTS)
  : Object.keys(SHOTS);

const outDir = path.resolve('qa', 'shots', LABEL);

async function main() {
  if (existsSync(outDir) && args.clean !== 'false') {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    // Hardware ANGLE/D3D11. SwiftShader also works but is ~20x slower and
    // makes screenshots time out, so it is not an acceptable fallback here.
    args: [
      '--use-gl=angle',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--disable-dev-shm-usage',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--hide-scrollbars',
      '--mute-audio',
      '--js-flags=--max-old-space-size=4096',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  const needsShowcase = requestedShots.some((n) => SHOTS[n].showcase);
  const url =
    `${URL_BASE}/?seed=${SEED}&qa=1` +
    (needsShowcase || args.showcase ? '&showcase=1' : '') +
    (args.stress ? `&stress=${args.stress}` : '');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  // Wait for the engine to publish its QA handle.
  await page.waitForFunction(() => Boolean(window.__GAME__), null, { timeout: TIMEOUT });

  // Let shaders compile and the first frames flush before posing anything.
  await settle(page, SETTLE_FRAMES);

  const report = {
    label: LABEL,
    seed: SEED,
    resolution: `${WIDTH}x${HEIGHT}`,
    capturedAt: new Date().toISOString(),
    shots: [],
    consoleErrors,
  };

  for (const name of requestedShots) {
    const shot = SHOTS[name];
    await page.evaluate((s) => {
      window.__GAME__.camera.poseImmediate({ x: s.focus[0], z: s.focus[1] }, s.zoom, s.yaw);
    }, shot);

    await settle(page, 20);

    const stats = await page.evaluate(() => {
      const s = window.__GAME__.stats;
      return {
        fps: Math.round(s.fps),
        frameMs: Number(s.frameMs.toFixed(2)),
        simMs: Number(s.simMs.toFixed(2)),
        drawCalls: s.drawCalls,
        triangles: s.triangles,
        programs: s.programs,
      };
    });

    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    report.shots.push({ name, desc: shot.desc, file, ...stats });
    process.stdout.write(`captured ${name} -> ${file} (${stats.drawCalls} calls, ${stats.triangles} tris)\n`);
  }

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();

  if (consoleErrors.length > 0) {
    process.stdout.write(`\nCONSOLE ERRORS (${consoleErrors.length}):\n`);
    for (const e of consoleErrors.slice(0, 20)) process.stdout.write(`  ${e}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nno console errors\n');
  }
}

/** Waits for N animation frames so post-processing history buffers converge. */
async function settle(page, frames) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let i = 0;
        const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    frames,
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

main().catch((err) => {
  console.error('[capture] failed:', err);
  process.exit(1);
});
