/**
 * Shared HTTP layer for Russian market sources: timeouts, a small TTL cache
 * and a single User-Agent. Every source here is public and keyless.
 */
import { LRUCache } from 'lru-cache';

const USER_AGENT = 'Mozilla/5.0 (compatible; kvant/1.0; research agent)';
const DEFAULT_TIMEOUT_MS = 20_000;

type Cached = { body: string };
const cache = new LRUCache<string, Cached>({ max: 500, ttlAutopurge: true });

export interface FetchTextOptions {
  ttlMs?: number;
  encoding?: string;
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

let fetchOverride: typeof fetch | null = null;

/** Tests can replace network access with fixtures. */
export function setFetchForTests(impl: typeof fetch | null): void {
  fetchOverride = impl;
  cache.clear();
}

export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<string> {
  const ttl = options.ttlMs ?? 0;
  if (ttl > 0) {
    const hit = cache.get(url);
    if (hit) return hit.body;
  }
  const impl = options.fetchImpl ?? fetchOverride ?? fetch;
  let response: Response;
  try {
    response = await impl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Источник недоступен (${new URL(url).hostname}): ${message}`);
  }
  if (!response.ok) {
    throw new Error(`Источник ответил ${response.status} (${new URL(url).hostname})`);
  }
  let body: string;
  if (options.encoding === 'windows-1251') {
    body = decodeCp1251(new Uint8Array(await response.arrayBuffer()));
  } else if (options.encoding && options.encoding !== 'utf-8') {
    const buffer = await response.arrayBuffer();
    body = new TextDecoder(options.encoding).decode(buffer);
  } else {
    body = await response.text();
  }
  if (ttl > 0) cache.set(url, { body }, { ttl });
  return body;
}

// Bun's TextDecoder has no windows-1251; cbr.ru XML still uses it.
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\ufffd™љ›њќћџ\u00a0ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

export function decodeCp1251(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP1251_HIGH[b - 0x80];
  return out;
}

export async function fetchJson<T = unknown>(url: string, options: FetchTextOptions = {}): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Некорректный JSON от ${new URL(url).hostname}`);
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Parse Russian-formatted numbers: "1 234,5", "12.5%", "37,64₽", "—". */
export function parseRuNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw)
    .replace(/ | /g, ' ')
    .replace(/[₽%$]|руб\.?/g, '')
    .replace(/\s+/g, '')
    .replace(',', '.')
    .trim();
  if (!cleaned || cleaned === '—' || cleaned === '-' || cleaned === '?') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** dd.mm.yyyy → yyyy-mm-dd */
export function ruDateToIso(raw: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function round(value: number | null | undefined, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
