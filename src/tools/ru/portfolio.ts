/**
 * Deterministic portfolio check: valuation at market, weights, sector and
 * single-name concentration, 1-year risk vs IMOEX, expected cash yield vs the
 * key rate. The agent explains the numbers; it does not compute them.
 */
import { getQuote, getCandles, seriesStats, type Quote, type Candle } from './moex.js';
import { getScreenerTable, getFundamentals } from './smartlab.js';
import { getKeyRate } from './cbr.js';
import { sectorOf } from './sectors.js';
import { round } from './http.js';

export interface PositionInput {
  ticker: string;
  quantity?: number;
  value_rub?: number;
  avg_price?: number;
}

export interface PositionResult {
  ticker: string;
  name: string;
  kind: Quote['kind'];
  sector: string;
  quantity: number | null;
  price: number | null;
  valueRub: number;
  weightPct: number;
  pnlPct: number | null;
  cashYieldPct: number | null;
  cashYieldSource: string | null;
}

export interface PortfolioReport {
  asOf: string;
  totalValueRub: number;
  cashRub: number;
  positions: PositionResult[];
  sectors: Array<{ sector: string; weightPct: number }>;
  concentration: { positions: number; topPositionPct: number; top3Pct: number; hhi: number; effectiveNumber: number };
  risk1y: {
    portfolioReturnPct: number | null;
    portfolioVolatilityPct: number | null;
    portfolioMaxDrawdownPct: number | null;
    imoexReturnPct: number | null;
    imoexVolatilityPct: number | null;
    beta: number | null;
    coveredWeightPct: number;
  };
  income: { expectedAnnualCashRub: number; expectedCashYieldPct: number | null; keyRatePct: number | null };
  flags: string[];
  errors: string[];
}

function dailyReturns(candles: Candle[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < candles.length; i++) {
    out.set(candles[i].date, candles[i].close / candles[i - 1].close - 1);
  }
  return out;
}

export function computeBeta(asset: number[], market: number[]): number | null {
  if (asset.length < 20 || asset.length !== market.length) return null;
  const ma = market.reduce((a, b) => a + b, 0) / market.length;
  const aa = asset.reduce((a, b) => a + b, 0) / asset.length;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < asset.length; i++) {
    cov += (asset[i] - aa) * (market[i] - ma);
    varM += (market[i] - ma) ** 2;
  }
  return varM > 0 ? cov / varM : null;
}

export function concentration(weights: number[]): PortfolioReport['concentration'] {
  const sorted = [...weights].sort((a, b) => b - a);
  const hhi = weights.reduce((a, w) => a + (w / 100) ** 2, 0);
  return {
    positions: weights.length,
    topPositionPct: round(sorted[0] ?? 0)!,
    top3Pct: round(sorted.slice(0, 3).reduce((a, b) => a + b, 0))!,
    hhi: round(hhi, 4)!,
    effectiveNumber: round(hhi > 0 ? 1 / hhi : 0, 1)!,
  };
}

export async function analyzePortfolio(positions: PositionInput[], cashRub = 0): Promise<PortfolioReport> {
  const errors: string[] = [];
  const [screener, keyRate] = await Promise.all([
    getScreenerTable().catch((e) => {
      errors.push(`Мультипликаторы smart-lab недоступны: ${e instanceof Error ? e.message : e}`);
      return [];
    }),
    getKeyRate(1).catch(() => null),
  ]);
  const divYield = new Map(screener.map((r) => [r.ticker, r]));

  const quoted = await Promise.all(
    positions.map(async (p) => {
      try {
        return { input: p, quote: await getQuote(p.ticker) };
      } catch (e) {
        errors.push(`${p.ticker}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }),
  );

  const rows: Omit<PositionResult, 'weightPct'>[] = [];
  for (const item of quoted) {
    if (!item) continue;
    const { input, quote } = item;
    let unitPrice = quote.last;
    if (quote.kind === 'bond' && quote.bond && unitPrice != null) {
      // Bond prices are quoted in % of face value; add accrued coupon.
      unitPrice = (unitPrice / 100) * (quote.bond.faceValue ?? 1000) + (quote.bond.accruedInterest ?? 0);
    }
    const value = input.value_rub ?? (input.quantity != null && unitPrice != null ? input.quantity * unitPrice : null);
    if (value == null) {
      errors.push(`${input.ticker}: нет ни количества, ни суммы — позиция пропущена`);
      continue;
    }
    let cashYield: number | null = null;
    let cashYieldSource: string | null = null;
    if (quote.kind === 'bond') {
      cashYield = quote.bond?.yieldPct ?? null;
      cashYieldSource = 'доходность к погашению (MOEX)';
    } else if (quote.kind === 'share') {
      const row = divYield.get(quote.secid) ?? divYield.get(quote.secid.replace(/P$/, ''));
      const isPref = quote.secid.endsWith('P') && row?.divYieldPrefPct != null;
      cashYield = isPref ? row!.divYieldPrefPct : row?.divYieldPct ?? null;
      cashYieldSource = cashYield != null ? `дивдоходность (smart-lab, ${row?.report || 'МСФО'})` : null;
      if (cashYield == null) {
        const f = await getFundamentals(quote.secid.replace(/P$/, '')).catch(() => null);
        const dy = f?.rows.find((r) => r.metric.startsWith(isPref || quote.secid.endsWith('P') ? 'Див доход, ап' : 'Див доход, ао'));
        cashYield = dy?.values[dy.values.length - 1] ?? null;
        cashYieldSource = cashYield != null ? `дивдоходность ${f?.columns[f.columns.length - 1]} (smart-lab)` : null;
      }
    }
    rows.push({
      ticker: quote.secid,
      name: quote.name,
      kind: quote.kind,
      sector: sectorOf(quote.secid, quote.kind),
      quantity: input.quantity ?? null,
      price: quote.last,
      valueRub: value,
      pnlPct: input.avg_price && quote.last ? round((quote.last / input.avg_price - 1) * 100) : null,
      cashYieldPct: cashYield,
      cashYieldSource,
    });
  }

  const invested = rows.reduce((a, r) => a + r.valueRub, 0);
  const total = invested + cashRub;
  const withWeights: PositionResult[] = rows
    .map((r) => ({ ...r, valueRub: round(r.valueRub)!, weightPct: total > 0 ? round((r.valueRub / total) * 100)! : 0 }))
    .sort((a, b) => b.weightPct - a.weightPct);

  const sectorMap = new Map<string, number>();
  for (const r of withWeights) sectorMap.set(r.sector, (sectorMap.get(r.sector) ?? 0) + r.weightPct);
  if (cashRub > 0) sectorMap.set('Деньги', (cashRub / total) * 100);
  const sectors = [...sectorMap.entries()].map(([sector, w]) => ({ sector, weightPct: round(w)! })).sort((a, b) => b.weightPct - a.weightPct);

  // 1-year risk: constant current weights applied to daily returns.
  const from = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const riskAssets = withWeights.filter((r) => r.kind === 'share' || r.kind === 'fund' || r.kind === 'bond');
  const [imoex, ...series] = await Promise.all([
    getCandles('IMOEX', from).catch(() => null),
    ...riskAssets.map((r) => getCandles(r.ticker, from).catch(() => null)),
  ]);
  const marketRets = imoex ? dailyReturns(imoex.candles) : new Map<string, number>();
  const dates = [...marketRets.keys()];
  const portRets: number[] = [];
  const mktRets: number[] = [];
  let covered = 0;
  const assetRets = riskAssets.map((r, i) => {
    const s = series[i];
    if (!s || s.candles.length < 20) return null;
    covered += r.weightPct;
    return { w: r.weightPct / 100, rets: dailyReturns(s.candles) };
  });
  for (const d of dates) {
    let pr = 0;
    for (const a of assetRets) if (a) pr += a.w * (a.rets.get(d) ?? 0);
    portRets.push(pr);
    mktRets.push(marketRets.get(d)!);
  }
  let level = 1;
  const portCandles: Candle[] = [{ date: 'start', open: 1, high: 1, low: 1, close: 1, valueRub: null, volume: null }];
  for (const r of portRets) {
    level *= 1 + r;
    portCandles.push({ date: '', open: level, high: level, low: level, close: level, valueRub: null, volume: null });
  }
  const portStats = portRets.length > 20 ? seriesStats(portCandles) : null;
  const mktStats = imoex ? seriesStats(imoex.candles) : null;

  const expectedCash = withWeights.reduce((a, r) => a + (r.cashYieldPct != null ? (r.valueRub * r.cashYieldPct) / 100 : 0), 0);
  const keyRatePct = keyRate?.current?.ratePct ?? null;

  const conc = concentration(withWeights.map((r) => r.weightPct));
  const flags: string[] = [];
  if (conc.topPositionPct > 25) flags.push(`Крупнейшая позиция ${withWeights[0].ticker} — ${conc.topPositionPct}% портфеля (больше 25%).`);
  const topSector = sectors.find((s) => s.sector !== 'Деньги' && s.sector !== 'Облигации');
  if (topSector && topSector.weightPct > 40) flags.push(`Сектор «${topSector.sector}» занимает ${topSector.weightPct}% (больше 40%).`);
  if (conc.positions > 0 && conc.effectiveNumber < 5) flags.push(`Эффективное число позиций ${conc.effectiveNumber} — диверсификация низкая.`);
  if (portStats?.annualizedVolatilityPct != null && mktStats?.annualizedVolatilityPct != null && portStats.annualizedVolatilityPct > mktStats.annualizedVolatilityPct * 1.2) {
    flags.push(`Волатильность портфеля ${portStats.annualizedVolatilityPct}% выше индекса Мосбиржи (${mktStats.annualizedVolatilityPct}%).`);
  }
  const cashYieldPct = invested > 0 ? (expectedCash / total) * 100 : null;
  if (keyRatePct != null && cashYieldPct != null && cashYieldPct < keyRatePct / 2) {
    flags.push(`Ожидаемый денежный поток ${round(cashYieldPct)}% годовых — меньше половины ключевой ставки ${keyRatePct}%.`);
  }

  return {
    asOf: new Date().toISOString(),
    totalValueRub: round(total)!,
    cashRub,
    positions: withWeights,
    sectors,
    concentration: conc,
    risk1y: {
      portfolioReturnPct: portStats?.periodReturnPct ?? null,
      portfolioVolatilityPct: portStats?.annualizedVolatilityPct ?? null,
      portfolioMaxDrawdownPct: portStats?.maxDrawdownPct ?? null,
      imoexReturnPct: mktStats?.periodReturnPct ?? null,
      imoexVolatilityPct: mktStats?.annualizedVolatilityPct ?? null,
      // Weights are shares of the whole portfolio, so cash counts with beta 0.
      beta: covered > 0 ? round(computeBeta(portRets, mktRets), 2) : null,
      coveredWeightPct: round(covered)!,
    },
    income: { expectedAnnualCashRub: round(expectedCash)!, expectedCashYieldPct: round(cashYieldPct), keyRatePct },
    flags,
    errors,
  };
}
