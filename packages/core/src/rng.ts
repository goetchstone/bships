/**
 * Deterministic seeded PRNG (mulberry32). Every source of randomness in
 * the simulation draws from one of these so that a (seed, inputs) pair
 * fully determines a match — the basis for server/client agreement and
 * replays.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Serializable state for replays / reconnects. */
  getState(): number {
    return this.state;
  }

  static fromState(state: number): Rng {
    const rng = new Rng(0);
    rng.state = state >>> 0;
    return rng;
  }
}
