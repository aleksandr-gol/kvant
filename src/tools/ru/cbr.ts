/**
 * Bank of Russia (cbr.ru): key rate history, inflation vs target, official
 * FX rates. Public pages; the key rate page lists one row per business day.
 */
import { parseHTML } from 'linkedom';
import { fetchText, HOUR, parseRuNumber, ruDateToIso } from './http.js';

const CBR = 'https://www.cbr.ru';

function ruDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function bodyRows(html: string): string[][] {
  const { document } = parseHTML(html);
  const table = document.querySelector('table.data') ?? document.querySelector('table');
  if (!table) return [];
  return [...table.querySelectorAll('tr')]
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim()))
    .filter((r) => r.length > 0);
}

export interface KeyRateChange {
  date: string;
  ratePct: number;
}

/** Daily key-rate table collapsed into the dates when the rate changed. */
export function parseKeyRate(html: string): { current: KeyRateChange | null; changes: KeyRateChange[] } {
  const daily = bodyRows(html)
    .map((r) => ({ date: ruDateToIso(r[0] ?? ''), rate: parseRuNumber(r[1]) }))
    .filter((r): r is { date: string; rate: number } => Boolean(r.date) && r.rate !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const changes: KeyRateChange[] = [];
  for (const d of daily) {
    if (changes.length === 0 || changes[changes.length - 1].ratePct !== d.rate) {
      changes.push({ date: d.date, ratePct: d.rate });
    }
  }
  const last = daily[daily.length - 1];
  return { current: last ? { date: last.date, ratePct: last.rate } : null, changes };
}

export async function getKeyRate(yearsBack = 3): Promise<{ current: KeyRateChange | null; changes: KeyRateChange[]; url: string }> {
  const to = new Date();
  const from = new Date(to.getFullYear() - yearsBack, to.getMonth(), to.getDate());
  const pageUrl = `${CBR}/hd_base/KeyRate/?UniDbQuery.Posted=True&UniDbQuery.From=${ruDate(from)}&UniDbQuery.To=${ruDate(to)}`;
  const html = await fetchText(pageUrl, { ttlMs: HOUR });
  return { ...parseKeyRate(html), url: `${CBR}/hd_base/KeyRate/` };
}

export interface InflationRow {
  month: string;
  keyRatePct: number | null;
  inflationYoYPct: number | null;
  targetPct: number | null;
}

export function parseInflation(html: string): InflationRow[] {
  return bodyRows(html)
    .filter((r) => /^\d{2}\.\d{4}$/.test(r[0] ?? ''))
    .map((r) => {
      const [mm, yyyy] = r[0].split('.');
      return {
        month: `${yyyy}-${mm}`,
        keyRatePct: parseRuNumber(r[1]),
        inflationYoYPct: parseRuNumber(r[2]),
        targetPct: parseRuNumber(r[3]),
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

export async function getInflation(monthsBack = 24): Promise<{ rows: InflationRow[]; url: string }> {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - monthsBack, 1);
  const mmyyyy = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const pageUrl = `${CBR}/hd_base/infl/?UniDbQuery.Posted=True&UniDbQuery.From=${mmyyyy(from)}&UniDbQuery.To=${mmyyyy(to)}`;
  const html = await fetchText(pageUrl, { ttlMs: 6 * HOUR });
  return { rows: parseInflation(html), url: `${CBR}/hd_base/infl/` };
}

export interface FxRate {
  code: string;
  name: string;
  nominal: number;
  rateRub: number;
}

export function parseFxXml(xml: string): { date: string | null; rates: FxRate[] } {
  const date = /ValCurs Date="(\d{2}\.\d{2}\.\d{4})"/.exec(xml)?.[1] ?? null;
  const rates: FxRate[] = [];
  for (const m of xml.matchAll(/<Valute[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const pick = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[1])?.[1] ?? '';
    const value = parseRuNumber(pick('Value'));
    const nominal = parseRuNumber(pick('Nominal')) ?? 1;
    if (value === null) continue;
    rates.push({ code: pick('CharCode'), name: pick('Name'), nominal, rateRub: value });
  }
  return { date: date ? ruDateToIso(date) : null, rates };
}

export async function getFxRates(codes?: string[]): Promise<{ date: string | null; rates: FxRate[]; url: string }> {
  const pageUrl = `${CBR}/scripts/XML_daily.asp`;
  const xml = await fetchText(pageUrl, { ttlMs: HOUR, encoding: 'windows-1251' });
  const parsed = parseFxXml(xml);
  const wanted = codes?.map((c) => c.toUpperCase());
  return {
    date: parsed.date,
    rates: wanted?.length ? parsed.rates.filter((r) => wanted.includes(r.code)) : parsed.rates,
    url: pageUrl,
  };
}
