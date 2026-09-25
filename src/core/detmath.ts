/**
 * Deterministic transcendental math. Owner: CORE.
 *
 * `Math.sin`, `Math.atan2`, `Math.exp`, `Math.pow` and `Math.hypot` are not
 * specified to the last bit: the standard lets every engine pick its own
 * implementation, and they disagree. Chromium and WebKit running the same
 * match drifted apart in the last bits of a velocity within forty seconds,
 * and from there the two simulations were different games — which is fatal
 * for lockstep play, where every machine must compute the same world from the
 * same commands.
 *
 * Everything here is built from +, −, ×, ÷, comparisons and `Math.sqrt`, which
 * IEEE-754 *does* pin down exactly, so every engine gets the same bits. The
 * approximations are accurate to roughly 1e-16 relative — far below anything
 * the game can feel — and what matters is that they are identical everywhere.
 *
 * Simulation code must use these. Presentation code (rendering, VFX, audio,
 * camera) may keep using `Math.*`: a pixel that differs in the last bit on one
 * machine changes nothing.
 */

export const PI = 3.141592653589793;
export const HALF_PI = 1.5707963267948966;
export const TWO_PI = 6.283185307179586;
export const LN2 = 0.6931471805599453;
const LOG2E = 1.4426950408889634;
const TWO_OVER_PI = 0.6366197723675814;

// Cody–Waite split of π/2: the high part has trailing zero bits, so `k * HI`
// is exact and the subtraction loses nothing.
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
const PIO2_LO2 = 2.0222662487959506e-21;

// fdlibm kernel coefficients for |r| <= π/4.
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

/** sin on the reduced range |r| <= π/4. */
function kernelSin(r: number): number {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

/** cos on the reduced range |r| <= π/4. */
function kernelCos(r: number): number {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/** Argument reduction: returns the quadrant in `quad` and the remainder. */
let quad = 0;
function reduce(x: number): number {
  // `Math.floor` and the arithmetic below are exact operations, so the
  // reduction itself cannot differ between engines.
  const k = Math.floor(x * TWO_OVER_PI + 0.5);
  quad = ((k % 4) + 4) % 4;
  // Three-part subtraction: enough for the angles a match ever produces
  // (hundreds of radians at most) to stay accurate to the last bits.
  return x - k * PIO2_HI - k * PIO2_LO - k * PIO2_LO2;
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const r = reduce(x);
  switch (quad) {
    case 0:
      return kernelSin(r);
    case 1:
      return kernelCos(r);
    case 2:
      return -kernelSin(r);
    default:
      return -kernelCos(r);
  }
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const r = reduce(x);
  switch (quad) {
    case 0:
      return kernelCos(r);
    case 1:
      return -kernelSin(r);
    case 2:
      return -kernelCos(r);
    default:
      return kernelSin(r);
  }
}

// fdlibm atan kernel, for |t| <= tan(π/8).
const T0 = 3.33333333333329318027e-1;
const T1 = -1.99999999998764832476e-1;
const T2 = 1.42857142725034663711e-1;
const T3 = -1.11111104054623557880e-1;
const T4 = 9.09088713343650656196e-2;
const T5 = -7.69187620504482999495e-2;
const T6 = 6.66107313738753120669e-2;
const T7 = -5.83357013379057348645e-2;
const T8 = 4.97687799461593236017e-2;
const T9 = -3.65315727442169155270e-2;
const T10 = 1.62858201153657823623e-2;

function kernelAtan(t: number): number {
  const z = t * t;
  const w = z * z;
  const s1 = z * (T0 + w * (T2 + w * (T4 + w * (T6 + w * (T8 + w * T10)))));
  const s2 = w * (T1 + w * (T3 + w * (T5 + w * (T7 + w * T9))));
  return t - t * (s1 + s2);
}

const TAN_PI_8 = 0.41421356237309503;
const PI_4 = 0.7853981633974483;

export function atan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const sign = x < 0 ? -1 : 1;
  let a = x < 0 ? -x : x;
  if (a === Infinity) return sign * HALF_PI;
  // Two reductions bring any argument into the kernel's range.
  let result: number;
  if (a > 1) {
    a = 1 / a;
    result = a > TAN_PI_8 ? HALF_PI - (PI_4 + kernelAtan((a - 1) / (a + 1))) : HALF_PI - kernelAtan(a);
  } else {
    result = a > TAN_PI_8 ? PI_4 + kernelAtan((a - 1) / (a + 1)) : kernelAtan(a);
  }
  return sign * result;
}

/** Same argument order as `Math.atan2`. */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  // x === 0 (either sign of zero: the simulation never distinguishes them).
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/** 2^k for an integer k, by exact doubling — every step is representable. */
function pow2(k: number): number {
  let n = k | 0;
  let result = 1;
  let base = n < 0 ? 0.5 : 2;
  if (n < 0) n = -n;
  while (n > 0) {
    if (n & 1) result *= base;
    base *= base;
    n >>= 1;
  }
  return result;
}

// 1/n! for the exp kernel; the reduced argument is at most ln2/2 ≈ 0.347, so
// the series is well inside its comfort zone by the twelfth term.
const F2 = 0.5;
const F3 = 1 / 6;
const F4 = 1 / 24;
const F5 = 1 / 120;
const F6 = 1 / 720;
const F7 = 1 / 5040;
const F8 = 1 / 40320;
const F9 = 1 / 362880;
const F10 = 1 / 3628800;
const F11 = 1 / 39916800;
const F12 = 1 / 479001600;

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;

export function exp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.7) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.floor(x * LOG2E + 0.5);
  const r = x - k * LN2_HI - k * LN2_LO;
  const series =
    1 +
    r *
      (1 +
        r * (F2 + r * (F3 + r * (F4 + r * (F5 + r * (F6 + r * (F7 + r * (F8 + r * (F9 + r * (F10 + r * (F11 + r * F12))))))))))); // prettier-ignore
  return series * pow2(k);
}

export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  // Halve or double into [√0.5, √2), where the atanh series converges fast.
  // Both operations are exact, so the exponent bookkeeping is too.
  let m = x;
  let e = 0;
  while (m >= 1.4142135623730951) {
    m *= 0.5;
    e++;
  }
  while (m < 0.7071067811865476) {
    m *= 2;
    e--;
  }
  const f = (m - 1) / (m + 1);
  const z = f * f;
  // log(m) = 2·atanh(f); |f| <= 0.1716, so nine terms are past the last bit.
  const series =
    2 *
    f *
    (1 + z * (1 / 3 + z * (1 / 5 + z * (1 / 7 + z * (1 / 9 + z * (1 / 11 + z * (1 / 13 + z * (1 / 15 + z / 17))))))));
  return series + e * LN2;
}

export function log2(x: number): number {
  return log(x) * LOG2E;
}

export function pow(base: number, exponent: number): number {
  if (exponent === 0) return 1;
  if (base === 0) return exponent > 0 ? 0 : Infinity;
  if (Number.isNaN(base) || Number.isNaN(exponent)) return NaN;
  // Small integer exponents by multiplication: exact, and the common case
  // (squares, cubes, wave curves) never pays for the series.
  if (Number.isInteger(exponent) && exponent > -64 && exponent < 64) {
    let n = exponent < 0 ? -exponent : exponent;
    let result = 1;
    let b = base;
    while (n > 0) {
      if (n & 1) result *= b;
      b *= b;
      n >>= 1;
    }
    return exponent < 0 ? 1 / result : result;
  }
  if (base < 0) {
    // Only integer exponents have a real result, and those took the branch above.
    return NaN;
  }
  return exp(exponent * log(base));
}

/** Euclidean length. `Math.hypot` is not pinned down either — this is. */
export function hypot(a: number, b: number, c = 0): number {
  return Math.sqrt(a * a + b * b + c * c);
}

/** Frame-rate independent smoothing, deterministic version of `damp`. */
export function dampDet(a: number, b: number, rate: number, dt: number): number {
  return b + (a - b) * exp(-rate * dt);
}
