/**
 * smart-lab.ru tables: IFRS fundamentals, dividend history and the market-wide
 * multiples table. Public HTML; cached for hours to stay polite.
 */
import { parseHTML } from 'linkedom';
import { fetchText, HOUR, parseRuNumber, ruDateToIso } from './http.js';

const BASE = 'https://smart-lab.ru';

function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Rows as text cells; colspan cells are repeated so columns line up. */
function tableRows(table: Element): string[][] {
  return [...table.querySelectorAll('tr')].map((tr) => {
    const out: string[] = [];
    for (const cell of [...tr.querySelectorAll('th,td')]) {
      const span = Math.max(1, Math.min(20, Number(cell.getAttribute('colspan')) || 1));
      const text = cellText(cell);
      for (let i = 0; i < span; i++) out.push(text);
    }
    return out;
  });
}

function findTable(html: string, selector: string): Element | null {
  const { document } = parseHTML(html);
  return document.querySelector(selector);
}

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

export interface Fundamentals {
  ticker: string;
  title: string;
  period: 'year' | 'quarter';
  columns: string[];
  rows: Array<{ metric: string; values: Array<number | null> }>;
  url: string;
}

const SKIP_METRICS = new Set([
  'Финансовый отчет', 'Годовой отчет', 'Презентация', 'Валюта отчета', '',
  // smart-lab's own IR scoring, not company data
  'IR рейтинг', 'Качество фин.отчетности', 'Презентации для инвесторов', 'Присутствие на смартлабе',
  'Сайт для инвесторов', 'Календарь инвесторов', 'Обратная связь',
]);

export function parseFundamentals(html: string, ticker: string, period: 'year' | 'quarter', pageUrl: string, lastN = 6): Fundamentals {
  const table = findTable(html, 'table.financials');
  if (!table) throw new Error(`На smart-lab нет отчётности МСФО для ${ticker}`);
  const rows = tableRows(table);
  const headerIdx = rows.findIndex((r) => r.some((c) => /^\d{4}(Q\d)?$/.test(c)));
  if (headerIdx < 0) throw new Error(`Не удалось разобрать таблицу отчётности ${ticker}`);
  const header = rows[headerIdx];
  // Period columns are the cells that look like "2024", "2025Q2" or "LTM".
  const colIdx: number[] = [];
  const columns: string[] = [];
  header.forEach((c, i) => {
    const label = c.replace(/\s*\?$/, '').trim();
    if (/^\d{4}(Q\d)?$/.test(label) || label === 'LTM') {
      colIdx.push(i);
      columns.push(label);
    }
  });
  const keep = colIdx.length > lastN ? colIdx.length - lastN : 0;
  const keptIdx = colIdx.slice(keep);
  const keptCols = columns.slice(keep);

  const out: Fundamentals['rows'] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const metric = (r[0] ?? '').replace(/\s*\?$/, '').trim();
    if (SKIP_METRICS.has(metric) || r.length < header.length - 2) continue;
    if (metric === 'Дата отчета') continue;
    const values = keptIdx.map((i) => parseRuNumber(r[i]));
    if (values.every((v) => v === null)) continue;
    out.push({ metric, values });
  }
  const title = (parseHTML(html).document.querySelector('h1')?.textContent ?? ticker).trim();
  return { ticker, title, period, columns: keptCols, rows: out, url: pageUrl };
}

export async function getFundamentals(ticker: string, period: 'year' | 'quarter' = 'year'): Promise<Fundamentals> {
  const pageUrl = `${BASE}/q/${encodeURIComponent(ticker)}/f/${period === 'year' ? 'y' : 'q'}/`;
  const html = await fetchText(pageUrl, { ttlMs: 6 * HOUR });
  return parseFundamentals(html, ticker, period, pageUrl);
}

// Модель часто просит строки по-английски («Revenue», «Net income») — переводим в названия smart-lab.
const METRIC_SYNONYMS: Array<[RegExp, string[]]> = [
  [/revenue|sales|turnover/, ['выручка']],
  [/net (income|profit)|earnings/, ['чистая прибыль']],
  [/operating (income|profit)/, ['операционная прибыль']],
  [/^profit$|income/, ['прибыль']],
  [/operating cash|ocf/, ['опер.денежный поток']],
  [/free cash|fcf/, ['fcf']],
  [/net debt/, ['чистый долг']],
  [/debt|leverage/, ['долг']],
  [/cash/, ['наличность']],
  [/dividend|payout/, ['див']],
  [/margin/, ['рентаб', 'маржа']],
  [/asset/, ['активы']],
  [/equity|book value/, ['капитал', 'баланс стоимость']],
  [/market cap|capitali/, ['капитализация']],
  [/^pe$|p\/e|price.to.earn/, ['p/e']],
  [/^pb$|p\/b|price.to.book/, ['p/bv', 'p/b']],
  [/ev.?ebitda/, ['ev/ebitda']],
  [/interest/, ['процентн']],
  [/loan/, ['кредит']],
  [/deposit/, ['депозит']],
  [/expense|cost/, ['расход', 'себестоимость']],
  [/employee|headcount|staff/, ['персонал']],
];

/** Оставляет строки, подходящие под запрошенные метрики; если не подошло ничего — вся таблица с пометкой, чтобы модель не решила, что данных нет. */
export function filterMetricRows<T extends { metric: string }>(rows: T[], metrics?: string[]): { rows: T[]; note?: string } {
  const wanted = (metrics ?? []).map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return { rows };
  const terms = new Set<string>();
  for (const m of wanted) {
    terms.add(m);
    for (const [re, ru] of METRIC_SYNONYMS) if (re.test(m)) ru.forEach((t) => terms.add(t));
  }
  const matched = rows.filter((r) => {
    const name = r.metric.toLowerCase();
    return [...terms].some((t) => name.includes(t));
  });
  if (matched.length) return { rows: matched };
  return { rows, note: `Строк «${metrics!.join(', ')}» нет — показана вся таблица, названия строк на русском.` };
}

// ---------------------------------------------------------------------------
// Dividends
// ---------------------------------------------------------------------------

export interface DividendRow {
  ticker: string;
  lastBuyDate: string | null;
  recordDate: string | null;
  period: string;
  dividendRub: number | null;
  priceAtRecord: number | null;
  yieldPct: number | null;
}

export function parseDividends(html: string): DividendRow[] {
  // На странице до трёх таблиц: «Ожидаемые», «Выплаченные» и сводка по годам (без колонки «Тикер»).
  const { document } = parseHTML(html);
  const out: DividendRow[] = [];
  const seen = new Set<string>();
  for (const table of document.querySelectorAll('table.dividends')) {
    const rows = tableRows(table);
    const headerIdx = rows.findIndex((r) => r.includes('Тикер'));
    if (headerIdx < 0) continue;
    const h = rows[headerIdx];
    const col = (name: string) => h.findIndex((c) => c.toLowerCase().startsWith(name));
    const iTicker = col('тикер');
    const iT1 = col('дата t-1');
    const iRecord = col('дата отсечки');
    const iPeriod = col('период');
    const iDiv = col('дивиденд');
    const iPrice = col('цена');
    const iYield = col('див.доходность');
    for (const r of rows.slice(headerIdx + 1)) {
      if (r.length < h.length - 1 || !r[iTicker]) continue;
      const row: DividendRow = {
        ticker: r[iTicker],
        lastBuyDate: ruDateToIso(r[iT1] ?? ''),
        recordDate: ruDateToIso(r[iRecord] ?? ''),
        period: r[iPeriod] ?? '',
        dividendRub: parseRuNumber(r[iDiv]),
        priceAtRecord: parseRuNumber(r[iPrice]),
        yieldPct: parseRuNumber(r[iYield]),
      };
      const key = `${row.ticker}|${row.recordDate}|${row.dividendRub}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  // Свежие сверху: объявленные, затем история.
  return out.sort((a, b) => (b.recordDate ?? '').localeCompare(a.recordDate ?? ''));
}

export async function getDividends(ticker: string): Promise<{ rows: DividendRow[]; url: string }> {
  const pageUrl = `${BASE}/q/${encodeURIComponent(ticker)}/dividend/`;
  const html = await fetchText(pageUrl, { ttlMs: 6 * HOUR });
  return { rows: parseDividends(html), url: pageUrl };
}

// ---------------------------------------------------------------------------
// Market-wide multiples (screener)
// ---------------------------------------------------------------------------

export interface ScreenerRow {
  name: string;
  ticker: string;
  isBank: boolean;
  capBnRub: number | null;
  evBnRub: number | null;
  revenueBnRub: number | null;
  netIncomeBnRub: number | null;
  divYieldPct: number | null;
  divYieldPrefPct: number | null;
  payoutPct: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  evEbitda: number | null;
  ebitdaMarginPct: number | null;
  debtEbitda: number | null;
  roePct: number | null;
  report: string;
}

export const SCREENER_URL = `${BASE}/q/shares_fundamental/`;

function parseScreenerTable(table: Element, isBank: boolean): ScreenerRow[] {
  const rows = tableRows(table);
  const h = rows[0].map((c) => c.replace(/\s+/g, ' ').toLowerCase());
  const col = (pred: (c: string) => boolean) => h.findIndex(pred);
  const idx = {
    name: col((c) => c === 'название'),
    ticker: col((c) => c === 'тикер'),
    cap: col((c) => c.startsWith('капит')),
    ev: col((c) => c.startsWith('ev ')),
    revenue: col((c) => c.startsWith('выручка') || c.startsWith('чист. опер')),
    net: col((c) => c.startsWith('чистая')),
    dy: col((c) => c.startsWith('дд ао')),
    dyp: col((c) => c.startsWith('дд ап')),
    payout: col((c) => c.startsWith('дд/чп')),
    pe: col((c) => c === 'p/e'),
    ps: col((c) => c === 'p/s'),
    pb: col((c) => c === 'p/b'),
    evEbitda: col((c) => c === 'ev/ebitda'),
    margin: col((c) => c.startsWith('рентаб')),
    debt: col((c) => c.startsWith('долг/ebitda')),
    roe: col((c) => c === 'roe'),
    report: col((c) => c === 'отчет'),
  };
  const at = (r: string[], i: number) => (i >= 0 ? r[i] : undefined);
  return rows
    .slice(1)
    .filter((r) => at(r, idx.ticker))
    .map((r) => ({
      name: r[idx.name],
      ticker: r[idx.ticker],
      isBank,
      capBnRub: parseRuNumber(at(r, idx.cap)),
      evBnRub: parseRuNumber(at(r, idx.ev)),
      revenueBnRub: parseRuNumber(at(r, idx.revenue)),
      netIncomeBnRub: parseRuNumber(at(r, idx.net)),
      divYieldPct: parseRuNumber(at(r, idx.dy)),
      divYieldPrefPct: parseRuNumber(at(r, idx.dyp)),
      payoutPct: parseRuNumber(at(r, idx.payout)),
      pe: parseRuNumber(at(r, idx.pe)),
      ps: parseRuNumber(at(r, idx.ps)),
      pb: parseRuNumber(at(r, idx.pb)),
      evEbitda: parseRuNumber(at(r, idx.evEbitda)),
      ebitdaMarginPct: parseRuNumber(at(r, idx.margin)),
      debtEbitda: parseRuNumber(at(r, idx.debt)),
      roePct: parseRuNumber(at(r, idx.roe)),
      report: at(r, idx.report) ?? '',
    }));
}

/** The page holds two tables: non-financial companies, then banks (different columns). */
export function parseScreener(html: string): ScreenerRow[] {
  const { document } = parseHTML(html);
  const tables = [...document.querySelectorAll('table.trades-table')];
  if (tables.length === 0) throw new Error('Не удалось разобрать таблицу мультипликаторов smart-lab');
  return tables.flatMap((t) => {
    const header = (t.querySelector('tr')?.textContent ?? '').toLowerCase();
    return parseScreenerTable(t, header.includes('roe'));
  });
}

export async function getScreenerTable(): Promise<ScreenerRow[]> {
  const html = await fetchText(SCREENER_URL, { ttlMs: 6 * HOUR });
  return parseScreener(html);
}
