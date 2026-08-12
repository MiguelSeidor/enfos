/**
 * Procedural noise primitives. Owner: MATERIALS agent.
 *
 * Every generator here is **exactly periodic**. Callers pass an integer lattice
 * period per axis and the field repeats on that period with C1 continuity across
 * the seam. That is what makes the synthesised textures seamlessly tileable
 * without mirroring — `qa/REVIEW_RUBRIC.md` treats a visible tiling period as an
 * automatic reject, and mirroring trades a seam for an obvious axis of symmetry,
 * which is worse.
 *
 * Two rules keep periodicity intact through the whole stack:
 *
 *   1. Frequencies are integers (cycles per tile) and octaves use lacunarity 2,
 *      so every octave's period divides the tile.
 *   2. Any coordinate transform applied before sampling must map the integer
 *      lattice onto itself. Axis-aligned scaling by integers and integer shears
 *      qualify; an arbitrary rotation does not. `shearedPerlin` exists precisely
 *      so directional features (scratches, grain, wear) can be generated without
 *      breaking rule 2.
 *
 * The value noise this replaces produced two visible defects: mush above ~1/4
 * Nyquist (linear interpolation of uncorrelated values has no gradient content)
 * and strong axis-aligned banding (its interpolant is separable in x and y).
 * Gradient noise with a quintic fade and a 512-entry isotropic gradient table
 * fixes both.
 */

/** Golden-angle gradient table: isotropic, no axis clustering, power-of-two size. */
const GRAD_N = 512;
const GRAD = new Float32Array(GRAD_N * 2);
for (let i = 0; i < GRAD_N; i++) {
  const a = i * 2.399963229728653 + 0.6180339887498949;
  GRAD[i * 2] = Math.cos(a);
  GRAD[i * 2 + 1] = Math.sin(a);
}

/** Integer hash. Deterministic across platforms (all ops are 32-bit integer). */
export function ihash(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Hash to [0,1). */
export function hash01(x: number, y: number, seed: number): number {
  return ihash(x, y, seed) / 4294967296;
}

/** Positive modulo for integers. */
export function pmod(a: number, n: number): number {
  const m = a % n;
  return m < 0 ? m + n : m;
}

/** Quintic fade — C2 continuous, so no second-derivative creases at the lattice. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function dotGrad(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const g = (ihash(ix, iy, seed) & (GRAD_N - 1)) << 1;
  return GRAD[g]! * dx + GRAD[g + 1]! * dy;
}

/**
 * Periodic 2D gradient noise in roughly [-1,1].
 * `px`/`py` are the lattice periods in the same units as `x`/`y`, and must be
 * positive integers for the field to tile.
 */
export function perlin(x: number, y: number, px: number, py: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fade(fx);
  const v = fade(fy);

  const ix0 = pmod(x0, px);
  const iy0 = pmod(y0, py);
  const ix1 = pmod(x0 + 1, px);
  const iy1 = pmod(y0 + 1, py);

  const n00 = dotGrad(ix0, iy0, seed, fx, fy);
  const n10 = dotGrad(ix1, iy0, seed, fx - 1, fy);
  const n01 = dotGrad(ix0, iy1, seed, fx, fy - 1);
  const n11 = dotGrad(ix1, iy1, seed, fx - 1, fy - 1);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  // Peak magnitude of 2D gradient noise is sqrt(2)/2; rescale to ~[-1,1].
  return (a + (b - a) * v) * 1.4142135623730951;
}

/**
 * Periodic gradient noise sampled through an integer shear.
 *
 * The transform is `(x,y) -> (fx*(x + kx*y), fy*(y + ky*x))` with integer `kx`,
 * `ky`. Integer shears are unimodular on the lattice, so the result still tiles
 * on the unit square. Combined with `fx != fy` this stretches features along a
 * chosen direction — the basis for scratches, brushed metal and wood grain.
 *
 * `u`,`v` are tile coordinates in [0,1).
 */
export function shearedPerlin(
  u: number,
  v: number,
  fx: number,
  fy: number,
  kx: number,
  ky: number,
  seed: number,
): number {
  const x = fx * (u + kx * v);
  const y = fy * (v + ky * u);
  // Period along x is fx (it divides both fx and fx*kx); likewise for y.
  return perlin(x, y, fx, fy, seed);
}

/** Periodic fBm in [-1,1]. `freq` must be an integer; lacunarity is fixed at 2. */
export function fbm(
  u: number,
  v: number,
  freq: number,
  seed: number,
  octaves: number,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin(u * f, v * f, f, f, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Ridged multifractal in [0,1]. Each octave is attenuated by the previous one,
 * which concentrates detail on the crests instead of spreading it evenly — this
 * is what makes rock read as rock rather than as bumpy fBm.
 */
export function ridged(
  u: number,
  v: number,
  freq: number,
  seed: number,
  octaves: number,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin(u * f, v * f, f, f, seed + i * 617));
    n *= n;
    n *= prev;
    prev = n < 0 ? 0 : n > 1 ? 1 : n;
    sum += amp * n;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Billowy (absolute-value) fBm in [0,1]; reads as clouds, moss, corrosion. */
export function billow(
  u: number,
  v: number,
  freq: number,
  seed: number,
  octaves: number,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * Math.abs(perlin(u * f, v * f, f, f, seed + i * 331));
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Worley / cellular result. Reused across calls so the hot loop allocates nothing.
 * `f1`/`f2` are the two nearest feature-point distances in cell units,
 * `id` is the winning cell's hash (per-cell random values: cobble tint, brick
 * height jitter), and `cx`/`cy` are its wrapped lattice coordinates.
 */
export const worleyResult = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };

/**
 * Periodic Worley noise, F1 and F2. Feature points stay inside their own cell
 * (offset 0.5 ± jitter/2), so a 3x3 neighbourhood is exact.
 *
 * F1 alone gives dots and rounded cobbles; F2-F1 gives the crack network between
 * cells, which is the term that actually reads as stone at close range.
 */
export function worley(
  x: number,
  y: number,
  px: number,
  py: number,
  seed: number,
  jitter = 1,
): void {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let d1 = 1e9;
  let d2 = 1e9;
  let id = 0;
  let bx = 0;
  let by = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = pmod(cx, px);
      const wy = pmod(cy, py);
      const h = ihash(wx, wy, seed);
      const jx = ((h & 0xffff) / 65536 - 0.5) * jitter;
      const jy = (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter;
      const fxp = cx + 0.5 + jx - x;
      const fyp = cy + 0.5 + jy - y;
      const d = fxp * fxp + fyp * fyp;
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = h;
        bx = wx;
        by = wy;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }

  worleyResult.f1 = Math.sqrt(d1);
  worleyResult.f2 = Math.sqrt(d2);
  worleyResult.id = id;
  worleyResult.cx = bx;
  worleyResult.cy = by;
}

/**
 * Bilinear sample of a periodic grid with smootherstep weights.
 *
 * Used to upsample a coarse octave to the working resolution. Plain bilinear on
 * a band-limited field leaves faint grid-aligned creases where the interpolant's
 * derivative jumps; smootherstep weights remove them at negligible cost, which
 * matters because grid-aligned artifacts are exactly the defect this module
 * exists to avoid.
 */
export function sampleGridWrap(g: Float32Array, res: number, u: number, v: number): number {
  const x = u * res - 0.5;
  const y = v * res - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const i0 = pmod(x0, res);
  const i1 = pmod(x0 + 1, res);
  const j0 = pmod(y0, res) * res;
  const j1 = pmod(y0 + 1, res) * res;
  const a = g[j0 + i0]!;
  const b = g[j0 + i1]!;
  const c = g[j1 + i0]!;
  const d = g[j1 + i1]!;
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * ty;
}

/**
 * Separable box blur with wrap-around, in place. O(n^2) per axis regardless of
 * radius via a running sum, which is what makes the multi-radius cavity term in
 * `textures.ts` affordable.
 */
export function boxBlurWrap(
  src: Float32Array,
  dst: Float32Array,
  tmp: Float32Array,
  n: number,
  radius: number,
): void {
  const r = Math.max(1, Math.round(radius));
  const w = 1 / (r * 2 + 1);

  for (let y = 0; y < n; y++) {
    const row = y * n;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + pmod(k, n)]!;
    for (let x = 0; x < n; x++) {
      tmp[row + x] = sum * w;
      sum -= src[row + pmod(x - r, n)]!;
      sum += src[row + pmod(x + r + 1, n)]!;
    }
  }

  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[pmod(k, n) * n + x]!;
    for (let y = 0; y < n; y++) {
      dst[y * n + x] = sum * w;
      sum -= tmp[pmod(y - r, n) * n + x]!;
      sum += tmp[pmod(y + r + 1, n) * n + x]!;
    }
  }
}
