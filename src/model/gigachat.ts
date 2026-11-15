/**
 * GigaChat chat model for LangChain.
 *
 * The published `langchain-gigachat` package converts tool schemas with
 * zod-to-json-schema, which returns an empty schema for zod v4 (used here),
 * so GigaChat would see every tool as argument-less. This adapter talks to the
 * REST API directly: OAuth token cache, function calling, SSE streaming.
 *
 * GigaChat specifics handled here:
 * - one function call per assistant turn (no parallel tool calls);
 * - function results must be JSON objects, sent as role "function";
 * - only the first message may be a system message;
 * - the Freemium tier allows few concurrent requests, so calls go through a
 *   process-wide semaphore (GIGACHAT_MAX_CONCURRENCY, default 1).
 */
import { randomUUID } from 'node:crypto';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { Runnable } from '@langchain/core/runnables';
import { isLangChainTool } from '@langchain/core/utils/function_calling';
import { z } from 'zod';

// GigaChat-3 (Pro, Ultra, Lightning) отдаётся только этим адресом; старый gigachat.devices.sberbank.ru/api/v1 знает лишь поколение 2.
export const GIGACHAT_DEFAULT_API_URL = 'https://api.giga.chat/v1';
/** Строка в журнал на каждый вызов (без текста): помогает ловить обрывы по длине. Включается GIGACHAT_LOG=1. */
function logCall(model: string, finish: string | undefined, tokens: number | undefined, forced: string | undefined, sawCall: boolean, ms: number) {
  if (process.env.GIGACHAT_LOG !== '1') return;
  console.error(`[gigachat] ${model} finish=${finish ?? '?'} out=${tokens ?? '?'} call=${sawCall ? 'yes' : 'no'}${forced ? ` forced=${forced}` : ''} ${ms}ms`);
}

export const GIGACHAT_DEFAULT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';

export interface GigaChatFunction {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

interface GigaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  name?: string;
  function_call?: { name: string; arguments: Record<string, unknown> };
  functions_state_id?: string;
}

interface GigaChatCallOptions extends BaseChatModelCallOptions {
  functions?: GigaChatFunction[];
  /** Имя функции, которую модель обязана вызвать (иначе — auto). */
  tool_choice?: string;
}

export interface ChatGigaChatFields extends BaseChatModelParams {
  model?: string;
  credentials?: string;
  scope?: string;
  apiUrl?: string;
  oauthUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  streaming?: boolean;
}

// ---------------------------------------------------------------------------
// Token cache and concurrency gate (shared by every instance in the process)
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const pendingTokens = new Map<string, Promise<string>>();

async function fetchAccessToken(credentials: string, scope: string, oauthUrl: string, forceRefresh = false): Promise<string> {
  const key = `${scope}:${credentials.slice(-12)}`;
  const cached = tokenCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.token;
  }
  const pending = pendingTokens.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const response = await fetch(oauthUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        RqUID: randomUUID(),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ scope }).toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GigaChat OAuth ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = (await response.json()) as { access_token: string; expires_at: number };
    tokenCache.set(key, { token: data.access_token, expiresAt: data.expires_at });
    return data.access_token;
  })();
  pendingTokens.set(key, promise);
  try {
    return await promise;
  } finally {
    pendingTokens.delete(key);
  }
}

let active = 0;
const waiters: Array<() => void> = [];

function maxConcurrency(): number {
  const raw = Number(process.env.GIGACHAT_MAX_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

async function acquireSlot(): Promise<() => void> {
  if (active >= maxConcurrency()) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    waiters.shift()?.();
  };
}

// ---------------------------------------------------------------------------
// Schema and message conversion
// ---------------------------------------------------------------------------

/**
 * Reduce a JSON schema to the subset GigaChat accepts: no $schema, no
 * additionalProperties, nullable unions collapsed to their non-null branch.
 */
export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;

  for (const unionKey of ['anyOf', 'oneOf']) {
    const branches = src[unionKey];
    if (Array.isArray(branches)) {
      const nonNull = branches.filter((b) => !(b && typeof b === 'object' && (b as { type?: string }).type === 'null'));
      if (nonNull.length === 1) {
        const { [unionKey]: _drop, ...rest } = src;
        return sanitizeSchema({ ...rest, ...(nonNull[0] as object) });
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === '$schema' || key === 'additionalProperties' || key === '$id' || key === '$defs') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeSchema(v)]),
      );
      continue;
    }
    out[key] = sanitizeSchema(value);
  }
  return out;
}

function toGigaChatFunction(tool: BindToolsInput): GigaChatFunction {
  if (isLangChainTool(tool)) {
    const schema = tool.schema as unknown;
    let parameters: Record<string, unknown>;
    if (schema instanceof z.ZodType) {
      parameters = z.toJSONSchema(schema) as Record<string, unknown>;
    } else if (schema && typeof schema === 'object') {
      parameters = schema as Record<string, unknown>;
    } else {
      parameters = { type: 'object', properties: {} };
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeSchema(parameters) as Record<string, unknown>,
    };
  }
  const candidate = tool as unknown as Partial<GigaChatFunction> & { function?: GigaChatFunction };
  if (candidate.function?.name) return { ...candidate.function, parameters: sanitizeSchema(candidate.function.parameters) as Record<string, unknown> };
  if (candidate.name && candidate.parameters) return { name: candidate.name, description: candidate.description, parameters: sanitizeSchema(candidate.parameters) as Record<string, unknown> };
  throw new Error('Unsupported tool definition for GigaChat');
}

function contentToString(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part === 'string' ? part : 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/** Function results must be a JSON object; wrap anything else. */
export function toFunctionContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return raw;
    return JSON.stringify({ result: parsed });
  } catch {
    return JSON.stringify({ result: raw });
  }
}

export function convertMessages(messages: BaseMessage[]): GigaChatMessage[] {
  const out: GigaChatMessage[] = [];
  for (const message of messages) {
    const type = message._getType();
    const text = contentToString(message.content);
    if (type === 'system') {
      // GigaChat accepts a single leading system message.
      if (out.length === 0) out.push({ role: 'system', content: text });
      else out.push({ role: 'user', content: `[Системная заметка]\n${text}` });
    } else if (type === 'human') {
      out.push({ role: 'user', content: text });
    } else if (type === 'ai') {
      const ai = message as AIMessage;
      const call = ai.tool_calls?.[0];
      const entry: GigaChatMessage = { role: 'assistant', content: text };
      if (call) {
        entry.function_call = { name: call.name, arguments: (call.args ?? {}) as Record<string, unknown> };
      }
      const stateId = ai.additional_kwargs?.functions_state_id;
      if (typeof stateId === 'string') entry.functions_state_id = stateId;
      out.push(entry);
    } else if (type === 'tool') {
      out.push({ role: 'function', name: (message as { name?: string }).name, content: toFunctionContent(text) });
    } else {
      out.push({ role: 'user', content: text });
    }
  }
  return out;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Chat model
// ---------------------------------------------------------------------------

export class ChatGigaChat extends BaseChatModel<GigaChatCallOptions, AIMessageChunk> {
  model: string;
  private readonly credentials: string;
  private readonly scope: string;
  private readonly apiUrl: string;
  private readonly oauthUrl: string;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly timeoutMs: number;
  streaming: boolean;

  static lc_name() {
    return 'ChatGigaChat';
  }

  constructor(fields: ChatGigaChatFields = {}) {
    super(fields);
    this.model = fields.model ?? process.env.GIGACHAT_MODEL ?? 'GigaChat-3-Pro';
    this.credentials = fields.credentials ?? process.env.GIGACHAT_CREDENTIALS ?? '';
    this.scope = fields.scope ?? process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS';
    this.apiUrl = (fields.apiUrl ?? process.env.GIGACHAT_API_URL ?? GIGACHAT_DEFAULT_API_URL).replace(/\/$/, '');
    this.oauthUrl = fields.oauthUrl ?? process.env.GIGACHAT_OAUTH_URL ?? GIGACHAT_DEFAULT_OAUTH_URL;
    this.temperature = fields.temperature;
    this.maxTokens = fields.maxTokens ?? 4000;
    this.timeoutMs = fields.timeoutMs ?? 90_000;
    this.streaming = fields.streaming ?? false;
    if (!this.credentials) {
      throw new Error('[LLM] GIGACHAT_CREDENTIALS not found in environment variables');
    }
  }

  _llmType(): string {
    return 'gigachat';
  }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<GigaChatCallOptions>): Runnable<
    BaseMessage[] | string,
    AIMessageChunk,
    GigaChatCallOptions
  > {
    return this.withConfig({ functions: tools.map(toGigaChatFunction), ...kwargs } as Partial<GigaChatCallOptions>);
  }

  private buildBody(messages: BaseMessage[], options: this['ParsedCallOptions'], stream: boolean) {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: convertMessages(messages),
      stream,
      max_tokens: this.maxTokens,
    };
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (options.functions?.length) {
      body.functions = options.functions;
      const forced = options.tool_choice && options.functions.some((f) => f.name === options.tool_choice);
      body.function_call = forced ? { name: options.tool_choice } : 'auto';
      // Аргументам функции хватает сотни токенов. Иногда GigaChat зацикливается и тратит весь лимит
      // невидимо — с малым лимитом такая попытка стоит секунды, а не полминуты, и агент её повторит.
      if (forced) body.max_tokens = Math.min(this.maxTokens ?? 4000, 600);
    }
    return body;
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const doFetch = async (forceRefresh: boolean) => {
      const token = await fetchAccessToken(this.credentials, this.scope, this.oauthUrl, forceRefresh);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      return fetch(`${this.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: body.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    };
    let response = await doFetch(false);
    if (response.status === 401) {
      response = await doFetch(true);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Status codes in the message let classifyError() pick retry behaviour.
      throw new Error(`GigaChat ${response.status}: ${text.slice(0, 300)}`);
    }
    return response;
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const release = await acquireSlot();
    try {
      const started = Date.now();
      const response = await this.post(this.buildBody(messages, options, false), options.signal);
      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content?: string;
            function_call?: { name: string; arguments: unknown };
            functions_state_id?: string;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const choice = data.choices[0];
      const call = choice?.message.function_call;
      logCall(this.model, choice?.finish_reason, data.usage?.completion_tokens, options.tool_choice, !!call, Date.now() - started);
      const message = new AIMessage({
        content: choice?.message.content ?? '',
        tool_calls: call ? [{ name: call.name, args: parseArguments(call.arguments), id: randomUUID(), type: 'tool_call' }] : [],
        additional_kwargs: choice?.message.functions_state_id ? { functions_state_id: choice.message.functions_state_id } : {},
        usage_metadata: data.usage
          ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens, total_tokens: data.usage.total_tokens }
          : undefined,
        response_metadata: { finish_reason: choice?.finish_reason, model: this.model },
      });
      return { generations: [{ text: contentToString(message.content), message }] };
    } finally {
      release();
    }
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const release = await acquireSlot();
    try {
      const started = Date.now();
      const response = await this.post(this.buildBody(messages, options, true), options.signal);
      if (!response.body) throw new Error('GigaChat stream has no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastFinish: string | undefined;
      let lastTokens: number | undefined;
      let sawCall = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let event: {
            choices?: Array<{
              delta?: { content?: string; function_call?: { name: string; arguments: unknown }; functions_state_id?: string };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = event.choices?.[0]?.delta;
          const text = delta?.content ?? '';
          const call = delta?.function_call;
          const finishReason = event.choices?.[0]?.finish_reason ?? undefined;
          if (finishReason) lastFinish = finishReason;
          if (event.usage) lastTokens = event.usage.completion_tokens;
          if (call) sawCall = true;
          const chunk = new AIMessageChunk({
            content: text,
            tool_call_chunks: call
              ? [{ name: call.name, args: JSON.stringify(parseArguments(call.arguments)), id: randomUUID(), index: 0, type: 'tool_call_chunk' }]
              : [],
            additional_kwargs: delta?.functions_state_id ? { functions_state_id: delta.functions_state_id } : {},
            // «length» значит, что ответ оборван лимитом токенов: агент повторит запрос.
            response_metadata: finishReason ? { finish_reason: finishReason } : {},
            usage_metadata: event.usage
              ? { input_tokens: event.usage.prompt_tokens, output_tokens: event.usage.completion_tokens, total_tokens: event.usage.total_tokens }
              : undefined,
          });
          if (!text && !call && !event.usage && !finishReason) continue;
          yield new ChatGenerationChunk({ text, message: chunk });
          if (text) await runManager?.handleLLMNewToken(text);
        }
      }
      logCall(this.model, lastFinish, lastTokens, options.tool_choice, sawCall, Date.now() - started);
    } finally {
      release();
    }
  }
}

/** List models available to the configured credentials (used by diagnostics). */
export async function listGigaChatModels(): Promise<string[]> {
  const credentials = process.env.GIGACHAT_CREDENTIALS ?? '';
  const scope = process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS';
  const oauthUrl = process.env.GIGACHAT_OAUTH_URL ?? GIGACHAT_DEFAULT_OAUTH_URL;
  const apiUrl = (process.env.GIGACHAT_API_URL ?? GIGACHAT_DEFAULT_API_URL).replace(/\/$/, '');
  const token = await fetchAccessToken(credentials, scope, oauthUrl);
  const response = await fetch(`${apiUrl}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GigaChat models ${response.status}`);
  const data = (await response.json()) as { data: Array<{ id: string }> };
  return data.data.map((m) => m.id);
}
