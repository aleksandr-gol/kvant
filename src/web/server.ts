/**
 * Web edition of Kvant RU: a Bun HTTP server that streams agent steps over
 * Server-Sent Events. Run: `bun run web` (PORT, default 8787).
 *
 * The site is public and every request spends the owner's LLM quota, so it
 * enforces per-session and daily limits and a cap on concurrent runs. Behind
 * an SSH tunnel all clients share one IP, hence limits are per session.
 */
import { join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent } from '../agent/agent.js';
import { checkAnswerNumbers, type NumberCheckResult } from '../agent/number-check.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { DEFAULT_MODEL } from '../model/llm.js';
import { getToolRegistry } from '../tools/registry.js';
import type { AgentEvent } from '../agent/types.js';
import { TOOL_LABELS, summarizeToolResult, extractChart } from './tool-view.js';

const ROOT = join(import.meta.dir, '../..');
const PUBLIC_DIR = join(ROOT, 'web/public');

const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  model: process.env.WEB_MODEL ?? DEFAULT_MODEL,
  maxIterations: Number(process.env.WEB_MAX_ITERATIONS ?? 20),
  maxConcurrentRuns: Number(process.env.WEB_MAX_CONCURRENT_RUNS ?? 2),
  maxQueue: Number(process.env.WEB_MAX_QUEUE ?? 8),
  dailyLimit: Number(process.env.WEB_DAILY_LIMIT ?? 300),
  sessionHourlyLimit: Number(process.env.WEB_SESSION_HOURLY_LIMIT ?? 15),
  maxMessageChars: 2000,
  runTimeoutMs: Number(process.env.WEB_RUN_TIMEOUT_MS ?? 420_000),
};

/** Tools exposed on the public site: market data and read-only helpers. No files, shell or browser. */
const WEB_TOOL_NAMES = [
  'find_instrument',
  'get_quotes',
  'get_price_history',
  'get_company_financials',
  'get_dividends',
  'screen_stocks',
  'get_bonds',
  'get_macro',
  'get_news',
  'analyze_portfolio',
  'plan_savings',
  'draft_order',
  'web_fetch',
  'web_search',
  'skill',
];

// ---------------------------------------------------------------------------
// Sessions and limits
// ---------------------------------------------------------------------------

interface Session {
  history: InMemoryChatHistory;
  lastUsed: number;
  queries: number[];
  running: boolean;
}

const sessions = new Map<string, Session>();
let daily = { day: new Date().toISOString().slice(0, 10), count: 0 };
let running = 0;
const waiting: Array<() => void> = [];

function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { history: new InMemoryChatHistory(config.model, 6, false), lastUsed: Date.now(), queries: [], running: false };
    sessions.set(id, s);
  }
  s.lastUsed = Date.now();
  return s;
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 3600_000;
  for (const [id, s] of sessions) if (!s.running && s.lastUsed < cutoff) sessions.delete(id);
}, 10 * 60_000).unref?.();

function checkLimits(s: Session): string | null {
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, count: 0 };
  if (daily.count >= config.dailyLimit) return 'Дневной лимит запросов к демо-стенду исчерпан. Возвращайтесь завтра.';
  const hourAgo = Date.now() - 3600_000;
  s.queries = s.queries.filter((t) => t > hourAgo);
  if (s.queries.length >= config.sessionHourlyLimit) return 'Слишком много запросов за час. Подождите немного.';
  if (s.running) return 'Предыдущий запрос ещё выполняется.';
  if (waiting.length >= config.maxQueue) return 'Стенд перегружен, попробуйте через минуту.';
  return null;
}

async function acquireRun(onQueued: (position: number) => void): Promise<() => void> {
  if (running >= config.maxConcurrentRuns) {
    onQueued(waiting.length + 1);
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running--;
    waiting.shift()?.();
  };
}

// ---------------------------------------------------------------------------
// Chat endpoint (SSE)
// ---------------------------------------------------------------------------

type Send = (event: Record<string, unknown>) => void;

async function runChat(session: Session, message: string, send: Send, signal: AbortSignal): Promise<void> {
  const available = new Set(getToolRegistry(config.model).map((t) => t.name));
  const agent = await Agent.create({
    model: config.model,
    channel: 'web',
    memoryEnabled: false,
    maxIterations: config.maxIterations,
    toolAllowlist: WEB_TOOL_NAMES.filter((n) => available.has(n)),
    signal,
  });

  session.history.saveUserQuery(message);
  const toolResults: string[] = [];
  let answer = '';
  try {
    for await (const ev of agent.run(message, session.history) as AsyncGenerator<AgentEvent>) {
      if (signal.aborted) break;
      switch (ev.type) {
        case 'tool_start':
          send({ type: 'tool_start', id: ev.toolCallId, tool: ev.tool, label: TOOL_LABELS[ev.tool] ?? ev.tool, args: ev.args });
          break;
        case 'tool_end': {
          toolResults.push(ev.result);
          const view = summarizeToolResult(ev.tool, ev.result);
          send({ type: 'tool_end', id: ev.toolCallId, tool: ev.tool, ms: ev.duration, ...view, chart: extractChart(ev.tool, ev.result) });
          break;
        }
        case 'tool_error':
          send({ type: 'tool_end', id: ev.toolCallId, tool: ev.tool, ok: false, summary: ev.error, sources: [] });
          break;
        case 'thinking':
          send({ type: 'thinking', text: ev.message });
          break;
        case 'done': {
          answer = ev.answer;
          const check: NumberCheckResult = checkAnswerNumbers(answer, toolResults);
          send({ type: 'answer', text: answer });
          send({ type: 'check', ...check, toolCalls: toolResults.length });
          send({ type: 'done', ms: ev.totalTime, iterations: ev.iterations, tokens: ev.tokenUsage?.totalTokens ?? null });
          break;
        }
        default:
          break;
      }
    }
  } finally {
    if (answer) await session.history.saveAnswer(answer);
    else session.history.pruneLastTurn();
  }
}

function sse(req: Request, body: { sessionId?: string; message?: string }): Response {
  const message = (body.message ?? '').trim();
  const sessionId = /^[a-zA-Z0-9-]{8,64}$/.test(body.sessionId ?? '') ? body.sessionId! : randomUUID();
  if (!message) return Response.json({ error: 'Пустое сообщение' }, { status: 400 });
  if (message.length > config.maxMessageChars) {
    return Response.json({ error: `Сообщение длиннее ${config.maxMessageChars} символов` }, { status: 413 });
  }
  if (!process.env.GIGACHAT_CREDENTIALS && config.model.startsWith('GigaChat')) {
    return Response.json({ error: 'Модель не настроена: на сервере нет ключа GigaChat' }, { status: 503 });
  }
  const session = getSession(sessionId);
  const limitError = checkLimits(session);
  if (limitError) return Response.json({ error: limitError }, { status: 429 });

  session.running = true;
  session.queries.push(Date.now());
  daily.count++;

  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const timeout = setTimeout(() => abort.abort(), config.runTimeoutMs);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send: Send = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // Keep proxies from closing an idle stream while the model thinks.
      const ping = setInterval(() => send({ type: 'ping' }), 15_000);
      send({ type: 'session', sessionId });
      const release = await acquireRun((position) => send({ type: 'queued', position }));
      try {
        send({ type: 'start' });
        await runChat(session, message, send, abort.signal);
      } catch (e) {
        send({ type: 'error', message: abort.signal.aborted ? 'Запрос прерван по таймауту' : e instanceof Error ? e.message : String(e) });
      } finally {
        release();
        clearInterval(ping);
        clearTimeout(timeout);
        session.running = false;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const VENDOR: Record<string, string> = {
  '/vendor/marked.js': join(ROOT, 'node_modules/marked/lib/marked.umd.js'),
  '/vendor/purify.js': join(ROOT, 'node_modules/dompurify/dist/purify.min.js'),
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

async function serveStatic(pathname: string): Promise<Response> {
  const vendor = VENDOR[pathname];
  const filePath = vendor ?? normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!vendor && !filePath.startsWith(PUBLIC_DIR)) return new Response('Not found', { status: 404 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response('Not found', { status: 404 });
  const cache = pathname === '/' || pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=300';
  return new Response(file, { headers: { ...SECURITY_HEADERS, 'Cache-Control': cache } });
}

export function startServer() {
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') {
        return Response.json({
          ok: true,
          model: config.model,
          llmConfigured: Boolean(process.env.GIGACHAT_CREDENTIALS) || !config.model.startsWith('GigaChat'),
          running,
          queued: waiting.length,
          dailyUsed: daily.count,
          dailyLimit: config.dailyLimit,
        });
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        let body: { sessionId?: string; message?: string };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: 'Некорректный JSON' }, { status: 400 });
        }
        return sse(req, body);
      }
      if (url.pathname === '/api/reset' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
        if (body.sessionId) sessions.get(body.sessionId)?.history.clear();
        return Response.json({ ok: true });
      }
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return serveStatic(url.pathname);
    },
  });
  console.log(`Kvant RU web: http://${server.hostname}:${server.port} (model ${config.model})`);
  return server;
}

if (import.meta.main) {
  startServer();
}
