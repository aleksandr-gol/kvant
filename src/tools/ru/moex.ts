/**
 * MOEX ISS client (https://iss.moex.com/iss/reference/). Public, keyless,
 * quotes delayed by ~15 minutes without a market-data subscription.
 */
import { fetchJson, MINUTE, HOUR, round } from './http.js';

export const ISS = 'https://iss.moex.com/iss';

type IssBlock = { columns: string[]; data: unknown[][] };
type IssResponse = Record<string, IssBlock>;

export function issTable<T = Record<string, unknown>>(json: IssResponse, block: string): T[] {
  const b = json[block];
  if (!b || !Array.isArray(b.columns) || !Array.isArray(b.data)) return [];
  return b.data.map((row) => Object.fromEntries(b.columns.map((c, i) => [c, row[i]])) as T);
}

function url(path: string, params: Record<string, string | number | undefined> = {}): string {
  const u = new URL(`${ISS}${path}`);
  u.searchParams.set('iss.meta', 'off');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// Instrument resolution
// ---------------------------------------------------------------------------

/** Common colloquial names → MOEX tickers (search handles the long tail). */
const ALIASES: Record<string, string> = {
  'сбер': 'SBER', 'сбербанк': 'SBER', 'сбер преф': 'SBERP', 'сбербанк преф': 'SBERP',
  'газпром': 'GAZP', 'лукойл': 'LKOH', 'роснефть': 'ROSN', 'новатэк': 'NVTK', 'татнефть': 'TATN',
  'сургутнефтегаз': 'SNGS', 'сургут': 'SNGS', 'сургут преф': 'SNGSP', 'газпром нефть': 'SIBN',
  'норникель': 'GMKN', 'норильский никель': 'GMKN', 'полюс': 'PLZL', 'северсталь': 'CHMF',
  'нлмк': 'NLMK', 'ммк': 'MAGN', 'алроса': 'ALRS', 'русал': 'RUAL', 'фосагро': 'PHOR',
  'яндекс': 'YDEX', 'озон': 'OZON', 'т-банк': 'T', 'тинькофф': 'T', 'т-технологии': 'T', 'тбанк': 'T',
  'втб': 'VTBR', 'мосбиржа': 'MOEX', 'московская биржа': 'MOEX', 'мтс': 'MTSS', 'ростелеком': 'RTKM',
  'магнит': 'MGNT', 'x5': 'X5', 'икс5': 'X5', 'х5': 'X5', 'аэрофлот': 'AFLT', 'интер рао': 'IRAO',
  'русгидро': 'HYDR', 'фск': 'FEES', 'россети': 'FEES', 'самолет': 'SMLT', 'пик': 'PIKK', 'лср': 'LSRG',
  'совкомбанк': 'SVCB', 'мтс банк': 'MBNK', 'хэдхантер': 'HEAD', 'headhunter': 'HEAD', 'хх': 'HEAD',
  'позитив': 'POSI', 'positive technologies': 'POSI', 'астра': 'ASTR', 'группа астра': 'ASTR',
  'whoosh': 'WUSH', 'вуш': 'WUSH', 'сегежа': 'SGZH', 'система': 'AFKS', 'афк система': 'AFKS',
  'транснефть': 'TRNFP', 'башнефть': 'BANE', 'ленэнерго': 'LSNGP', 'юнипро': 'UPRO', 'мечел': 'MTLR',
  'en+': 'ENPG', 'эн+': 'ENPG', 'селигдар': 'SELG', 'южуралзолото': 'UGLD', 'мать и дитя': 'MDMG',
  'европлан': 'LEAS', 'ренессанс': 'RENI', 'диасофт': 'DIAS', 'софтлайн': 'SOFL', 'iva': 'IVAT',
  'индекс мосбиржи': 'IMOEX', 'индекс мосбиржи полной доходности': 'MCFTR', 'индекс офз': 'RGBI',
  'юань': 'CNYRUB_TOM', 'юань рубль': 'CNYRUB_TOM', 'cny': 'CNYRUB_TOM', 'золото': 'GLDRUB_TOM',
  'мкб': 'CBOM', 'московский кредитный банк': 'CBOM', 'бсп': 'BSPB', 'банк санкт-петербург': 'BSPB',
  'домклик': 'DOMRF', 'дом.рф': 'DOMRF', 'дом рф': 'DOMRF',
  // Модели нередко пишут названия латиницей («T-BANK», «Sberbank») — такие тикеры биржа не знает.
  't-bank': 'T', 'tbank': 'T', 't bank': 'T', 'tinkoff': 'T', 't-technologies': 'T', 'tcs group': 'T',
  'sber': 'SBER', 'sberbank': 'SBER', 'vtb': 'VTBR', 'gazprom': 'GAZP', 'lukoil': 'LKOH', 'rosneft': 'ROSN',
  'novatek': 'NVTK', 'tatneft': 'TATN', 'surgutneftegas': 'SNGS', 'nornickel': 'GMKN', 'norilsk nickel': 'GMKN',
  'polyus': 'PLZL', 'severstal': 'CHMF', 'alrosa': 'ALRS', 'rusal': 'RUAL', 'phosagro': 'PHOR', 'yandex': 'YDEX',
  'ozon': 'OZON', 'moscow exchange': 'MOEX', 'mts': 'MTSS', 'rostelecom': 'RTKM', 'magnit': 'MGNT', 'aeroflot': 'AFLT',
  'inter rao': 'IRAO', 'rushydro': 'HYDR', 'samolet': 'SMLT', 'pik': 'PIKK', 'sovcombank': 'SVCB', 'mkb': 'CBOM',
  'credit bank of moscow': 'CBOM', 'mts bank': 'MBNK', 'mosenergo': 'MSNG',
  // Старые тикеры после редомициляции: отчётность и торги идут под новыми кодами.
  'tcsg': 'T', 'yndx': 'YDEX', 'five': 'X5', 'agro': 'RAGR', 'hhru': 'HEAD',
};

export function aliasFor(raw: string): string | undefined {
  const key = raw.toLowerCase().replace(/ё/g, 'е').replace(/[«»"']/g, '').replace(/^пао\s+/, '').replace(/\s+/g, ' ').trim();
  return ALIASES[key] ?? ALIASES[key.replace(/_/g, '-')];
}

export interface Instrument {
  secid: string;
  name: string;
  shortName: string;
  isin: string | null;
  group: string | null;
  type: string | null;
  board: string;
  market: string;
  engine: string;
  currency: string | null;
}

interface BoardRow {
  secid: string;
  boardid: string;
  market: string;
  engine: string;
  is_primary: number;
  is_traded: number;
  currencyid: string | null;
}

export async function getInstrument(secid: string): Promise<Instrument | null> {
  const json = await fetchJson<IssResponse>(
    url(`/securities/${encodeURIComponent(secid)}.json`, { 'iss.only': 'description,boards' }),
    { ttlMs: 12 * HOUR },
  );
  const desc = Object.fromEntries(issTable<{ name: string; value: string }>(json, 'description').map((r) => [r.name, r.value]));
  const boards = issTable<BoardRow>(json, 'boards');
  if (!desc.SECID || boards.length === 0) return null;
  const primary = boards.find((b) => b.is_primary === 1 && b.is_traded === 1)
    ?? boards.find((b) => b.is_primary === 1)
    ?? boards.find((b) => b.is_traded === 1)
    ?? boards[0];
  return {
    secid: desc.SECID,
    name: desc.NAME ?? desc.SHORTNAME ?? secid,
    shortName: desc.SHORTNAME ?? secid,
    isin: desc.ISIN ?? null,
    group: desc.GROUP ?? null,
    type: desc.TYPENAME ?? desc.TYPE ?? null,
    board: primary.boardid,
    market: primary.market,
    engine: primary.engine,
    currency: primary.currencyid,
  };
}

export interface SearchHit {
  secid: string;
  shortname: string;
  name: string;
  isin: string | null;
  is_traded: number;
  group: string;
  primary_boardid: string | null;
}

const GROUP_PRIORITY = ['stock_shares', 'stock_dr', 'stock_ppif', 'stock_etf', 'stock_bonds', 'stock_index', 'currency_selt'];

export async function searchInstruments(query: string, limit = 10): Promise<SearchHit[]> {
  const json = await fetchJson<IssResponse>(
    url('/securities.json', {
      q: query,
      limit: 50,
      'securities.columns': 'secid,shortname,name,isin,is_traded,group,primary_boardid',
    }),
    { ttlMs: 6 * HOUR },
  );
  const hits = issTable<SearchHit>(json, 'securities').filter((h) => h.is_traded === 1);
  const rank = (h: SearchHit) => {
    const g = GROUP_PRIORITY.indexOf(h.group);
    // Fixing/iNAV pseudo-indices clutter results for company names.
    const pseudo = /^(FIX|INAV)/i.test(h.secid) || /iNAV|Фиксинг/i.test(h.shortname) ? 50 : 0;
    return (g === -1 ? 20 : g) + pseudo;
  };
  return hits.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

/** Resolve a ticker, ISIN or company name to a traded instrument. */
export async function resolveInstrument(query: string): Promise<Instrument> {
  const raw = query.trim();
  const alias = aliasFor(raw);
  const candidate = alias ?? raw.toUpperCase();
  if (/^[A-Z0-9_.\-]{1,20}$/.test(candidate)) {
    const direct = await getInstrument(candidate).catch(() => null);
    if (direct) return direct;
  }
  const hits = await searchInstruments(raw, 5);
  if (hits.length === 0) {
    throw new Error(`Инструмент «${raw}» не найден на Мосбирже. Не угадывай тикер: передай название компании по-русски (например «Т-Банк», «Мосбиржа») или вызови find_instrument.`);
  }
  const resolved = await getInstrument(hits[0].secid);
  if (!resolved) throw new Error(`Не удалось получить данные по «${raw}»`);
  return resolved;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface Quote {
  secid: string;
  isin: string | null;
  name: string;
  board: string;
  kind: 'share' | 'bond' | 'index' | 'currency' | 'fund' | 'other';
  currency: string | null;
  last: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  valueTodayRub: number | null;
  capitalizationRub: number | null;
  lotSize: number | null;
  updated: string | null;
  bond?: {
    yieldPct: number | null;
    durationDays: number | null;
    maturity: string | null;
    couponPct: number | null;
    couponValue: number | null;
    nextCoupon: string | null;
    accruedInterest: number | null;
    faceValue: number | null;
    pricePctOfFace: number | null;
  };
}

function kindOf(inst: Instrument): Quote['kind'] {
  if (inst.market === 'bonds') return 'bond';
  if (inst.market === 'index') return 'index';
  if (inst.engine === 'currency') return 'currency';
  if (inst.group === 'stock_ppif' || inst.group === 'stock_etf' || inst.board === 'TQTF') return 'fund';
  if (inst.market === 'shares') return 'share';
  return 'other';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function getQuote(query: string): Promise<Quote> {
  const inst = await resolveInstrument(query);
  const json = await fetchJson<IssResponse>(
    url(`/engines/${inst.engine}/markets/${inst.market}/boards/${inst.board}/securities/${inst.secid}.json`),
    { ttlMs: MINUTE },
  );
  const sec = issTable(json, 'securities')[0] ?? {};
  const md = issTable(json, 'marketdata')[0] ?? {};
  const kind = kindOf(inst);
  const last = num(md.LAST) ?? num(md.CURRENTVALUE) ?? num(md.MARKETPRICE) ?? num(md.LCURRENTPRICE) ?? num(sec.PREVPRICE) ?? num(md.LASTVALUE);
  const quote: Quote = {
    secid: inst.secid,
    isin: inst.isin,
    name: inst.name,
    board: inst.board,
    kind,
    currency: (sec.CURRENCYID as string) ?? inst.currency,
    last,
    changePct: num(md.LASTTOPREVPRICE) ?? num(md.LASTCHANGEPRC) ?? num(md.LASTCHANGEPRCNT),
    open: num(md.OPEN) ?? num(md.OPENVALUE),
    high: num(md.HIGH),
    low: num(md.LOW),
    prevClose: num(sec.PREVPRICE) ?? num(md.LASTVALUE),
    valueTodayRub: num(md.VALTODAY_RUR) ?? num(md.VALTODAY),
    capitalizationRub: num(md.ISSUECAPITALIZATION),
    lotSize: num(sec.LOTSIZE),
    updated: (md.SYSTIME as string) ?? (md.UPDATETIME as string) ?? null,
  };
  if (kind === 'bond') {
    const y = issTable(json, 'marketdata_yields')[0] ?? {};
    quote.bond = {
      yieldPct: num(y.EFFECTIVEYIELD) ?? num(md.YIELD) ?? num(sec.YIELDATPREVWAPRICE),
      durationDays: num(y.DURATION) ?? num(md.DURATION),
      maturity: (sec.MATDATE as string) ?? null,
      couponPct: num(sec.COUPONPERCENT),
      couponValue: num(sec.COUPONVALUE),
      nextCoupon: (sec.NEXTCOUPON as string) ?? null,
      accruedInterest: num(sec.ACCRUEDINT),
      faceValue: num(sec.FACEVALUE),
      pricePctOfFace: last,
    };
  }
  return quote;
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  valueRub: number | null;
  volume: number | null;
}

const INTERVALS = { day: 24, week: 7, month: 31 } as const;
export type CandleInterval = keyof typeof INTERVALS;

export async function getCandles(
  query: string,
  from: string,
  till?: string,
  interval: CandleInterval = 'day',
): Promise<{ instrument: Instrument; candles: Candle[] }> {
  const inst = await resolveInstrument(query);
  const candles: Candle[] = [];
  let start = 0;
  // ISS pages candles by 500 rows.
  for (let page = 0; page < 20; page++) {
    const json = await fetchJson<IssResponse>(
      url(`/engines/${inst.engine}/markets/${inst.market}/boards/${inst.board}/securities/${inst.secid}/candles.json`, {
        from,
        till,
        interval: INTERVALS[interval],
        start,
      }),
      { ttlMs: 10 * MINUTE },
    );
    const rows = issTable<{ open: number; high: number; low: number; close: number; value: number; volume: number; begin: string }>(json, 'candles');
    for (const r of rows) {
      candles.push({ date: r.begin.slice(0, 10), open: r.open, high: r.high, low: r.low, close: r.close, valueRub: num(r.value), volume: num(r.volume) });
    }
    if (rows.length < 500) break;
    start += rows.length;
  }
  return { instrument: inst, candles };
}

export interface SeriesStats {
  periodReturnPct: number | null;
  annualizedVolatilityPct: number | null;
  maxDrawdownPct: number | null;
  minClose: number | null;
  maxClose: number | null;
  firstDate: string | null;
  lastDate: string | null;
}

export function seriesStats(candles: Candle[], periodsPerYear = 252): SeriesStats {
  if (candles.length === 0) {
    return { periodReturnPct: null, annualizedVolatilityPct: null, maxDrawdownPct: null, minClose: null, maxClose: null, firstDate: null, lastDate: null };
  }
  const closes = candles.map((c) => c.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1);
  let peak = closes[0];
  let maxDd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    maxDd = Math.min(maxDd, c / peak - 1);
  }
  return {
    periodReturnPct: round((closes[closes.length - 1] / closes[0] - 1) * 100),
    annualizedVolatilityPct: rets.length > 1 ? round(Math.sqrt(variance * periodsPerYear) * 100) : null,
    maxDrawdownPct: round(maxDd * 100),
    minClose: Math.min(...closes),
    maxClose: Math.max(...closes),
    firstDate: candles[0].date,
    lastDate: candles[candles.length - 1].date,
  };
}

/** Keep at most `max` evenly spaced rows (always including the last one). */
export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows[rows.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Bonds and yield curve
// ---------------------------------------------------------------------------

export interface BondRow {
  secid: string;
  name: string;
  isin: string | null;
  board: string;
  maturity: string | null;
  yearsToMaturity: number | null;
  couponPct: number | null;
  couponValue: number | null;
  nextCoupon: string | null;
  couponPeriodDays: number | null;
  pricePct: number | null;
  yieldPct: number | null;
  durationYears: number | null;
  faceValue: number | null;
  faceUnit: string | null;
  valueTodayRub: number | null;
  listLevel: number | null;
  bondType: string | null;
}

export async function listBonds(board: 'TQOB' | 'TQCB' | 'TQIR'): Promise<BondRow[]> {
  const json = await fetchJson<IssResponse>(
    url(`/engines/stock/markets/bonds/boards/${board}/securities.json`, { 'iss.only': 'securities,marketdata,marketdata_yields' }),
    { ttlMs: 10 * MINUTE },
  );
  const md = new Map(issTable(json, 'marketdata').map((r) => [r.SECID as string, r]));
  const yields = new Map(issTable(json, 'marketdata_yields').map((r) => [r.SECID as string, r]));
  const now = Date.now();
  return issTable(json, 'securities').map((s) => {
    const secid = s.SECID as string;
    const m = md.get(secid) ?? {};
    const y = yields.get(secid) ?? {};
    const maturity = (s.MATDATE as string) || null;
    const years = maturity && maturity !== '0000-00-00' ? (Date.parse(maturity) - now) / (365.25 * 86_400_000) : null;
    const duration = num(y.DURATION) ?? num(m.DURATION);
    return {
      secid,
      name: (s.SHORTNAME as string) ?? secid,
      isin: (s.ISIN as string) ?? null,
      board,
      maturity,
      yearsToMaturity: round(years, 2),
      couponPct: num(s.COUPONPERCENT),
      couponValue: num(s.COUPONVALUE),
      nextCoupon: (s.NEXTCOUPON as string) ?? null,
      couponPeriodDays: num(s.COUPONPERIOD),
      pricePct: num(m.LAST) ?? num(m.MARKETPRICE) ?? num(s.PREVPRICE),
      yieldPct: num(y.EFFECTIVEYIELD) ?? num(m.YIELD) ?? num(s.YIELDATPREVWAPRICE),
      durationYears: duration != null ? round(duration / 365.25, 2) : null,
      faceValue: num(s.FACEVALUE),
      faceUnit: (s.FACEUNIT as string) ?? null,
      valueTodayRub: num(m.VALTODAY),
      listLevel: num(s.LISTLEVEL),
      bondType: (s.BONDTYPE as string) ?? null,
    };
  });
}

export async function getCouponSchedule(secid: string): Promise<Array<{ date: string; valueRub: number | null; ratePct: number | null }>> {
  const json = await fetchJson<IssResponse>(
    url(`/statistics/engines/stock/markets/bonds/bondization/${encodeURIComponent(secid)}.json`, { 'iss.only': 'coupons', limit: 100 }),
    { ttlMs: 6 * HOUR },
  );
  return issTable(json, 'coupons').map((c) => ({
    date: c.coupondate as string,
    valueRub: num(c.value_rub) ?? num(c.value),
    ratePct: num(c.valueprc),
  }));
}

export interface YieldCurvePoint {
  years: number;
  yieldPct: number;
}

/** Zero-coupon OFZ yield curve (G-curve) published by MOEX. */
export async function getZeroCouponCurve(): Promise<{ date: string | null; points: YieldCurvePoint[] }> {
  const json = await fetchJson<IssResponse>(url('/engines/stock/zcyc.json'), { ttlMs: 30 * MINUTE });
  const rows = issTable<{ tradedate: string; period: number; value: number }>(json, 'yearyields');
  return {
    date: rows[0]?.tradedate ?? null,
    points: rows.map((r) => ({ years: r.period, yieldPct: r.value })),
  };
}

export function interpolateCurve(points: YieldCurvePoint[], years: number): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.years - b.years);
  if (years <= sorted[0].years) return sorted[0].yieldPct;
  for (let i = 1; i < sorted.length; i++) {
    if (years <= sorted[i].years) {
      const a = sorted[i - 1];
      const b = sorted[i];
      return a.yieldPct + ((years - a.years) / (b.years - a.years)) * (b.yieldPct - a.yieldPct);
    }
  }
  return sorted[sorted.length - 1].yieldPct;
}

// ---------------------------------------------------------------------------
// Exchange news
// ---------------------------------------------------------------------------

export async function getExchangeNews(limit = 20): Promise<Array<{ id: number; title: string; published: string; url: string }>> {
  const json = await fetchJson<IssResponse>(url('/sitenews.json', { limit }), { ttlMs: 5 * MINUTE });
  return issTable<{ id: number; title: string; published_at: string }>(json, 'sitenews').map((n) => ({
    id: n.id,
    title: n.title,
    published: n.published_at,
    url: `https://www.moex.com/n${n.id}`,
  }));
}
