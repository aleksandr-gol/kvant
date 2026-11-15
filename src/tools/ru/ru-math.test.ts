import { describe, expect, test } from 'bun:test';
import { simulate, percentile, probabilityAtLeast, requiredMonthly } from './savings.js';
import { computeBeta, concentration } from './portfolio.js';
import { sectorOf } from './sectors.js';

describe('savings simulation', () => {
  const base = { years: 5, initialRub: 100_000, equityShare: 0, bondYieldPct: 12, equityMonthlyReturns: [0.01], iis: false };

  test('pure bond sleeve compounds deterministically and pays 13% tax on gain', () => {
    const sorted = simulate({ ...base, monthlyRub: 0 });
    const gross = 100_000 * 1.12 ** 5;
    const net = gross - (gross - 100_000) * 0.13;
    expect(percentile(sorted, 0.5)).toBeCloseTo(net, 0);
    expect(percentile(sorted, 0.1)).toBeCloseTo(percentile(sorted, 0.9), 6);
  });

  test('IIS deduction increases the result', () => {
    const withIis = percentile(simulate({ ...base, monthlyRub: 10_000, iis: true }), 0.5);
    const without = percentile(simulate({ ...base, monthlyRub: 10_000 }), 0.5);
    expect(withIis).toBeGreaterThan(without);
  });

  test('probability and required contribution', () => {
    const sorted = [1, 2, 3, 4];
    expect(probabilityAtLeast(sorted, 3)).toBe(0.5);
    expect(probabilityAtLeast(sorted, 10)).toBe(0);
    const goal = 1_000_000;
    const monthly = requiredMonthly(base, goal, 0.5)!;
    expect(percentile(simulate({ ...base, monthlyRub: monthly }), 0.5)).toBeGreaterThanOrEqual(goal);
    expect(percentile(simulate({ ...base, monthlyRub: monthly - 300 }), 0.5)).toBeLessThan(goal);
  });
});

describe('portfolio math', () => {
  test('concentration metrics', () => {
    const c = concentration([50, 30, 20]);
    expect(c.topPositionPct).toBe(50);
    expect(c.top3Pct).toBe(100);
    expect(c.hhi).toBeCloseTo(0.38, 4);
    expect(c.effectiveNumber).toBeCloseTo(2.6, 1);
  });
  test('beta of a scaled market series', () => {
    const market = Array.from({ length: 60 }, (_, i) => Math.sin(i) / 100);
    expect(computeBeta(market.map((m) => 0.5 * m), market)).toBeCloseTo(0.5, 6);
    expect(computeBeta([0.1], [0.1])).toBeNull();
  });
  test('sectors', () => {
    expect(sectorOf('SBER')).toBe('Финансы');
    expect(sectorOf('SU26238RMFS4', 'bond')).toBe('Облигации');
    expect(sectorOf('XXXX')).toBe('Прочее');
  });
});
