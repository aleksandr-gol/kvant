/**
 * Compact, user-facing view of tool calls for the web timeline: a Russian
 * label, a one-line summary, source links and optional sparkline data.
 */

export const TOOL_LABELS: Record<string, string> = {
  find_instrument: 'Поиск бумаги на Мосбирже',
  get_quotes: 'Котировки Мосбиржи',
  get_price_history: 'История цен',
  get_company_financials: 'Отчётность МСФО',
  get_dividends: 'Дивиденды',
  screen_stocks: 'Скринер акций',
  get_bonds: 'Облигации',
  get_macro: 'Данные Банка России',
  get_news: 'Новости',
  analyze_portfolio: 'Расчёт портфеля',
  plan_savings: 'Моделирование накоплений',
  draft_order: 'Черновик заявки',
  web_fetch: 'Чтение страницы',
  web_search: 'Поиск в интернете',
  skill: 'Сценарий анализа',
};

interface ToolView {
  ok: boolean;
  summary: string;
  sources: string[];
}

function count(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}

export function summarizeToolResult(tool: string, raw: string): ToolView {
  let parsed: { data?: unknown; sourceUrls?: string[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: true, summary: tool === 'skill' ? 'инструкции загружены' : 'готово', sources: [] };
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const sources = (parsed.sourceUrls ?? []).filter((u) => /^https?:\/\//.test(u)).slice(0, 4);
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    return { ok: false, summary: String(data.error).slice(0, 200), sources };
  }
  const arr = (k: string) => (Array.isArray(data[k]) ? (data[k] as unknown[]) : null);
  let summary = 'готово';
  switch (tool) {
    case 'get_quotes': {
      const q = (arr('quotes') ?? []) as Array<{ secid?: string; last?: number; error?: string }>;
      summary = q.map((x) => (x.error ? `${(x as { query?: string }).query}: нет данных` : `${x.secid} ${x.last ?? '—'}`)).join(', ');
      break;
    }
    case 'get_price_history': {
      const s = data.stats as { periodReturnPct?: number; firstDate?: string; lastDate?: string } | undefined;
      summary = `${data.ticker}: ${s?.firstDate} — ${s?.lastDate}, изменение ${s?.periodReturnPct ?? '—'}%`;
      break;
    }
    case 'get_company_financials':
    case 'get_dividends':
    case 'draft_order':
      summary = (arr('results') ?? [data]).map((item) => perTickerSummary(tool, item as Record<string, unknown>)).join('; ');
      break;
    case 'screen_stocks':
    case 'get_bonds':
      summary = data.quote ? `${(data.quote as { secid?: string }).secid}: котировка и купоны` : `найдено ${data.matched ?? arr('rows')?.length ?? 0}`;
      break;
    case 'get_news':
      summary = count(arr('items')?.length ?? 0, 'новость', 'новости', 'новостей');
      break;
    case 'get_macro':
      summary = Object.keys(data).filter((k) => !k.endsWith('_error')).join(', ') || 'нет данных';
      break;
    case 'analyze_portfolio':
      summary = `${count(arr('positions')?.length ?? 0, 'позиция', 'позиции', 'позиций')}, ${count(arr('flags')?.length ?? 0, 'предупреждение', 'предупреждения', 'предупреждений')}`;
      break;
    case 'plan_savings':
      summary = `${count(arr('scenarios')?.length ?? 0, 'профиль', 'профиля', 'профилей')} риска, 2000 сценариев`;
      break;
    case 'web_fetch':
      summary = String((data as { url?: string }).url ?? 'страница прочитана');
      break;
    default:
      break;
  }
  return { ok: true, summary: summary.slice(0, 240), sources };
}

/** Строка ленты шагов для одной бумаги; пакетные вызовы возвращают список таких элементов. */
function perTickerSummary(tool: string, d: Record<string, unknown>): string {
  if (d.error) return `${d.query ?? '?'}: ${String(d.error).slice(0, 60)}`;
  const len = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0);
  if (tool === 'get_company_financials') {
    return `${d.ticker}: ${count(len('rows'), 'показатель', 'показателя', 'показателей')}, ${(d.columns as string[] | undefined)?.join(', ') ?? ''}`;
  }
  if (tool === 'get_dividends') return `${d.ticker}: ${count(len('history') + len('upcoming'), 'выплата', 'выплаты', 'выплат')}`;
  return `${d.side} ${d.ticker}: ${d.lots} лот., ${d.totalRub} ₽ — не исполнено`;
}

/** Closing prices for a sparkline next to price-history steps. */
export function extractChart(tool: string, raw: string): { label: string; points: Array<[string, number]> } | null {
  if (tool !== 'get_price_history') return null;
  try {
    const data = JSON.parse(raw).data as { ticker?: string; candles?: Array<{ date: string; close: number }> };
    if (!data?.candles?.length) return null;
    return { label: data.ticker ?? '', points: data.candles.map((c) => [c.date, c.close]) };
  } catch {
    return null;
  }
}
