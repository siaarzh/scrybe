/**
 * Beta module — engine for processing numeric sequences.
 */

export interface BetaConfig {
  multiplier: number;
  offset?: number;
}

export class BetaEngine {
  private multiplier: number;
  private offset: number;

  constructor(config: BetaConfig) {
    this.multiplier = config.multiplier;
    this.offset = config.offset ?? 0;
  }

  /**
   * Transforms each value by applying multiplier and offset.
   */
  transform(values: number[]): number[] {
    return values.map((v) => v * this.multiplier + this.offset);
  }

  /**
   * Returns the sum of all transformed values.
   */
  sum(values: number[]): number {
    return this.transform(values).reduce((acc, v) => acc + v, 0);
  }

  /**
   * Returns the largest transformed value, or null for an empty list.
   */
  max(values: number[]): number | null {
    const transformed = this.transform(values);
    if (transformed.length === 0) return null;
    return Math.max(...transformed);
  }
}
