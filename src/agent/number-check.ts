/**
 * Self-check of a final answer: every material number in the text must be
 * traceable to a tool result (allowing for rounding and unit words such as
 * «млрд»). Numbers that are not found are reported, not hidden — they may be
 * legitimate derived values (differences, ratios) or hallucinations.
 */

export interface NumberCheckResult {
  checked: number;
  grounded: number;
  ungrounded: string[];
  /** Share of checked numbers found in tool data, 0..1 (1 when nothing to check). */
  ratio: number;
}

const UNIT_WORDS: Array<[RegExp, number]> = [
  [/^\s*трлн/i, 1e12],
  [/^\s*млрд/i, 1e9],
  [/^\s*млн/i, 1e6],
  [/^\s*тыс/i, 1e3],
];

// A number with optional thousands separators (space / nbsp / thin space) and a decimal part.
const NUMBER_RE = /(?<![\p{L}\d.,])[-−–]?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?![\p{L}\d])|(?<![\p{L}\d.,])[-−–]?\d+(?:[.,]\d+)?(?![\p{L}\d])/gu;

interface AnswerNumber {
  raw: string;
  value: number;
  decimals: number;
  multiplier: number;
  isPercent: boolean;
}

export function extractAnswerNumbers(text: string): AnswerNumber[] {
  const out: AnswerNumber[] = [];
  // Drop URLs, tickers with digits, ISINs and dates before scanning.
  const cleaned = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[A-Z]{2}[A-Z0-9]{9}\d\b/g, ' ')
    .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  for (const m of cleaned.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const normalized = raw.replace(/[−–]/g, '-').replace(/[   ]/g, '').replace(',', '.');
    const value = Number(normalized);
    if (!Number.isFinite(value)) continue;
    const decimals = normalized.includes('.') ? normalized.split('.')[1].length : 0;
    const after = cleaned.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 8);
    const isPercent = /^\s*(%|п\.\s?п)/.test(after);
    const multiplier = UNIT_WORDS.find(([re]) => re.test(after))?.[1] ?? 1;
    const abs = Math.abs(value);
    // Skip list markers, small counts and calendar years.
    if (!isPercent && decimals === 0 && multiplier === 1 && (abs < 10 || (abs >= 1990 && abs <= 2100))) continue;
    out.push({ raw: raw.trim() + (isPercent ? '%' : ''), value, decimals, multiplier, isPercent });
  }
  return out;
}

export function collectToolNumbers(results: string[]): number[] {
  const nums = new Set<number>();
  const visit = (node: unknown) => {
    if (typeof node === 'number' && Number.isFinite(node)) nums.add(node);
    else if (typeof node === 'string') {
      for (const m of node.matchAll(NUMBER_RE)) {
        const v = Number(m[0].replace(/[−–]/g, '-').replace(/[   ]/g, '').replace(',', '.'));
        if (Number.isFinite(v)) nums.add(v);
      }
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  for (const r of results) {
    try {
      visit(JSON.parse(r));
    } catch {
      visit(r);
    }
  }
  return [...nums];
}

function matchesAny(n: AnswerNumber, pool: number[]): boolean {
  const target = n.value * n.multiplier;
  const step = 10 ** -n.decimals * n.multiplier;
  const tolerance = Math.max(step / 2 + 1e-9, Math.abs(target) * 0.005);
  // Tool data may already be in thousands/millions/billions (smart-lab uses «млрд руб»).
  const scales = n.multiplier === 1 ? [1] : [1, 1e3, 1e6, 1e9, 1e12];
  for (const t of pool) {
    for (const s of scales) {
      if (Math.abs(t * s - target) <= tolerance) return true;
      // Sign is often dropped in prose («снизилась на 4,5%»).
      if (Math.abs(Math.abs(t * s) - Math.abs(target)) <= tolerance) return true;
    }
    // Fractions vs percents: 0.128 ↔ 12.8%.
    if (n.isPercent && Math.abs(t * 100 - target) <= tolerance) return true;
  }
  return false;
}

export function checkAnswerNumbers(answer: string, toolResults: string[]): NumberCheckResult {
  const numbers = extractAnswerNumbers(answer);
  if (numbers.length === 0) return { checked: 0, grounded: 0, ungrounded: [], ratio: 1 };
  const pool = collectToolNumbers(toolResults);
  const ungrounded: string[] = [];
  let grounded = 0;
  for (const n of numbers) {
    if (matchesAny(n, pool)) grounded++;
    else if (!ungrounded.includes(n.raw)) ungrounded.push(n.raw);
  }
  return { checked: numbers.length, grounded, ungrounded, ratio: grounded / numbers.length };
}
