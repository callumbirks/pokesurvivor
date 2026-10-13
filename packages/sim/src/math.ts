export const TAU = 6.2832; // legacy used this literal for a full turn; kept for parity

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

/** Unit vector, or [0, 0] for a null one. */
export function norm(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  return m > 1e-6 ? [x / m, y / m] : [0, 0];
}

/** Frame-rate independent approach of `a` towards `b`. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  b + (a - b) * Math.exp(-rate * dt);

/** Deterministic 2D hash → [0, 1) (legacy `G.U.hash`; map generation depends on it). */
export function hash2(x: number, y: number, seed = 0): number {
  let h =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Squared distance from point (cx, cy) to segment (ax, ay)–(bx, by). */
export function segDist2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((cx - ax) * dx + (cy - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - cx;
  const qy = ay + dy * t - cy;
  return qx * qx + qy * qy;
}

/** Is (x, y) within `half` radians of direction `aim` seen from (px, py)? */
export function inArc(px: number, py: number, x: number, y: number, aim: number, half: number) {
  const a = Math.atan2(y - py, x - px);
  return Math.abs(((a - aim + Math.PI * 3) % TAU) - Math.PI) <= half;
}
