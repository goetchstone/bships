/**
 * Deterministic math for the simulation.
 *
 * IEEE 754 guarantees bit-identical results across JS engines for
 * +, -, *, /, and Math.sqrt — but NOT for transcendental functions
 * (Math.sin/cos/atan2 may differ between V8, JSC, and SpiderMonkey).
 * The simulation must produce identical states on server and every
 * client, so all angle math goes through these polynomial
 * approximations instead of Math.*.
 *
 * Accuracy is ~4e-6 absolute error: far below anything gameplay can
 * observe, while staying pure arithmetic and therefore deterministic.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap an angle to [-PI, PI). */
export function wrapAngle(x: number): number {
  let a = x % TWO_PI;
  if (a >= PI) a -= TWO_PI;
  else if (a < -PI) a += TWO_PI;
  return a;
}

/** Odd Taylor kernel for sin on [-PI/2, PI/2]. */
function sinKernel(x: number): number {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880)))));
}

/** Deterministic sine. */
export function dSin(x: number): number {
  let a = wrapAngle(x);
  // Fold into [-PI/2, PI/2] where the kernel is accurate.
  if (a > HALF_PI) a = PI - a;
  else if (a < -HALF_PI) a = -PI - a;
  return sinKernel(a);
}

/** Deterministic cosine. */
export function dCos(x: number): number {
  return dSin(x + HALF_PI);
}

/** atan kernel on [0, 1] (Medina minimax-style polynomial). */
function atanKernel(z: number): number {
  const z2 = z * z;
  return z * (0.9998660 + z2 * (-0.3302995 + z2 * (0.1801410 + z2 * (-0.0851330 + z2 * 0.0208351))));
}

/** Deterministic atan2 in [-PI, PI]. */
export function dAtan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const swap = ay > ax;
  const z = swap ? ax / ay : ay / ax;
  let r = atanKernel(z);
  if (swap) r = HALF_PI - r;
  if (x < 0) r = PI - r;
  return y < 0 ? -r : r;
}

/** Math.sqrt is correctly rounded per IEEE 754 — safe to re-export. */
export const dSqrt = Math.sqrt;

/** Euclidean distance (deterministic). */
export function dist(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dSqrt(dx * dx + dy * dy);
}
