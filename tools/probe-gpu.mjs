/** Probes which headless GL backend actually renders this scene fast enough. */
import { chromium } from 'playwright';

const BASE = [
  '--ignore-gpu-blocklist',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
];

const CANDIDATES = [
  { name: 'angle-d3d11', args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu'] },
  { name: 'angle-gl', args: ['--use-gl=angle', '--use-angle=gl', '--enable-gpu'] },
  { name: 'default', args: ['--enable-gpu'] },
  {
    name: 'swiftshader',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
];

for (const c of CANDIDATES) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: [...BASE, ...c.args] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('http://127.0.0.1:5173/?qa=1', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForFunction(() => Boolean(window.__GAME__), null, { timeout: 30000 });

    const info = await page.evaluate(() => {
      const gl = window.__GAME__.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
      };
    });

    // Measure how long 30 real frames take.
    const ms = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const t0 = performance.now();
          let i = 0;
          const step = () => (++i >= 30 ? resolve(performance.now() - t0) : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
    );

    const t0 = Date.now();
    await page.screenshot({ timeout: 60000 });
    const shotMs = Date.now() - t0;

    console.log(
      `${c.name.padEnd(14)} OK  renderer="${info.renderer}"  30frames=${ms.toFixed(0)}ms  screenshot=${shotMs}ms`,
    );
  } catch (err) {
    console.log(`${c.name.padEnd(14)} FAIL  ${String(err).split('\n')[0]}`);
  } finally {
    await browser?.close();
  }
}
