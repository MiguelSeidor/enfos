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
  // Focus points track the authored map. When the layout moves, these move with
  // it — a shot aimed at where the Core used to be reviews empty ground.
  lane: { focus: [-48, -30], zoom: 0.45, yaw: 0.0, desc: 'Enemy lane, mid-height RTS view' },
  core: { focus: [-48, 34], zoom: 0.3, yaw: 0.0, desc: 'Core, fountain and both shops' },
  base: { focus: [-48, 24], zoom: 0.5, yaw: 0.0, desc: 'Whole base terrace from above' },
  junction: { focus: [-48, 92], zoom: 0.42, yaw: 3.14, desc: 'Bottom U junction and the climb north' },
  portals: { focus: [-48, -80], zoom: 0.55, yaw: 0.0, desc: 'Both spawn portals and the wide first U' },
  hero: { focus: [-48, 20], zoom: 0.1, yaw: 0.9, desc: 'Hero close-up, cinematic pitch' },
  terrainDetail: { focus: [-30, 60], zoom: 0.05, yaw: 3.9, desc: 'Ground material detail' },
  skyline: { focus: [-40, 60], zoom: 0.8, yaw: 1.6, desc: 'Horizon, sky and fog readability' },
  combat: { focus: [-48, 0], zoom: 0.28, yaw: 1.1, desc: 'Combat cluster, VFX legibility' },
  combatHero: {
    focus: [0, 0],
    zoom: 0.08,
    yaw: 0.6,
    desc: 'Hero-centred combat: health bars, damage numbers, impact readability',
    follow: true,
  },
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
  // `qa=1` skips the title screen so shots are never blocked by a menu waiting
  // for a click. `--menu` leaves it up, which is how the title screen is
  // reviewed.
  const url =
    `${URL_BASE}/?seed=${SEED}` +
    (args.menu ? '' : '&qa=1') +
    (needsShowcase || args.showcase ? '&showcase=1' : '') +
    (args.stress ? `&stress=${args.stress}` : '');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  // Wait for the engine to publish its QA handle.
  await page.waitForFunction(() => Boolean(window.__GAME__), null, { timeout: TIMEOUT });

  // Let shaders compile and the first frames flush before posing anything.
  await settle(page, SETTLE_FRAMES);

  // Fast-forward the simulation so shots show a wave in progress rather than an
  // empty preparation phase. stepHeadless advances the fixed-step sim directly,
  // which the engine's per-frame catch-up clamp would otherwise never allow.
  if (args.ticks) {
    await page.evaluate((n) => window.__GAME__.engine.stepHeadless(n), Number(args.ticks));
    await settle(page, 12);
  }

  const frameProblems = [];
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
      // `follow: true` shots frame the player's hero instead of a fixed point,
      // which is the only way to reliably capture combat — the fight happens
      // wherever the hero is, not at a coordinate chosen in advance.
      let focus = { x: s.focus[0], z: s.focus[1] };
      if (s.follow) {
        const hero = window.__GAME__.engine.ctx.match.heroes.values().next().value;
        if (hero) focus = { x: hero.pos.x, z: hero.pos.z };
      }
      window.__GAME__.camera.poseImmediate(focus, s.zoom, s.yaw);
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

    const frame = await analyzeFrame(page);

    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    report.shots.push({ name, desc: shot.desc, file, ...stats, frame });
    process.stdout.write(
      `captured ${name} -> ${file} (${stats.drawCalls} calls, ${stats.triangles} tris)\n`,
    );
    for (const problem of frame.problems) {
      frameProblems.push(`${name}: ${problem}`);
      process.stdout.write(`  !! ${problem}\n`);
    }
  }

  report.frameProblems = frameProblems;
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();

  if (consoleErrors.length > 0) {
    process.stdout.write(`\nCONSOLE ERRORS (${consoleErrors.length}):\n`);
    for (const e of consoleErrors.slice(0, 20)) process.stdout.write(`  ${e}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nno console errors\n');
  }

  // A capture that produced a broken frame must fail loudly. Silently writing a
  // PNG that "looks fine" is exactly how the white-screen bug survived review.
  if (frameProblems.length > 0) {
    process.stdout.write(`\nFRAME PROBLEMS (${frameProblems.length}):\n`);
    for (const p of frameProblems) process.stdout.write(`  ${p}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('frame validation passed\n');
  }
}

/**
 * Reads the live drawing buffer and reports what is actually on screen.
 *
 * This exists because a screenshot alone lied. A frame-order-dependent bug in the
 * post chain made the image saturate to white in a normal window while the
 * headless capture kept returning a correct picture, so every review iteration
 * came back green against a build that was visibly broken. Statistics over the
 * real buffer catch that class of failure; an eyeballed PNG does not.
 *
 * Flagged conditions:
 *  - saturated: the frame is mostly pure white or pure black
 *  - flat: almost no luminance variance, i.e. nothing is being drawn
 *  - transparent: alpha is not opaque, so the canvas composites away
 *  - no-contrast: fails the rubric requirement for real darks and real brights
 */
async function analyzeFrame(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const g = window.__GAME__;
        requestAnimationFrame(() => {
          const gl = g.renderer.getContext();
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

          let min = 1e9;
          let max = -1e9;
          let sum = 0;
          let sumSq = 0;
          let white = 0;
          let black = 0;
          let nonOpaque = 0;
          let dark = 0;
          let bright = 0;
          const n = w * h;
          // Stride over pixels; full-resolution stats are not worth the time.
          const stride = Math.max(1, Math.floor(n / 200000));
          let counted = 0;
          for (let i = 0; i < n; i += stride) {
            const o = i * 4;
            const r = px[o];
            const gg = px[o + 1];
            const b = px[o + 2];
            const a = px[o + 3];
            const lum = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
            if (lum < min) min = lum;
            if (lum > max) max = lum;
            sum += lum;
            sumSq += lum * lum;
            if (r > 250 && gg > 250 && b > 250) white++;
            if (r < 4 && gg < 4 && b < 4) black++;
            if (a < 255) nonOpaque++;
            if (lum < 0.1) dark++;
            if (lum > 0.9) bright++;
            counted++;
          }
          const mean = sum / counted;
          const variance = sumSq / counted - mean * mean;
          const problems = [];
          if (white / counted > 0.5) problems.push(`saturated: ${(100 * white / counted).toFixed(0)}% pure white`);
          if (black / counted > 0.9) problems.push(`saturated: ${(100 * black / counted).toFixed(0)}% pure black`);
          if (variance < 0.0005) problems.push(`flat frame: luminance variance ${variance.toExponential(1)}`);
          if (nonOpaque / counted > 0.01)
            problems.push(`transparent: ${(100 * nonOpaque / counted).toFixed(0)}% of pixels have alpha < 255`);
          if (dark / counted < 0.001 || bright / counted < 0.00002)
            problems.push(
              `no-contrast: ${(100 * dark / counted).toFixed(2)}% below 10% luma, ` +
                `${(100 * bright / counted).toFixed(3)}% above 90%`,
            );

          resolve({
            meanLuma: Number(mean.toFixed(4)),
            minLuma: Number(min.toFixed(4)),
            maxLuma: Number(max.toFixed(4)),
            variance: Number(variance.toFixed(5)),
            pctPureWhite: Number((100 * white / counted).toFixed(2)),
            pctBelow10: Number((100 * dark / counted).toFixed(2)),
            pctAbove90: Number((100 * bright / counted).toFixed(3)),
            problems,
          });
        });
      }),
  );
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
