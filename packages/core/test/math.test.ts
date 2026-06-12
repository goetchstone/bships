import { describe, expect, it } from 'vitest';
import { dAtan2, dCos, dSin, PI, Rng, wrapAngle } from '../src/index.js';

describe('deterministic trig', () => {
  it('dSin tracks Math.sin within 5e-6 across full range', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = i * 0.0314159;
      expect(Math.abs(dSin(x) - Math.sin(x))).toBeLessThan(5e-6);
    }
  });

  it('dCos tracks Math.cos within 5e-6 across full range', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = i * 0.0314159;
      expect(Math.abs(dCos(x) - Math.cos(x))).toBeLessThan(5e-6);
    }
  });

  it('dAtan2 tracks Math.atan2 within 1e-4 in all quadrants', () => {
    for (let yi = -10; yi <= 10; yi++) {
      for (let xi = -10; xi <= 10; xi++) {
        if (xi === 0 && yi === 0) continue;
        const expected = Math.atan2(yi * 0.7, xi * 0.7);
        expect(Math.abs(dAtan2(yi * 0.7, xi * 0.7) - expected)).toBeLessThan(1e-4);
      }
    }
  });

  it('wrapAngle maps into [-PI, PI)', () => {
    expect(wrapAngle(3 * PI)).toBeCloseTo(-PI, 10);
    expect(wrapAngle(-3 * PI)).toBeCloseTo(-PI, 10);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('Rng', () => {
  it('same seed produces an identical sequence', () => {
    const a = new Rng(1187);
    const b = new Rng(1187);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('matches golden values (cross-version regression guard)', () => {
    const rng = new Rng(42);
    const seq = [rng.next(), rng.next(), rng.next()];
    expect(seq).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  });

  it('round-trips through serialized state', () => {
    const a = new Rng(7);
    a.next();
    a.next();
    const b = Rng.fromState(a.getState());
    expect(b.next()).toBe(a.next());
  });

  it('int stays within bounds', () => {
    const rng = new Rng(9);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });
});
