/**
 * News from public RSS feeds (RBC, Interfax, Bank of Russia) and MOEX
 * exchange notices, filtered by keywords with naive Russian stemming.
 */
import { fetchText, MINUTE } from './http.js';
import { getExchangeNews } from './moex.js';

export interface NewsItem {
  source: string;
  title: string;
  summary: string;
  published: string | null;
  url: string;
}

export const FEEDS: Array<{ source: string; url: string }> = [
  { source: 'РБК', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss' },
  { source: 'Интерфакс', url: 'https://www.interfax.ru/rss' },
  { source: 'Банк России', url: 'https://www.cbr.ru/rss/eventrss' },
];

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const pick = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(m[1])?.[1] ?? '';
    const title = stripTags(pick('title'));
    if (!title) continue;
    const date = pick('pubDate');
    const parsed = date ? new Date(decodeEntities(date).trim()) : null;
    items.push({
      source,
      title,
      summary: stripTags(pick('description')).slice(0, 400),
      published: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      url: stripTags(pick('link')),
    });
  }
  return items;
}

/** Crude stem: lowercase, drop ё, cut common inflection endings off longer words. */
export function stems(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9+]+/i)
    .filter((w) => w.length >= 2)
    .map((w) => (w.length > 5 && /[а-я]$/.test(w) ? w.slice(0, -2) : w));
}

/** Keywords must start a word ("став" matches «ставка», not «оставшиеся»). */
export function matches(item: NewsItem, keywords: string[], mode: 'all' | 'any' = 'all'): boolean {
  if (keywords.length === 0) return true;
  const haystack = ` ${item.title} ${item.summary}`.toLowerCase().replace(/ё/g, 'е');
  const hit = (k: string) => new RegExp(`(^|[^a-zа-я0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack);
  return mode === 'all' ? keywords.every(hit) : keywords.some(hit);
}

export async function getNews(query: string | undefined, limit = 15): Promise<{ items: NewsItem[]; errors: string[]; sources: string[] }> {
  const errors: string[] = [];
  const batches = await Promise.all([
    ...FEEDS.map(async (f) => {
      try {
        return parseRss(await fetchText(f.url, { ttlMs: 5 * MINUTE }), f.source);
      } catch (e) {
        errors.push(`${f.source}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
    (async () => {
      try {
        return (await getExchangeNews(30)).map((n) => ({
          source: 'Мосбиржа',
          title: n.title,
          summary: '',
          published: new Date(n.published.replace(' ', 'T') + '+03:00').toISOString(),
          url: n.url,
        }));
      } catch (e) {
        errors.push(`Мосбиржа: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    })(),
  ]);
  const keywords = query ? stems(query) : [];
  const all = batches.flat();
  // Prefer items matching every keyword; fall back to any keyword.
  let pool = all.filter((i) => matches(i, keywords, 'all'));
  if (pool.length === 0) pool = all.filter((i) => matches(i, keywords, 'any'));
  const seen = new Set<string>();
  const items = pool
    .filter((i) => (seen.has(i.title) ? false : (seen.add(i.title), true)))
    .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
    .slice(0, limit);
  return { items, errors, sources: [...FEEDS.map((f) => f.url), 'https://www.moex.com/ru/news/'] };
}
