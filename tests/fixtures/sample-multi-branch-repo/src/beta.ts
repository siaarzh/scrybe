/**
 * Beta module — numeric helpers.
 */

export function double(n: number): number {
  return n * 2;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
