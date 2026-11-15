import { describe, expect, test } from 'bun:test';
import { parseRuNumber, ruDateToIso, decodeCp1251 } from './http.js';
import { parseFundamentals, parseDividends, parseScreener } from './smartlab.js';
import { parseKeyRate, parseInflation, parseFxXml } from './cbr.js';
import { parseRss, stems, matches } from './news.js';
import { issTable, seriesStats, downsample, interpolateCurve, type Candle } from './moex.js';

describe('number and date parsing', () => {
  test('Russian number formats', () => {
    expect(parseRuNumber('1 234,5')).toBe(1234.5);
    expect(parseRuNumber('12.5%')).toBe(12.5);
    expect(parseRuNumber('37,64₽')).toBe(37.64);
    expect(parseRuNumber('—')).toBeNull();
    expect(parseRuNumber('')).toBeNull();
    expect(parseRuNumber('-0.3')).toBe(-0.3);
  });
  test('dates', () => {
    expect(ruDateToIso('20.07.2026')).toBe('2026-07-20');
    expect(ruDateToIso('2026-07-20')).toBeNull();
  });
  test('cp1251 decoding', () => {
    // "Доллар США" in windows-1251
    const bytes = new Uint8Array([0xc4, 0xee, 0xeb, 0xeb, 0xe0, 0xf0, 0x20, 0xd1, 0xd8, 0xc0]);
    expect(decodeCp1251(bytes)).toBe('Доллар США');
  });
});

describe('smart-lab', () => {
  const fundamentalsHtml = `<h1>Сбербанк (SBER): годовая финансовая отчетность МСФО</h1>
  <table class="simple-little-table financials">
    <tr class="header_row"><th colspan="2">Сбербанк<span>smart-lab.ru</span></th><td class="chartrow">&nbsp;</td>
      <td><strong>2024</strong></td><td><strong>2025</strong></td><td></td><td>LTM ?</td></tr>
    <tr><th>Дата отчета</th><td></td><td></td><td>27.02.2025</td><td>26.02.2026</td><td></td><td>28.10.2026</td></tr>
    <tr><th>Чистая прибыль, млрд руб</th><td>?</td><td></td><td>1 582</td><td>1 707</td><td></td><td>1 930</td></tr>
    <tr><th>Дивиденд, руб/акцию</th><td>?</td><td></td><td>34.84</td><td>37.64</td><td></td><td>37.64</td></tr>
    <tr><th>Годовой отчет</th><td></td><td></td><td></td><td></td><td></td><td></td></tr>
    <tr><th>IR рейтинг</th><td></td><td></td><td>3.9</td><td>3.9</td><td></td><td>3.9</td></tr>
  </table>`;

  test('fundamentals align values with period columns despite colspan header', () => {
    const f = parseFundamentals(fundamentalsHtml, 'SBER', 'year', 'https://smart-lab.ru/q/SBER/f/y/');
    expect(f.columns).toEqual(['2024', '2025', 'LTM']);
    expect(f.rows).toEqual([
      { metric: 'Чистая прибыль, млрд руб', values: [1582, 1707, 1930] },
      { metric: 'Дивиденд, руб/акцию', values: [34.84, 37.64, 37.64] },
    ]);
  });

  test('dividends table', () => {
    const html = `<table class="simple-little-table financials dividends">
      <tr><th>Тикер</th><th>дата T-1</th><th>дата отсечки</th><th>Период</th><th>дивиденд</th><th>Цена акции</th><th>Див.доходность</th></tr>
      <tr><td>SBER</td><td>17.07.2026</td><td>20.07.2026</td><td>2025 год</td><td>37,64₽</td><td>277,43</td><td>13,6%</td></tr>
    </table>`;
    expect(parseDividends(html)).toEqual([
      { ticker: 'SBER', lastBuyDate: '2026-07-17', recordDate: '2026-07-20', period: '2025 год', dividendRub: 37.64, priceAtRecord: 277.43, yieldPct: 13.6 },
    ]);
  });

  test('dividends: expected and paid tables are both read, newest first', () => {
    const head = '<tr><th>Тикер</th><th>дата T-1</th><th>дата отсечки</th><th>Период</th><th>дивиденд</th><th>Цена акции</th><th>Див.доходность</th></tr>';
    const html = `
    <table class="dividends">${head}<tr><td>LKOH</td><td>08.12.2026</td><td>09.12.2026</td><td>3кв 2026</td><td>535₽</td><td>5931,5</td><td>9%</td></tr></table>
    <table class="dividends">${head}
      <tr><td>LKOH</td><td>02.06.2026</td><td>03.06.2026</td><td>2025 год</td><td>541₽</td><td>6100</td><td>8,9%</td></tr>
      <tr><td>LKOH</td><td>08.12.2026</td><td>09.12.2026</td><td>3кв 2026</td><td>535₽</td><td>5931,5</td><td>9%</td></tr>
    </table>
    <table class="dividends"><tr><th>Год</th><th>2025</th></tr><tr><td>Дивиденд</td><td>1 076</td></tr></table>`;
    const rows = parseDividends(html);
    expect(rows.map((r) => [r.recordDate, r.dividendRub])).toEqual([['2026-12-09', 535], ['2026-06-03', 541]]);
  });

  test('screener merges company and bank tables', () => {
    const html = `
    <table class="simple-little-table little trades-table">
      <tr><th>№</th><th>Название</th><th>Тикер</th><th>Капит-я млрд руб</th><th>EV млрд руб</th><th>Выручка</th><th>Чистая прибыль</th><th>ДД ао, %</th><th>ДД ап, %</th><th>P/E</th><th>P/B</th><th>EV/EBITDA</th><th>долг/EBITDA</th><th>отчет</th></tr>
      <tr><td>1</td><td>Лукойл</td><td>LKOH</td><td>4 106</td><td>3 828</td><td>3 768</td><td>92.5</td><td>11.4%</td><td></td><td>44.4</td><td>1.3</td><td>4.3</td><td>-0.3</td><td>2025-МСФО</td></tr>
      <tr><td>3</td><td>РЖД</td><td></td><td>3 464</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
    </table>
    <table class="simple-little-table little trades-table">
      <tr><th>№</th><th>Название</th><th>Тикер</th><th>Капит-я млрд руб</th><th>Чист. опер.доход</th><th>Чистая прибыль</th><th>ДД ао, %</th><th>ДД ап, %</th><th>P/E</th><th>P/B</th><th>RoE</th><th>отчет</th></tr>
      <tr><td>1</td><td>Сбербанк</td><td>SBER</td><td>6 624</td><td>4 240.0</td><td>1 707.0</td><td>12.8%</td><td>12.8%</td><td>3.9</td><td>0.79</td><td>22.7%</td><td>2025-МСФО</td></tr>
    </table>`;
    const rows = parseScreener(html);
    expect(rows.map((r) => r.ticker)).toEqual(['LKOH', 'SBER']);
    expect(rows[0]).toMatchObject({ isBank: false, capBnRub: 4106, divYieldPct: 11.4, pe: 44.4, debtEbitda: -0.3, roePct: null });
    expect(rows[1]).toMatchObject({ isBank: true, revenueBnRub: 4240, divYieldPct: 12.8, pb: 0.79, roePct: 22.7, evEbitda: null });
  });
});

describe('Bank of Russia', () => {
  test('key rate collapses daily rows into changes', () => {
    const html = `<table class="data"><tr><th>Дата</th><th>Ставка</th></tr>
      <tr><td>10.11.2026</td><td>14,00</td></tr><tr><td>27.07.2026</td><td>14,00</td></tr>
      <tr><td>24.07.2026</td><td>14,25</td></tr><tr><td>22.06.2026</td><td>14,25</td></tr></table>`;
    const r = parseKeyRate(html);
    expect(r.current).toEqual({ date: '2026-11-10', ratePct: 14 });
    expect(r.changes).toEqual([
      { date: '2026-06-22', ratePct: 14.25 },
      { date: '2026-07-27', ratePct: 14 },
    ]);
  });
  test('inflation table', () => {
    const html = `<table class="data"><tr><td>09.2026</td><td>14,00</td><td>6,35</td><td>4,00</td></tr><tr><td>08.2026</td><td>14,00</td><td>6,33</td><td>4,00</td></tr></table>`;
    expect(parseInflation(html)).toEqual([
      { month: '2026-08', keyRatePct: 14, inflationYoYPct: 6.33, targetPct: 4 },
      { month: '2026-09', keyRatePct: 14, inflationYoYPct: 6.35, targetPct: 4 },
    ]);
  });
  test('FX XML', () => {
    const xml = `<ValCurs Date="11.11.2026" name="Foreign Currency Market"><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>82,5486</Value></Valute><Valute ID="R01375"><CharCode>CNY</CharCode><Nominal>1</Nominal><Name>Юань</Name><Value>12,3845</Value></Valute></ValCurs>`;
    expect(parseFxXml(xml)).toEqual({
      date: '2026-11-11',
      rates: [
        { code: 'USD', name: 'Доллар США', nominal: 1, rateRub: 82.5486 },
        { code: 'CNY', name: 'Юань', nominal: 1, rateRub: 12.3845 },
      ],
    });
  });
});

describe('news', () => {
  const rss = `<rss><channel>
    <item><title><![CDATA[ЦБ сохранил ключевую ставку 14%]]></title><link>https://example.ru/a</link><description>Банк России &laquo;взял паузу&raquo;</description><pubDate>Tue, 10 Nov 2026 13:30:00 +0300</pubDate></item>
    <item><title>Карты, оставшиеся у россиян, работают</title><link>https://example.ru/b</link><pubDate>Tue, 10 Nov 2026 12:00:00 +0300</pubDate></item>
  </channel></rss>`;
  test('parses RSS items', () => {
    const items = parseRss(rss, 'Тест');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'ЦБ сохранил ключевую ставку 14%', url: 'https://example.ru/a', published: '2026-11-10T10:30:00.000Z' });
  });
  test('keyword stems match word starts only', () => {
    const items = parseRss(rss, 'Тест');
    const k = stems('ключевая ставка');
    expect(k).toEqual(['ключев', 'став']);
    expect(matches(items[0], k)).toBe(true);
    expect(matches(items[1], k, 'any')).toBe(false); // «оставшиеся» must not match «став»
  });
});

describe('MOEX helpers', () => {
  test('issTable maps columns', () => {
    expect(issTable({ s: { columns: ['A', 'B'], data: [[1, 'x']] } }, 's')).toEqual([{ A: 1, B: 'x' }]);
    expect(issTable({}, 'missing')).toEqual([]);
  });
  test('series stats', () => {
    const c = (date: string, close: number): Candle => ({ date, open: close, high: close, low: close, close, valueRub: null, volume: null });
    const s = seriesStats([c('2026-01-01', 100), c('2026-01-02', 120), c('2026-01-03', 90), c('2026-01-04', 110)]);
    expect(s.periodReturnPct).toBe(10);
    expect(s.maxDrawdownPct).toBe(-25);
    expect(s.minClose).toBe(90);
    expect(s.lastDate).toBe('2026-01-04');
  });
  test('downsample keeps last row', () => {
    const rows = Array.from({ length: 100 }, (_, i) => i);
    const d = downsample(rows, 10);
    expect(d).toHaveLength(10);
    expect(d[d.length - 1]).toBe(99);
  });
  test('curve interpolation', () => {
    const pts = [{ years: 1, yieldPct: 14 }, { years: 3, yieldPct: 16 }];
    expect(interpolateCurve(pts, 2)).toBe(15);
    expect(interpolateCurve(pts, 0.5)).toBe(14);
    expect(interpolateCurve(pts, 10)).toBe(16);
  });
});
