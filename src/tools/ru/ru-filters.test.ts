import { describe, expect, test } from 'bun:test';
import { filterMetricRows, type ScreenerRow } from './smartlab.js';
import { screenerOutlierReason } from './tools.js';

const rows = [
  { metric: 'Выручка на 1м2, тыс руб', values: [304] },
  { metric: 'Выручка, млрд руб', values: [3509] },
  { metric: 'Чистая прибыль, млрд руб', values: [-30.9] },
  { metric: 'P/BV', values: [1.1] },
];

describe('filterMetricRows', () => {
  test('без фильтра — вся таблица', () => {
    expect(filterMetricRows(rows).rows).toHaveLength(4);
  });
  test('английские названия переводятся', () => {
    expect(filterMetricRows(rows, ['Revenue']).rows.map((r) => r.metric)).toEqual(['Выручка на 1м2, тыс руб', 'Выручка, млрд руб']);
    expect(filterMetricRows(rows, ['Net income']).rows.map((r) => r.metric)).toEqual(['Чистая прибыль, млрд руб']);
    expect(filterMetricRows(rows, ['P/B']).rows.map((r) => r.metric)).toEqual(['P/BV']);
  });
  test('ничего не нашлось — вся таблица с пометкой, а не пустой ответ', () => {
    const out = filterMetricRows(rows, ['Gross bookings']);
    expect(out.rows).toHaveLength(4);
    expect(out.note).toContain('Gross bookings');
  });
});

describe('screenerOutlierReason', () => {
  const base: ScreenerRow = { ticker: 'X', name: 'X', isBank: false, capBnRub: 100, evBnRub: null, revenueBnRub: null, netIncomeBnRub: null, divYieldPct: 12, pe: 5, ps: null, pb: 1, evEbitda: 3, ebitdaMarginPct: null, debtEbitda: null, roePct: null } as unknown as ScreenerRow;
  test('нормальная бумага проходит', () => expect(screenerOutlierReason(base)).toBeNull());
  test('дивдоходность 134% — выброс', () => expect(screenerOutlierReason({ ...base, divYieldPct: 134 })).toContain('разовая'));
  test('P/E 0,5 — выброс', () => expect(screenerOutlierReason({ ...base, pe: 0.5 })).toContain('P/E'));
  test('капитализация 1 млрд — выброс', () => expect(screenerOutlierReason({ ...base, capBnRub: 1 })).toContain('ликвид'));
});

import { dividendSummary } from './tools.js';

describe('dividendSummary', () => {
  const row = (recordDate: string, dividendRub: number) => ({ ticker: 'LKOH', lastBuyDate: null, recordDate, period: '', dividendRub, priceAtRecord: null, yieldPct: null });
  test('сумма за 12 месяцев и объявленные отдельно', () => {
    const s = dividendSummary([row('2026-12-20', 535), row('2026-06-03', 541), row('2025-12-25', 397), row('2025-06-01', 514)], '2026-11-11', 5924.5);
    expect(s.paidLast12mRub).toBe(938);
    expect(s.paidLast12mPayments).toBe(2);
    expect(s.paidLast12mYieldPct).toBe(15.8);
    expect(s.declaredUpcomingRub).toBe(535);
    expect(s.declaredUpcomingYieldPct).toBe(9);
  });
  test('без цены доходность не считается', () => {
    expect(dividendSummary([row('2026-06-03', 10)], '2026-11-11', null).paidLast12mYieldPct).toBeNull();
  });
});

import { aliasFor } from './moex.js';

describe('aliasFor', () => {
  test('латиница, кавычки, ПАО и подчёркивания', () => {
    expect(aliasFor('T-BANK')).toBe('T');
    expect(aliasFor('T_BANK')).toBe('T');
    expect(aliasFor('«МКБ»')).toBe('CBOM');
    expect(aliasFor('ПАО Сбербанк')).toBe('SBER');
    expect(aliasFor('Самолёт')).toBe('SMLT');
    expect(aliasFor('TCSG')).toBe('T');
    expect(aliasFor('XYZ')).toBeUndefined();
  });
});
