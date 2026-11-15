/**
 * Savings plan simulator. Bond sleeve earns the OFZ zero-coupon yield for the
 * goal horizon (MOEX G-curve); equity sleeve is bootstrapped from historical
 * monthly returns of the MOEX total-return index MCFTR. Outputs percentiles,
 * the probability of reaching a goal and the monthly contribution needed.
 */
import { getCandles, getZeroCouponCurve, interpolateCurve } from './moex.js';
import { getKeyRate, getInflation } from './cbr.js';
import { round } from './http.js';

export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';

export const PROFILE_EQUITY_SHARE: Record<RiskProfile, number> = {
  conservative: 0.1,
  balanced: 0.4,
  aggressive: 0.7,
};

export const PROFILE_LABEL: Record<RiskProfile, string> = {
  conservative: 'Консервативный (10% акций / 90% ОФЗ)',
  balanced: 'Сбалансированный (40% акций / 60% ОФЗ)',
  aggressive: 'Агрессивный (70% акций / 30% ОФЗ)',
};

const TAX_RATE = 0.13;
const IIS_CONTRIBUTION_CAP = 400_000;
const PATHS = 2000;

export interface SimulationInput {
  years: number;
  initialRub: number;
  monthlyRub: number;
  equityShare: number;
  bondYieldPct: number;
  equityMonthlyReturns: number[];
  iis: boolean;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Final after-tax portfolio values for every simulated path, ascending. */
export function simulate(input: SimulationInput): number[] {
  const months = Math.round(input.years * 12);
  const bondMonthly = (1 + input.bondYieldPct / 100) ** (1 / 12) - 1;
  const rnd = mulberry32(input.seed ?? 42);
  const pool = input.equityMonthlyReturns.length > 0 ? input.equityMonthlyReturns : [0];
  const results: number[] = [];
  for (let p = 0; p < PATHS; p++) {
    let value = input.initialRub;
    let contributed = input.initialRub;
    let yearContrib = input.initialRub;
    for (let m = 1; m <= months; m++) {
      const eq = pool[Math.floor(rnd() * pool.length)];
      // Monthly rebalancing to the target mix.
      value *= 1 + input.equityShare * eq + (1 - input.equityShare) * bondMonthly;
      value += input.monthlyRub;
      contributed += input.monthlyRub;
      yearContrib += input.monthlyRub;
      if (m % 12 === 0) {
        if (input.iis) {
          // IIS type A deduction: 13% of the year's contributions up to the cap, reinvested.
          const refund = TAX_RATE * Math.min(yearContrib, IIS_CONTRIBUTION_CAP);
          value += refund;
          contributed += refund;
        }
        yearContrib = 0;
      }
    }
    const gain = Math.max(0, value - contributed);
    results.push(value - gain * TAX_RATE);
  }
  return results.sort((a, b) => a - b);
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

export function probabilityAtLeast(sorted: number[], goal: number): number {
  const below = sorted.findIndex((v) => v >= goal);
  return below === -1 ? 0 : (sorted.length - below) / sorted.length;
}

/** Smallest monthly contribution that reaches `goal` with probability `prob`. */
export function requiredMonthly(base: Omit<SimulationInput, 'monthlyRub'>, goal: number, prob: number): number | null {
  const reach = (monthly: number) => probabilityAtLeast(simulate({ ...base, monthlyRub: monthly }), goal) >= prob;
  if (reach(0)) return 0;
  let hi = Math.max(1000, goal / Math.max(1, base.years * 12));
  for (let i = 0; i < 30 && !reach(hi); i++) hi *= 2;
  if (!reach(hi)) return null;
  let lo = 0;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (reach(mid)) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi / 100) * 100;
}

export interface SavingsPlanInput {
  years: number;
  initial_rub?: number;
  monthly_rub?: number;
  goal_rub?: number;
  profile?: RiskProfile;
  iis?: boolean;
}

export async function buildSavingsPlan(input: SavingsPlanInput) {
  const years = Math.min(40, Math.max(0.5, input.years));
  const initial = Math.max(0, input.initial_rub ?? 0);
  const monthly = Math.max(0, input.monthly_rub ?? 0);
  const from = new Date(Date.now() - 10 * 365.25 * 86_400_000).toISOString().slice(0, 10);

  const [curve, mcftr, keyRate, inflation] = await Promise.all([
    getZeroCouponCurve(),
    getCandles('MCFTR', from, undefined, 'month'),
    getKeyRate(1).catch(() => null),
    getInflation(3).catch(() => null),
  ]);
  const bondYield = interpolateCurve(curve.points, years);
  if (bondYield == null) throw new Error('Нет кривой доходности ОФЗ');
  const closes = mcftr.candles.map((c) => c.close);
  const monthlyReturns = closes.slice(1).map((c, i) => c / closes[i] - 1);
  const historyYears = monthlyReturns.length / 12;
  const cagr = closes.length > 1 ? (closes[closes.length - 1] / closes[0]) ** (1 / historyYears) - 1 : null;
  const lastInflation = inflation?.rows[inflation.rows.length - 1] ?? null;
  const inflationPct = lastInflation?.inflationYoYPct ?? null;
  const deflator = inflationPct != null ? (1 + inflationPct / 100) ** years : null;
  const contributedTotal = initial + monthly * Math.round(years * 12);

  const scenarios = (Object.keys(PROFILE_EQUITY_SHARE) as RiskProfile[]).map((profile) => {
    const base = {
      years,
      initialRub: initial,
      equityShare: PROFILE_EQUITY_SHARE[profile],
      bondYieldPct: bondYield,
      equityMonthlyReturns: monthlyReturns,
      iis: input.iis ?? false,
    };
    const sorted = simulate({ ...base, monthlyRub: monthly });
    const p50 = percentile(sorted, 0.5);
    return {
      profile,
      label: PROFILE_LABEL[profile],
      selected: profile === (input.profile ?? 'balanced'),
      finalValueRub: {
        p10: round(percentile(sorted, 0.1), 0),
        p50: round(p50, 0),
        p90: round(percentile(sorted, 0.9), 0),
      },
      medianInTodayRub: deflator ? round(p50 / deflator, 0) : null,
      goalProbabilityPct: input.goal_rub ? round(probabilityAtLeast(sorted, input.goal_rub) * 100, 0) : null,
      monthlyNeededFor50Pct: input.goal_rub ? requiredMonthly(base, input.goal_rub, 0.5) : null,
      monthlyNeededFor80Pct: input.goal_rub ? requiredMonthly(base, input.goal_rub, 0.8) : null,
    };
  });

  return {
    input: { years, initialRub: initial, monthlyRub: monthly, goalRub: input.goal_rub ?? null, iis: input.iis ?? false, contributedTotalRub: contributedTotal },
    assumptions: {
      ofzZeroCouponYieldPct: round(bondYield),
      ofzCurveDate: curve.date,
      equityIndex: 'MCFTR (индекс МосБиржи полной доходности, с реинвестированием дивидендов)',
      equityHistory: `${mcftr.candles[0]?.date ?? '?'} — ${mcftr.candles[mcftr.candles.length - 1]?.date ?? '?'}`,
      equityHistoricalCagrPct: cagr != null ? round(cagr * 100) : null,
      keyRatePct: keyRate?.current?.ratePct ?? null,
      inflationYoYPct: inflationPct,
      inflationMonth: lastInflation?.month ?? null,
      tax: 'НДФЛ 13% с прироста в конце срока (упрощение: без ставки 15% и без льготы долгосрочного владения)',
      iis: input.iis ? 'ИИС-3, вычет типа А: 13% от взносов до 400 000 ₽ в год, возврат реинвестируется' : null,
      method: `${PATHS} сценариев: акции — случайная выборка месячных доходностей MCFTR за историю, облигации — доходность ОФЗ на срок цели, ребалансировка ежемесячно`,
    },
    scenarios,
    sources: ['https://iss.moex.com/iss/engines/stock/zcyc', 'https://iss.moex.com/iss/securities/MCFTR', 'https://www.cbr.ru/hd_base/KeyRate/', 'https://www.cbr.ru/hd_base/infl/'],
  };
}
