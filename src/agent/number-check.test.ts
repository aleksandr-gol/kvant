import { describe, expect, test } from 'bun:test';
import { checkAnswerNumbers, extractAnswerNumbers } from './number-check.js';

const tool = JSON.stringify({
  data: {
    quotes: [{ secid: 'SBER', last: 293.27, changePct: -0.67, capitalizationRub: 6325839241920 }],
    rows: [{ metric: 'Чистая прибыль, млрд руб', values: [1707, 1930] }],
    keyRate: { current: { ratePct: 14 } },
  },
});

describe('number check', () => {
  test('extracts numbers with units and skips years and list markers', () => {
    const nums = extractAnswerNumbers('1. В 2025 году прибыль 1 707 млрд ₽, ставка 14%, цена 293,27 ₽ (12.11.2026).');
    expect(nums.map((n) => n.raw)).toEqual(['1 707', '14%', '293,27']);
    expect(nums[0].multiplier).toBe(1e9);
  });

  test('grounds rounded values, unit words and dropped signs', () => {
    const r = checkAnswerNumbers('SBER стоит **293,3 ₽** (снижение 0,67%), капитализация 6,3 трлн ₽, прибыль LTM 1 930 млрд ₽, ключевая 14%.', [tool]);
    expect(r.ungrounded).toEqual([]);
    expect(r.grounded).toBe(r.checked);
  });

  test('reports numbers that are absent from tool data', () => {
    const r = checkAnswerNumbers('Цель по акции — 412 ₽, дивдоходность 15,5%.', [tool]);
    expect(r.ungrounded).toEqual(['412', '15,5%']);
    expect(r.ratio).toBe(0);
  });
});
