/**
 * LangChain tools over Russian market data. Every tool returns
 * formatToolResult(data, sourceUrls) so answers can cite sources and the
 * number check can compare the answer against tool output.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  ISS,
  getQuote,
  getCandles,
  seriesStats,
  downsample,
  searchInstruments,
  resolveInstrument,
  listBonds,
  getCouponSchedule,
  getZeroCouponCurve,
  type BondRow,
} from './moex.js';
import { filterMetricRows, getFundamentals, getDividends, getScreenerTable, SCREENER_URL, type DividendRow, type ScreenerRow } from './smartlab.js';
import { getKeyRate, getInflation, getFxRates } from './cbr.js';
import { getNews } from './news.js';
import { analyzePortfolio } from './portfolio.js';
import { buildSavingsPlan } from './savings.js';
import { round, todayIso } from './http.js';

const safe = async (fn: () => Promise<string>): Promise<string> => {
  try {
    return await fn();
  } catch (e) {
    return formatToolResult({ error: e instanceof Error ? e.message : String(e) });
  }
};

type Part = { data: Record<string, unknown>; urls: string[] };

/** Тикеры из `ticker` и `tickers` без повторов. */
function tickerList(f: { ticker?: string; tickers?: string[] }): string[] {
  const list = [...new Set([f.ticker, ...(f.tickers ?? [])].map((t) => t?.trim()).filter((t): t is string => !!t))];
  if (!list.length) throw new Error('Укажи ticker или tickers');
  return list.slice(0, 8);
}

/**
 * Один и тот же запрос сразу по нескольким бумагам. GigaChat вызывает один инструмент за ход,
 * поэтому пакетный вызов экономит шаги: 4 банка — один ход, а не четыре.
 */
async function forEachTicker(tickers: string[], one: (t: string) => Promise<Part>): Promise<string> {
  const parts = await Promise.all(
    tickers.map((t) =>
      one(t).then(
        (p) => ({ query: t, ...p }),
        (e: unknown) => ({ query: t, data: { error: e instanceof Error ? e.message : String(e) } as Record<string, unknown>, urls: [] as string[] }),
      ),
    ),
  );
  if (parts.length === 1) {
    if (parts[0]!.data.error) throw new Error(String(parts[0]!.data.error));
    return formatToolResult(parts[0]!.data, parts[0]!.urls);
  }
  return formatToolResult({ results: parts.map((p) => ({ query: p.query, ...p.data })) }, parts.flatMap((p) => p.urls));
}

const TICKERS_DESC = 'Несколько бумаг сразу — так быстрее, чем вызывать инструмент по одной';

// ---------------------------------------------------------------------------

export const findInstrument = new DynamicStructuredTool({
  name: 'find_instrument',
  description: 'Найти тикер/ISIN бумаги на Мосбирже по названию компании, фонда или облигации. Используй, когда не уверен в тикере.',
  schema: z.object({
    query: z.string().describe('Название или часть названия, например «Сбербанк», «ОФЗ 26238», «фонд денежного рынка»'),
  }),
  func: async ({ query }) =>
    safe(async () => {
      const hits = await searchInstruments(query, 10);
      return formatToolResult(hits, [`${ISS}/securities.json?q=${encodeURIComponent(query)}`]);
    }),
});

export const getQuotes = new DynamicStructuredTool({
  name: 'get_quotes',
  description:
    'Текущие котировки Мосбиржи (задержка ~15 минут): акции, фонды, облигации (цена в % от номинала, доходность, дюрация, купон), индексы (IMOEX, RGBI, MCFTR), валюта (CNYRUB_TOM). Принимает несколько тикеров сразу.',
  schema: z.object({
    tickers: z.array(z.string()).min(1).max(15).describe('Тикеры, ISIN или названия: ["SBER", "Лукойл", "IMOEX", "SU26238RMFS4"]'),
  }),
  func: async ({ tickers }) =>
    safe(async () => {
      const results = await Promise.all(
        tickers.map(async (t) => {
          try {
            return await getQuote(t);
          } catch (e) {
            return { query: t, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return formatToolResult({ delayNote: 'Данные MOEX ISS без подписки, задержка около 15 минут', quotes: results }, ['https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities']);
    }),
});

export const getPriceHistory = new DynamicStructuredTool({
  name: 'get_price_history',
  description:
    'История цен (свечи) бумаги или индекса на Мосбирже за период и статистика: доходность за период, годовая волатильность, максимальная просадка, мин/макс.',
  schema: z.object({
    ticker: z.string().describe('Тикер, ISIN или название'),
    from: z.string().describe('Начало периода YYYY-MM-DD'),
    to: z.string().optional().describe('Конец периода YYYY-MM-DD, по умолчанию сегодня'),
    interval: z.enum(['day', 'week', 'month']).optional().describe('Шаг свечей, по умолчанию day'),
  }),
  func: async ({ ticker, from, to, interval }) =>
    safe(async () => {
      const iv = interval ?? 'day';
      const { instrument, candles } = await getCandles(ticker, from, to, iv);
      const perYear = iv === 'day' ? 252 : iv === 'week' ? 52 : 12;
      return formatToolResult(
        {
          ticker: instrument.secid,
          name: instrument.name,
          interval: iv,
          stats: seriesStats(candles, perYear),
          candles: downsample(candles, 40).map((c) => ({ date: c.date, close: c.close, valueRub: c.valueRub })),
          totalCandles: candles.length,
        },
        [`${ISS}/engines/${instrument.engine}/markets/${instrument.market}/boards/${instrument.board}/securities/${instrument.secid}/candles`],
      );
    }),
});

export const getCompanyFinancials = new DynamicStructuredTool({
  name: 'get_company_financials',
  description:
    'Финансовая отчётность компании по МСФО (smart-lab): выручка, EBITDA, прибыль, долг, денежный поток, дивиденды, мультипликаторы P/E, P/B, EV/EBITDA за последние годы или кварталы, включая LTM. Для банков — процентный доход, кредиты, депозиты.',
  schema: z.object({
    ticker: z.string().optional().describe('Тикер или название компании'),
    tickers: z.array(z.string()).optional().describe(TICKERS_DESC),
    period: z.enum(['year', 'quarter']).optional().describe('year — годовые (по умолчанию), quarter — квартальные'),
    metrics: z.array(z.string()).optional().describe('Оставить только строки, содержащие эти слова (названия строк на русском), например ["Выручка", "Чистая прибыль", "EBITDA", "P/E"]'),
  }),
  func: async ({ ticker, tickers, period, metrics }) =>
    safe(async () =>
      forEachTicker(tickerList({ ticker, tickers }), async (t) => {
        const inst = await resolveInstrument(t);
        const base = inst.secid.replace(/P$/, '');
        const f = await getFundamentals(inst.secid, period ?? 'year').catch(() => getFundamentals(base, period ?? 'year'));
        const { rows, note } = filterMetricRows(f.rows, metrics);
        return { data: { ticker: inst.secid, company: f.title, standard: 'МСФО', columns: f.columns, rows, ...(note ? { note } : {}) }, urls: [f.url] };
      }),
    ),
});

export const getDividendHistory = new DynamicStructuredTool({
  name: 'get_dividends',
  description:
    'Дивиденды по акции: история выплат, даты отсечки и последнего дня покупки (T-1), размер на акцию, доходность. Будущие объявленные выплаты тоже попадают в список, если даты отсечки позже сегодняшней.',
  schema: z.object({
    ticker: z.string().optional().describe('Тикер или название компании'),
    tickers: z.array(z.string()).optional().describe(TICKERS_DESC),
  }),
  func: async ({ ticker, tickers }) =>
    safe(async () =>
      forEachTicker(tickerList({ ticker, tickers }), async (t) => {
        const inst = await resolveInstrument(t);
        const { rows, url } = await getDividends(inst.secid.replace(/P$/, ''));
        const today = todayIso();
        const forTicker = rows.filter((r) => r.ticker === inst.secid);
        const list = (forTicker.length ? forTicker : rows).slice(0, 15);
        const price = await getQuote(inst.secid).then((q) => q.last).catch(() => null);
        return {
          data: {
            ticker: inst.secid,
            summary: dividendSummary(list, today, price),
            upcoming: list.filter((r) => r.recordDate && r.recordDate >= today),
            history: list.filter((r) => !r.recordDate || r.recordDate < today),
          },
          urls: [url],
        };
      }),
    ),
});

function minusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Годовая картина: сумма выплат за 12 месяцев и объявленных к текущей цене. Доходность отдельной выплаты — не годовая. */
export function dividendSummary(rows: DividendRow[], today: string, price: number | null) {
  const from = minusDays(today, 365);
  const sum = (xs: DividendRow[]) => round(xs.reduce((a, r) => a + (r.dividendRub ?? 0), 0), 2) ?? 0;
  const paid = rows.filter((r) => r.recordDate && r.recordDate < today && r.recordDate >= from && r.dividendRub != null);
  const declared = rows.filter((r) => r.recordDate && r.recordDate >= today && r.dividendRub != null);
  const pct = (v: number) => (price ? round((v / price) * 100, 1) : null);
  return {
    price,
    paidLast12mRub: sum(paid),
    paidLast12mPayments: paid.length,
    paidLast12mYieldPct: pct(sum(paid)),
    declaredUpcomingRub: sum(declared),
    declaredUpcomingYieldPct: pct(sum(declared)),
    note: 'Годовую дивдоходность бери из paidLast12mYieldPct. yieldPct в отдельных выплатах — доходность одной выплаты к цене на дату отсечки, она не годовая.',
  };
}

const SORT_FIELDS = ['divYieldPct', 'pe', 'pb', 'evEbitda', 'capBnRub', 'debtEbitda', 'ebitdaMarginPct'] as const;

export const screenStocks = new DynamicStructuredTool({
  name: 'screen_stocks',
  description:
    'Скринер российских акций по мультипликаторам (smart-lab, последняя отчётность МСФО): дивдоходность, P/E, P/B, EV/EBITDA, долг/EBITDA, рентабельность EBITDA, капитализация. Все фильтры необязательные.',
  schema: z.object({
    min_div_yield: z.number().optional().describe('Минимальная дивдоходность, %'),
    max_pe: z.number().optional().describe('Максимальный P/E (отрицательные P/E исключаются)'),
    max_pb: z.number().optional(),
    max_ev_ebitda: z.number().optional(),
    max_debt_ebitda: z.number().optional(),
    min_cap_bn: z.number().optional().describe('Минимальная капитализация, млрд руб'),
    sort_by: z.enum(SORT_FIELDS).optional().describe('Поле сортировки; дивдоходность и капитализация — по убыванию, остальные — по возрастанию'),
    limit: z.number().optional().describe('Сколько строк вернуть, по умолчанию 15'),
    include_outliers: z.boolean().optional().describe('Не отсеивать аномалии (дивдоходность > 30%, P/E < 1,5, капитализация < 2 млрд) — обычно разовые выплаты или ошибки данных'),
  }),
  func: async (f) =>
    safe(async () => {
      const all = await getScreenerTable();
      const outliers = f.include_outliers ? [] : all.map((r) => ({ r, reason: screenerOutlierReason(r) })).filter((x) => x.reason);
      const skip = new Set(outliers.map((x) => x.r));
      const table = all.filter((r) => !skip.has(r));
      const ok = (v: number | null, pred: (x: number) => boolean) => v != null && pred(v);
      let rows: ScreenerRow[] = table.filter(
        (r) =>
          (f.min_div_yield == null || ok(r.divYieldPct, (x) => x >= f.min_div_yield!)) &&
          (f.max_pe == null || ok(r.pe, (x) => x > 0 && x <= f.max_pe!)) &&
          (f.max_pb == null || ok(r.pb, (x) => x > 0 && x <= f.max_pb!)) &&
          (f.max_ev_ebitda == null || ok(r.evEbitda, (x) => x > 0 && x <= f.max_ev_ebitda!)) &&
          (f.max_debt_ebitda == null || ok(r.debtEbitda, (x) => x <= f.max_debt_ebitda!)) &&
          (f.min_cap_bn == null || ok(r.capBnRub, (x) => x >= f.min_cap_bn!)),
      );
      const key = f.sort_by ?? 'divYieldPct';
      const desc = key === 'divYieldPct' || key === 'capBnRub' || key === 'ebitdaMarginPct';
      rows = rows
        .filter((r) => r[key] != null)
        .sort((a, b) => (desc ? (b[key] as number) - (a[key] as number) : (a[key] as number) - (b[key] as number)));
      const excluded = outliers
        .filter(({ r }) => (f.min_div_yield == null || (r.divYieldPct ?? 0) >= f.min_div_yield) && (f.max_pe == null || (r.pe != null && r.pe > 0 && r.pe <= f.max_pe)))
        .map(({ r, reason }) => ({ ticker: r.ticker, name: r.name, reason }));
      return formatToolResult(
        {
          matched: rows.length,
          rows: rows.slice(0, Math.min(40, f.limit ?? 15)),
          ...(excluded.length ? { excludedOutliers: excluded.slice(0, 10), outlierNote: 'Отсеяны как аномалии: разовая выплата, ошибка данных или слишком маленькая компания. Упомяни их, если пользователь спросит.' } : {}),
        },
        [SCREENER_URL],
      );
    }),
});

/** Почему строка скринера похожа на выброс (null — нормальная). */
export function screenerOutlierReason(r: ScreenerRow): string | null {
  if (r.divYieldPct != null && r.divYieldPct > 30) return `дивдоходность ${r.divYieldPct}% — вероятно, разовая выплата`;
  if (r.pe != null && r.pe > 0 && r.pe < 1.5) return `P/E ${r.pe} — вероятно, разовая прибыль или ошибка данных`;
  if (r.capBnRub != null && r.capBnRub < 2) return `капитализация ${r.capBnRub} млрд ₽ — низкая ликвидность`;
  return null;
}

export const getBonds = new DynamicStructuredTool({
  name: 'get_bonds',
  description:
    'Облигации Мосбиржи. Режим списка: ОФЗ или корпоративные с фильтрами по сроку и доходности (доходность к погашению, дюрация, купон). Режим одной бумаги: передай secid или ISIN — вернётся котировка и график купонов.',
  schema: z.object({
    kind: z.enum(['ofz', 'corporate']).optional().describe('ofz — госбумаги (по умолчанию), corporate — корпоративные'),
    secid: z.string().optional().describe('Код или ISIN конкретной облигации для подробностей'),
    min_years: z.number().optional().describe('Минимальный срок до погашения, лет'),
    max_years: z.number().optional().describe('Максимальный срок до погашения, лет'),
    min_yield: z.number().optional().describe('Минимальная доходность к погашению, %'),
    max_yield: z.number().optional().describe('Максимальная доходность, % (отсекает бумаги с высоким риском)'),
    fixed_coupon_only: z.boolean().optional().describe('Только фиксированный купон (без флоатеров и линкеров)'),
    sort_by: z.enum(['yield', 'maturity', 'volume']).optional(),
    limit: z.number().optional(),
  }),
  func: async (f) =>
    safe(async () => {
      if (f.secid) {
        const quote = await getQuote(f.secid);
        const coupons = await getCouponSchedule(quote.secid).catch(() => []);
        const today = todayIso();
        return formatToolResult(
          { quote, nextCoupons: coupons.filter((c) => c.date >= today).slice(0, 12), paidCoupons: coupons.filter((c) => c.date < today).length },
          [`${ISS}/securities/${quote.secid}`],
        );
      }
      const board = f.kind === 'corporate' ? 'TQCB' : 'TQOB';
      const all = await listBonds(board);
      let rows: BondRow[] = all.filter(
        (b) =>
          b.yearsToMaturity != null &&
          b.yearsToMaturity > 0 &&
          (f.min_years == null || b.yearsToMaturity >= f.min_years) &&
          (f.max_years == null || b.yearsToMaturity <= f.max_years) &&
          (f.min_yield == null || (b.yieldPct ?? 0) >= f.min_yield) &&
          (f.max_yield == null || (b.yieldPct ?? Infinity) <= f.max_yield) &&
          (!f.fixed_coupon_only || /фиксирован/i.test(b.bondType ?? '')) &&
          (b.faceUnit === 'SUR' || b.faceUnit === 'RUB' || f.kind === 'corporate'),
      );
      const sort = f.sort_by ?? 'yield';
      rows.sort((a, b) =>
        sort === 'maturity'
          ? (a.yearsToMaturity ?? 0) - (b.yearsToMaturity ?? 0)
          : sort === 'volume'
            ? (b.valueTodayRub ?? 0) - (a.valueTodayRub ?? 0)
            : (b.yieldPct ?? 0) - (a.yieldPct ?? 0),
      );
      // Thinly traded corporate paper skews "top yield" lists; require turnover.
      if (board === 'TQCB') rows = rows.filter((b) => (b.valueTodayRub ?? 0) >= 1_000_000);
      return formatToolResult(
        { board, matched: rows.length, rows: rows.slice(0, Math.min(30, f.limit ?? 12)) },
        [`${ISS}/engines/stock/markets/bonds/boards/${board}/securities`],
      );
    }),
});

export const getMacro = new DynamicStructuredTool({
  name: 'get_macro',
  description:
    'Макроданные: ключевая ставка ЦБ (текущая и история изменений), инфляция г/г и цель ЦБ, официальные курсы валют ЦБ, кривая бескупонной доходности ОФЗ (G-curve Мосбиржи).',
  schema: z.object({
    what: z.array(z.enum(['key_rate', 'inflation', 'fx', 'yield_curve'])).min(1).describe('Какие данные нужны'),
    currencies: z.array(z.string()).optional().describe('Коды валют для fx, например ["USD","EUR","CNY"]; по умолчанию эти три'),
  }),
  func: async ({ what, currencies }) =>
    safe(async () => {
      const out: Record<string, unknown> = {};
      const urls: string[] = [];
      await Promise.all(
        what.map(async (w) => {
          try {
            if (w === 'key_rate') {
              const k = await getKeyRate(3);
              out.keyRate = { current: k.current, changes: k.changes.slice(-12) };
              urls.push(k.url);
            } else if (w === 'inflation') {
              const i = await getInflation(18);
              out.inflation = i.rows;
              urls.push(i.url);
            } else if (w === 'fx') {
              const fx = await getFxRates(currencies?.length ? currencies : ['USD', 'EUR', 'CNY']);
              out.fx = { date: fx.date, rates: fx.rates };
              urls.push(fx.url);
            } else if (w === 'yield_curve') {
              const c = await getZeroCouponCurve();
              const pick = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 20];
              out.yieldCurve = { date: c.date, points: c.points.filter((p) => pick.includes(p.years)) };
              urls.push('https://www.moex.com/ru/marketdata/indices/state/g-curve/');
            }
          } catch (e) {
            out[`${w}_error`] = e instanceof Error ? e.message : String(e);
          }
        }),
      );
      return formatToolResult(out, urls);
    }),
});

export const getMarketNews = new DynamicStructuredTool({
  name: 'get_news',
  description:
    'Свежие новости из RSS РБК, Интерфакса, Банка России и сообщения Мосбиржи. Можно отфильтровать по компании или теме (ключевым словам). Только заголовки и краткие анонсы — для деталей используй web_fetch по ссылке.',
  schema: z.object({
    query: z.string().optional().describe('Ключевые слова: «Сбербанк», «ключевая ставка», «дивиденды»; пусто — все новости'),
    limit: z.number().optional().describe('Сколько новостей вернуть, по умолчанию 12'),
  }),
  func: async ({ query, limit }) =>
    safe(async () => {
      const { items, errors, sources } = await getNews(query, Math.min(30, limit ?? 12));
      return formatToolResult({ query: query ?? null, items, errors }, sources);
    }),
});

export const analyzePortfolioTool = new DynamicStructuredTool({
  name: 'analyze_portfolio',
  description:
    'Разбор портфеля пользователя на российском рынке: оценка по рынку, доли, сектора, концентрация, риск за год (доходность, волатильность, просадка, бета к IMOEX), ожидаемый денежный поток (дивиденды, купоны) против ключевой ставки, автоматические предупреждения. Позиции задаются количеством бумаг или суммой в рублях.',
  schema: z.object({
    positions: z
      .array(
        z.object({
          ticker: z.string().describe('Тикер, ISIN или название'),
          quantity: z.number().optional().describe('Количество бумаг (штук, не лотов)'),
          value_rub: z.number().optional().describe('Или сумма позиции в рублях'),
          avg_price: z.number().optional().describe('Средняя цена покупки для расчёта результата'),
        }),
      )
      .min(1)
      .max(30),
    cash_rub: z.number().optional().describe('Свободные деньги на счёте, руб'),
  }),
  func: async ({ positions, cash_rub }) =>
    safe(async () => {
      const report = await analyzePortfolio(positions, cash_rub ?? 0);
      return formatToolResult(report, ['https://iss.moex.com/iss', SCREENER_URL, 'https://www.cbr.ru/hd_base/KeyRate/']);
    }),
});

export const planSavings = new DynamicStructuredTool({
  name: 'plan_savings',
  description:
    'План накоплений: моделирует, сколько получится к сроку при заданных взносах, и какой ежемесячный взнос нужен для цели. Использует текущую доходность ОФЗ на срок цели, историю индекса MCFTR (2000 сценариев), инфляцию и ключевую ставку ЦБ, налог 13% и вычет ИИС-3. Возвращает три профиля риска.',
  schema: z.object({
    years: z.number().describe('Срок, лет'),
    initial_rub: z.number().optional().describe('Стартовая сумма, руб'),
    monthly_rub: z.number().optional().describe('Ежемесячный взнос, руб'),
    goal_rub: z.number().optional().describe('Целевая сумма, руб'),
    profile: z.enum(['conservative', 'balanced', 'aggressive']).optional().describe('Профиль риска пользователя'),
    iis: z.boolean().optional().describe('Учитывать вычет по ИИС-3'),
  }),
  func: async (input) => safe(async () => {
    const plan = await buildSavingsPlan(input);
    return formatToolResult(plan, plan.sources);
  }),
});

export const draftOrder = new DynamicStructuredTool({
  name: 'draft_order',
  description:
    'Черновик заявки на покупку или продажу: считает число лотов, сумму и комиссию по текущей цене и даёт ссылку на бумагу в Т-Инвестициях. Сделку НЕ исполняет — пользователь подтверждает её сам в приложении брокера.',
  schema: z.object({
    ticker: z.string().optional(),
    tickers: z.array(z.string()).optional().describe('Несколько бумаг с одинаковыми side и amount_rub/lots — например «по 30 000 ₽ в каждую»'),
    side: z.enum(['buy', 'sell']),
    amount_rub: z.number().optional().describe('Сумма заявки в рублях (на каждую бумагу)'),
    lots: z.number().optional().describe('Или количество лотов'),
    commission_pct: z.number().optional().describe('Комиссия брокера, % от суммы; по умолчанию 0.3 (тариф «Инвестор» Т-Инвестиций — уточняйте у брокера)'),
  }),
  func: async (f) =>
    safe(async () =>
      forEachTicker(tickerList(f), async (ticker) => {
        const q = await getQuote(ticker);
        if (q.last == null) throw new Error(`Нет текущей цены для ${q.secid}`);
        const lotSize = q.lotSize ?? 1;
        const unit = q.kind === 'bond' && q.bond ? (q.last / 100) * (q.bond.faceValue ?? 1000) + (q.bond.accruedInterest ?? 0) : q.last;
        const lotPrice = unit * lotSize;
        const commissionPct = f.commission_pct ?? 0.3;
        // При покупке на сумму комиссия тоже из бюджета: итог не должен превышать amount_rub.
        const perLot = f.side === 'buy' ? lotPrice * (1 + commissionPct / 100) : lotPrice;
        const lots = f.lots ?? (f.amount_rub ? Math.floor(f.amount_rub / perLot) : 1);
        if (lots < 1) throw new Error(`Суммы не хватает на 1 лот: лот ${lotSize} шт. стоит ${round(lotPrice)} ₽`);
        const amount = lots * lotPrice;
        const section = q.kind === 'bond' ? 'bonds' : q.kind === 'fund' ? 'etfs' : q.kind === 'currency' ? 'currencies' : 'stocks';
        const id = q.kind === 'bond' ? q.isin ?? q.secid : q.secid;
        return {
          data: {
            status: 'ЧЕРНОВИК — не исполнено',
            ticker: q.secid,
            name: q.name,
            side: f.side === 'buy' ? 'покупка' : 'продажа',
            price: q.last,
            priceUnit: q.kind === 'bond' ? '% от номинала' : '₽',
            lotSize,
            lots,
            amountRub: round(amount),
            commissionRub: round((amount * commissionPct) / 100),
            totalRub: round(f.side === 'buy' ? amount * (1 + commissionPct / 100) : amount * (1 - commissionPct / 100)),
            brokerLink: `https://www.tbank.ru/invest/${section}/${id}/`,
            note: 'Цена с задержкой ~15 минут; итоговая сумма зависит от цены исполнения. Решение и подтверждение — за пользователем.',
          },
          urls: [`https://www.tbank.ru/invest/${section}/${id}/`],
        };
      }),
    ),
});

export const RU_MARKET_TOOLS = [
  findInstrument,
  getQuotes,
  getPriceHistory,
  getCompanyFinancials,
  getDividendHistory,
  screenStocks,
  getBonds,
  getMacro,
  getMarketNews,
  analyzePortfolioTool,
  planSavings,
  draftOrder,
];
