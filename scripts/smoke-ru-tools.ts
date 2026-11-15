// Live smoke test of Russian market tools: `bun run scripts/smoke-ru-tools.ts`
import { RU_MARKET_TOOLS } from '../src/tools/ru/tools.js';
const byName = new Map(RU_MARKET_TOOLS.map((t) => [t.name, t]));
const cases: Array<[string, Record<string, unknown>]> = [
  ['find_instrument', { query: 'Сбербанк' }],
  ['get_quotes', { tickers: ['SBER', 'Лукойл', 'IMOEX', 'SU26238RMFS4', 'CNYRUB_TOM', 'TMOS'] }],
  ['get_price_history', { ticker: 'GAZP', from: '2026-01-01', interval: 'week' }],
  ['get_company_financials', { ticker: 'LKOH', metrics: ['Выручка', 'EBITDA', 'Чистая прибыль', 'P/E'] }],
  ['get_dividends', { ticker: 'Сбер' }],
  ['screen_stocks', { min_div_yield: 10, max_pe: 8, limit: 5 }],
  ['get_bonds', { kind: 'ofz', min_years: 2, max_years: 5, limit: 5 }],
  ['get_bonds', { secid: 'SU26238RMFS4' }],
  ['get_macro', { what: ['key_rate', 'inflation', 'fx', 'yield_curve'] }],
  ['get_news', { query: 'ключевая ставка', limit: 5 }],
  ['draft_order', { ticker: 'SBER', side: 'buy', amount_rub: 50000 }],
  ['analyze_portfolio', { positions: [{ ticker: 'SBER', quantity: 300 }, { ticker: 'LKOH', quantity: 10 }, { ticker: 'SU26238RMFS4', quantity: 50 }, { ticker: 'TMOS', value_rub: 50000 }], cash_rub: 20000 }],
  ['plan_savings', { years: 10, initial_rub: 300000, monthly_rub: 20000, goal_rub: 5000000, profile: 'balanced', iis: true }],
];
const only = process.argv[2];
for (const [name, args] of cases) {
  if (only && name !== only) continue;
  const t0 = Date.now();
  const out = await byName.get(name)!.invoke(args);
  const text = String(out);
  console.log(`\n=== ${name} (${Date.now() - t0} ms, ${text.length} chars)`);
  console.log(text.slice(0, Number(process.env.SMOKE_CHARS ?? 700)));
}
