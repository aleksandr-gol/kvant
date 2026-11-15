import { AIMessage, AIMessageChunk, SystemMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { callLlmWithMessages, streamLlmWithMessages } from '../model/llm.js';
import { getTools, getToolConcurrencyMap } from '../tools/registry.js';
import { buildSystemPrompt, loadSoulDocument, loadRulesDocument } from './prompts.js';
import { extractTextContent, hasToolCalls } from '../utils/ai-message.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { estimateTokens, getAutoCompactThreshold, KEEP_TOOL_USES } from '../utils/tokens.js';
import { exceedsSizeCap, persistLargeResult, buildPersistedContent } from '../utils/tool-result-storage.js';
import { enforceResultBudget } from '../utils/tool-result-budget.js';
import { formatUserFacingError, isContextOverflowError } from '../utils/errors.js';
import type { AgentConfig, AgentEvent, CompactionEvent, ContextClearedEvent, MicrocompactEvent, QueueDrainEvent, StreamMode, StreamProgressEvent, TokenUsage } from '../agent/types.js';
import type { MessageQueue } from '../utils/message-queue.js';
import { compactContext, MAX_CONSECUTIVE_COMPACTION_FAILURES, MIN_TOOL_RESULTS_FOR_COMPACTION } from './compact.js';
import { microcompactMessages } from './microcompact.js';
import { createRunContext, type RunContext } from './run-context.js';
import { AgentToolExecutor } from './tool-executor.js';
import { MemoryManager } from '../memory/index.js';
import { runMemoryFlush, shouldRunMemoryFlush } from '../memory/flush.js';
import { resolveProvider } from '../providers.js';


import { DEFAULT_MODEL } from '../model/llm.js';
// GigaChat вызывает один инструмент за ход, поэтому шагов нужно больше.
const DEFAULT_MAX_ITERATIONS = 20;
const MAX_FORCED_ATTEMPTS = 3;
const TRUNCATED_NOTE =
  '[Системная заметка] Предыдущий ответ оборвался по лимиту длины и не дошёл до пользователя. Если нужен инструмент — вызови его сразу, без текста. Иначе дай итоговый ответ короче.';
/** Просьба о сделке: «купи», «продай», «заявка», «черновик». «Стоит ли покупать» сюда не попадает. */
const ORDER_REQUEST = /(^|[^а-яё])(купи(те|ть)?|прода(й|йте|ть)|заявк[аиуе]|заявок|черновик[аиов]*)([^а-яё]|$)/i;
/** Текст при вызове инструмента похож на часть ответа, а не на короткое «сейчас посмотрю». */
export function looksLikeAnswerText(text: string): boolean {
  return text.length >= 200 && (/^\s*\|.+\|\s*$/m.test(text) || /^#{1,4}\s/m.test(text) || text.length >= 600);
}

/** Склеивает куски ответа, написанные по ходу, с финальным текстом, не дублируя их. */
export function mergeAnswerParts(parts: string[], final: string): string {
  const finalText = final.trim();
  // Сравниваем без пробелов и разметки: модель часто повторяет ту же таблицу с другими отступами.
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const finalNorm = norm(finalText);
  const kept = parts.filter((p) => !finalNorm.includes(norm(p).slice(0, 60)));
  return [...kept, finalText].filter(Boolean).join('\n\n');
}

const FINAL_STEP_NOTE =
  '[Системная заметка] Это последний шаг: инструменты больше недоступны. Дай итоговый ответ только по уже полученным результатам инструментов. Не пиши чисел, которых в них нет, даже приблизительных: для таких пунктов прямо скажи, что данные не успел получить, и предложи задать вопрос уже.';
const MAX_OVERFLOW_RETRIES = 2;
const OVERFLOW_KEEP_ROUNDS = 3;

/** Tools that require an interactive user and are only bound on the CLI channel. */
const CLI_ONLY_TOOLS = new Set<string>(['ask_user_question', 'bash']);

/**
 * The core agent class that handles the agent loop and tool execution.
 *
 * Architecture:
 * - Growing message array with full reasoning continuity
 * - Concurrent execution for read-only tools
 * - Streaming LLM responses with fallback to blocking
 * - Per-turn microcompact + threshold-based full compaction
 */
export class Agent {
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly tools: StructuredToolInterface[];
  private readonly toolMap: Map<string, StructuredToolInterface>;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly systemPrompt: string;
  private readonly signal?: AbortSignal;
  private readonly memoryEnabled: boolean;
  private readonly messageQueue?: MessageQueue;
  private compactionFailures: number = 0;

  private constructor(
    config: AgentConfig,
    tools: StructuredToolInterface[],
    systemPrompt: string,
    concurrencyMap: Map<string, boolean>,
  ) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.tools = tools;
    this.toolMap = new Map(tools.map(t => [t.name, t]));
    this.toolExecutor = new AgentToolExecutor(
      this.toolMap,
      concurrencyMap,
      config.signal,
      config.requestToolApproval,
      config.sessionApprovedTools,
      undefined,
      config.requestUserInput,
    );
    this.systemPrompt = systemPrompt;
    this.signal = config.signal;
    this.memoryEnabled = config.memoryEnabled ?? true;
    this.messageQueue = config.messageQueue;
  }

  static async create(config: AgentConfig = {}): Promise<Agent> {
    const model = config.model ?? DEFAULT_MODEL;
    const allTools = getTools(model);
    let tools = config.toolAllowlist
      ? allTools.filter(t => config.toolAllowlist!.includes(t.name))
      : allTools;
    // CLI-only tools (interactive prompts) are dropped on non-CLI channels
    // (WhatsApp/gateway) and in headless runs, where there is no user at a keyboard.
    const isCli = !config.channel || config.channel === 'cli';
    if (!isCli) {
      tools = tools.filter(t => !CLI_ONLY_TOOLS.has(t.name));
    }
    // The concurrency map is a name→bool lookup; extra entries are harmless since
    // toolMap only holds the (possibly filtered) tools above.
    const concurrencyMap = getToolConcurrencyMap(model);

    let systemPrompt: string;
    if (config.systemPromptOverride) {
      // Self-contained worker prompt: skip soul, rules, and memory context.
      systemPrompt = config.systemPromptOverride;
    } else {
      const soulContent = await loadSoulDocument();
      const rulesContent = await loadRulesDocument();
      let memoryFiles: string[] = [];
      let memoryContext: string | null = null;

      if (config.memoryEnabled !== false) {
        const memoryManager = await MemoryManager.get();
        memoryFiles = await memoryManager.listFiles();
        const session = await memoryManager.loadSessionContext();
        if (session.text.trim()) {
          memoryContext = session.text;
        }
      }

      systemPrompt = buildSystemPrompt(
        model,
        soulContent,
        config.channel,
        config.groupContext,
        memoryFiles,
        memoryContext,
        rulesContent,
        config.memoryEnabled !== false,
      );
    }
    return new Agent(config, tools, systemPrompt, concurrencyMap);
  }

  /**
   * Run the agent with streaming, concurrent tools, and microcompact.
   */
  async *run(query: string, inMemoryHistory?: InMemoryChatHistory): AsyncGenerator<AgentEvent> {
    const startTime = Date.now();

    if (this.tools.length === 0) {
      yield { type: 'done', answer: 'No tools available. Please check your API key configuration.', toolCalls: [], iterations: 0, totalTime: Date.now() - startTime };
      return;
    }

    const ctx = createRunContext(query);
    const memoryFlushState = { alreadyFlushed: false };

    // Build initial message array
    const historyMessages = inMemoryHistory?.getRecentTurnsAsMessages() ?? [];
    let messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      ...historyMessages,
      new HumanMessage(query),
    ];

    // Main agent loop
    let overflowRetries = 0;
    let truncatedRetried = false;
    let orderForceAttempts = 0;
    let forceTool: string | undefined;
    // GigaChat нередко пишет часть ответа (таблицу, сравнение) в том же ходе, что и вызов инструмента.
    // Такие куски не должны пропасть: они идут в начало итогового ответа.
    const answerParts: string[] = [];
    while (ctx.iteration < this.maxIterations) {
      ctx.iteration++;

      // Microcompact: per-turn lightweight trimming before LLM call
      const mcResult = microcompactMessages(messages);
      if (mcResult.trigger) {
        messages = mcResult.messages;
        yield { type: 'microcompact', cleared: mcResult.cleared, tokensSaved: mcResult.estimatedTokensSaved } as MicrocompactEvent;
      }

      // Strip old reasoning from AIMessages (keep last 2 for continuity)
      this.stripOldThinking(messages, 2);

      let response: AIMessage;
      let usage: TokenUsage | undefined;

      // Последний шаг: вместо «лимит исчерпан» просим ответ по собранным данным, без инструментов.
      const finalStep = ctx.iteration === this.maxIterations && ctx.iteration > 1;
      if (finalStep) messages.push(new HumanMessage(FINAL_STEP_NOTE));

      // Call LLM with streaming (falls back to blocking on error)
      while (true) {
        try {
          const result = yield* this.callModelWithStreaming(messages, finalStep, finalStep ? undefined : forceTool);
          response = result.response;
          usage = result.usage;
          overflowRetries = 0;
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (isContextOverflowError(errorMessage) && overflowRetries < MAX_OVERFLOW_RETRIES) {
            overflowRetries++;
            const removed = this.truncateMessages(messages, OVERFLOW_KEEP_ROUNDS);
            if (removed > 0) {
              yield { type: 'context_cleared', clearedCount: removed, keptCount: OVERFLOW_KEEP_ROUNDS };
              continue;
            }
          }

          const totalTime = Date.now() - ctx.startTime;
          const provider = resolveProvider(this.model).displayName;
          yield {
            type: 'done',
            answer: `Error: ${formatUserFacingError(errorMessage, provider)}`,
            toolCalls: ctx.scratchpad.getToolCallRecords(),
            iterations: ctx.iteration,
            totalTime,
            tokenUsage: ctx.tokenCounter.getUsage(),
            tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
          };
          return;
        }
      }

      forceTool = undefined;
      ctx.tokenCounter.add(usage);
      if (usage?.inputTokens) {
        ctx.lastApiInputTokens = usage.inputTokens;
      }

      const responseText = extractTextContent(response);

      // Emit thinking if there are also tool calls
      if (responseText?.trim() && hasToolCalls(response)) {
        const trimmedText = responseText.trim();
        if (looksLikeAnswerText(trimmedText)) answerParts.push(trimmedText);
        ctx.scratchpad.addThinking(trimmedText);
        yield { type: 'thinking', message: trimmedText };
      }

      // No tool calls = final answer
      if (!hasToolCalls(response)) {
        const notLast = ctx.iteration < this.maxIterations;
        const truncated = response.response_metadata?.finish_reason === 'length';
        const asksUser = !truncated && /\?\s*$/.test((responseText ?? '').trim());
        // Просили сделку, а модель не вызвала draft_order: посчитала лоты сама или оборвалась, пытаясь
        // вызвать его после текста (у GigaChat такой вызов зацикливается до лимита токенов).
        // Ответ отбрасываем и повторяем ход с обязательным draft_order — так модель вызывает его сразу.
        if (notLast && orderForceAttempts < MAX_FORCED_ATTEMPTS && !asksUser && this.needsOrderTool(query, ctx)) {
          orderForceAttempts++;
          forceTool = 'draft_order';
          continue;
        }
        // GigaChat иногда тратит весь лимит токенов невидимо и обрывает ответ — один повтор.
        if (notLast && !truncatedRetried && truncated) {
          truncatedRetried = true;
          messages.push(new HumanMessage(TRUNCATED_NOTE));
          continue;
        }
        yield* this.handleDirectResponse(mergeAnswerParts(answerParts, responseText ?? ''), ctx);
        return;
      }

      // Push AIMessage to conversation history
      messages.push(response);

      // Execute tools concurrently where safe, collect ToolMessages by ID
      let { toolMessages, denied } = yield* this.executeToolsAndCollectMessages(response, ctx);

      // Cap large results (persist to disk, inject preview)
      toolMessages = toolMessages.map(tm => {
        const content = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content);
        if (exceedsSizeCap(content)) {
          const { preview, filePath } = persistLargeResult(tm.name ?? 'unknown', tm.tool_call_id, content);
          return new ToolMessage({
            content: buildPersistedContent(filePath, preview, content.length),
            tool_call_id: tm.tool_call_id,
            name: tm.name,
          });
        }
        return tm;
      });

      // Enforce per-turn total budget
      toolMessages = enforceResultBudget(toolMessages);

      messages.push(...toolMessages);

      if (denied) {
        const totalTime = Date.now() - ctx.startTime;
        yield {
          type: 'done',
          answer: '',
          toolCalls: ctx.scratchpad.getToolCallRecords(),
          iterations: ctx.iteration,
          totalTime,
          tokenUsage: ctx.tokenCounter.getUsage(),
          tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
        };
        return;
      }

      // Context threshold management (may compact the message array)
      const messageState = { messages };
      yield* this.manageContextThreshold(ctx, query, memoryFlushState, messageState);
      messages = messageState.messages;

      // Inject tool usage warning only when a tool nears its soft limit: an extra user turn after every
      // function result confuses GigaChat.
      const nearLimit = ctx.scratchpad.getToolUsageStatus().some((s) => s.callCount >= s.maxCalls - 1);
      const toolUsageWarning = nearLimit ? ctx.scratchpad.formatToolUsageForPrompt() : null;
      if (toolUsageWarning) {
        messages.push(new HumanMessage(toolUsageWarning));
      }

      // Drain queued messages: user may have sent follow-ups while agent was working
      const drainResult = this.drainQueue();
      if (drainResult) {
        messages.push(new HumanMessage(drainResult.text));
        yield { type: 'queue_drain', messageCount: drainResult.count, mergedText: drainResult.text, texts: drainResult.texts } as QueueDrainEvent;
      }
    }

    // Max iterations reached
    const totalTime = Date.now() - ctx.startTime;
    yield {
      type: 'done',
      answer: `Достигнут лимит шагов (${this.maxIterations}): исследование не уложилось в отведённое число итераций. Попробуйте сузить вопрос.`,
      toolCalls: ctx.scratchpad.getToolCallRecords(),
      iterations: ctx.iteration,
      totalTime,
      tokenUsage: ctx.tokenCounter.getUsage(),
      tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
    };
  }

  // ---------------------------------------------------------------------------
  // LLM call methods
  // ---------------------------------------------------------------------------

  /**
   * Call LLM with streaming, falling back to blocking invoke on error.
   * Yields StreamProgressEvents as chunks arrive; returns the final accumulated message.
   */
  private async *callModelWithStreaming(
    messages: BaseMessage[],
    withoutTools = false,
    toolChoice?: string,
  ): AsyncGenerator<StreamProgressEvent, { response: AIMessage; usage?: TokenUsage }> {
    try {
      return yield* this.streamAndAccumulate(messages, withoutTools, toolChoice);
    } catch {
      // Fallback to blocking invoke (handles providers without streaming support)
      return await this.callModelWithMessages(messages, withoutTools, toolChoice);
    }
  }

  /**
   * Stream the LLM response, yielding per-chunk progress events and finally
   * returning the accumulated AIMessage. Stream-mode lifecycle:
   * 'requesting' before the first chunk, then 'thinking'/'responding'/'tool-input'
   * derived from chunk content shape, then 'tool-use' after stream end if there
   * are tool calls awaiting execution.
   */
  private async *streamAndAccumulate(
    messages: BaseMessage[],
    withoutTools = false,
    toolChoice?: string,
  ): AsyncGenerator<StreamProgressEvent, { response: AIMessage; usage?: TokenUsage }> {
    yield { type: 'stream_progress', charDelta: 0, mode: 'requesting' };

    let accumulated: AIMessageChunk | null = null;

    for await (const chunk of streamLlmWithMessages(messages, {
      model: this.model,
      tools: withoutTools ? undefined : this.tools,
      toolChoice,
      signal: this.signal,
    })) {
      accumulated = accumulated ? accumulated.concat(chunk) : chunk;
      const { charDelta, mode } = inspectChunkContent(chunk);
      if (charDelta > 0 || mode !== 'responding') {
        yield { type: 'stream_progress', charDelta, mode };
      }
    }

    if (!accumulated) {
      throw new Error('Stream produced no chunks');
    }

    const response = new AIMessage({
      content: accumulated.content,
      tool_calls: accumulated.tool_calls,
      invalid_tool_calls: accumulated.invalid_tool_calls,
      usage_metadata: accumulated.usage_metadata,
      response_metadata: accumulated.response_metadata,
    });

    if (response.tool_calls && response.tool_calls.length > 0) {
      yield { type: 'stream_progress', charDelta: 0, mode: 'tool-use' };
    }

    const usage = accumulated.usage_metadata
      ? {
          inputTokens: accumulated.usage_metadata.input_tokens ?? 0,
          outputTokens: accumulated.usage_metadata.output_tokens ?? 0,
          totalTokens: accumulated.usage_metadata.total_tokens ?? 0,
        }
      : undefined;

    return { response, usage };
  }

  /**
   * Blocking LLM call (fallback when streaming fails).
   */
  private async callModelWithMessages(
    messages: BaseMessage[],
    withoutTools = false,
    toolChoice?: string,
  ): Promise<{ response: AIMessage; usage?: TokenUsage }> {
    const result = await callLlmWithMessages(messages, {
      model: this.model,
      tools: withoutTools ? undefined : this.tools,
      toolChoice,
      signal: this.signal,
    });
    return { response: result.response as AIMessage, usage: result.usage };
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  /**
   * Execute tools and collect ToolMessages mapped by tool_call_id.
   * Supports concurrent execution — events may arrive out of order.
   */
  private async *executeToolsAndCollectMessages(
    response: AIMessage,
    ctx: RunContext,
  ): AsyncGenerator<AgentEvent, { toolMessages: ToolMessage[]; denied: boolean }> {
    const toolMessageMap = new Map<string, ToolMessage>();
    let denied = false;
    const toolCalls = response.tool_calls!;

    for await (const event of this.toolExecutor.executeAll(response, ctx)) {
      yield event;

      if (event.type === 'tool_end' && event.toolCallId) {
        toolMessageMap.set(event.toolCallId, new ToolMessage({
          content: event.result,
          tool_call_id: event.toolCallId,
          name: event.tool,
        }));
      } else if (event.type === 'tool_error' && event.toolCallId) {
        toolMessageMap.set(event.toolCallId, new ToolMessage({
          content: `Error: ${event.error}`,
          tool_call_id: event.toolCallId,
          name: event.tool,
        }));
      } else if (event.type === 'tool_denied' && event.toolCallId) {
        toolMessageMap.set(event.toolCallId, new ToolMessage({
          content: 'Tool execution denied by user.',
          tool_call_id: event.toolCallId,
          name: event.tool,
        }));
        denied = true;
      }
    }

    // Produce ToolMessages in ORIGINAL tool_calls order
    const toolMessages: ToolMessage[] = toolCalls.map(tc =>
      toolMessageMap.get(tc.id!) ?? new ToolMessage({
        content: 'Skipped (already executed).',
        tool_call_id: tc.id!,
        name: tc.name,
      }),
    );

    return { toolMessages, denied };
  }

  // ---------------------------------------------------------------------------
  // Message queue
  // ---------------------------------------------------------------------------

  /**
   * Drain all queued messages, merge into a single text block.
   * Returns null if the queue is empty or not configured.
   */
  private drainQueue(): { text: string; count: number; texts: string[] } | null {
    if (!this.messageQueue || this.messageQueue.isEmpty()) {
      return null;
    }
    const messages = this.messageQueue.dequeueAll();
    if (messages.length === 0) return null;
    const texts = messages.map(m => m.text);
    return {
      text: texts.join('\n\n'),
      count: messages.length,
      texts,
    };
  }

  // ---------------------------------------------------------------------------
  // Response handling
  // ---------------------------------------------------------------------------

  private needsOrderTool(query: string, ctx: RunContext): boolean {
    if (!ORDER_REQUEST.test(query)) return false;
    if (!this.tools.some((t) => t.name === 'draft_order')) return false;
    return !ctx.scratchpad.getToolCallRecords().some((r) => r.tool === 'draft_order');
  }

  private async *handleDirectResponse(
    responseText: string,
    ctx: RunContext,
  ): AsyncGenerator<AgentEvent, void> {
    const totalTime = Date.now() - ctx.startTime;
    yield {
      type: 'done',
      answer: responseText,
      toolCalls: ctx.scratchpad.getToolCallRecords(),
      iterations: ctx.iteration,
      totalTime,
      tokenUsage: ctx.tokenCounter.getUsage(),
      tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
    };
  }

  // ---------------------------------------------------------------------------
  // Message array management
  // ---------------------------------------------------------------------------

  /**
   * Remove oldest AI+Tool message rounds, keeping SystemMessage, history,
   * HumanMessage, and the most recent N rounds.
   */
  /**
   * Strip text content from old AIMessages, keeping only the most recent N.
   * Preserves tool_calls structure (required for ToolMessage pairing).
   */
  private stripOldThinking(messages: BaseMessage[], keepLast: number): void {
    // Collect indices of AIMessages with text content
    const aiIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] instanceof AIMessage) {
        aiIndices.push(i);
      }
    }

    // Only strip if we have more than keepLast AIMessages
    const toStrip = aiIndices.slice(0, -keepLast);
    for (const idx of toStrip) {
      const msg = messages[idx] as AIMessage;
      // Only strip if it has tool_calls (reasoning before tools — safe to clear)
      if (msg.tool_calls && msg.tool_calls.length > 0 && msg.content) {
        messages[idx] = new AIMessage({
          content: '',
          tool_calls: msg.tool_calls,
          invalid_tool_calls: msg.invalid_tool_calls,
          usage_metadata: msg.usage_metadata,
          response_metadata: msg.response_metadata,
        });
      }
    }
  }

  private truncateMessages(messages: BaseMessage[], keepRounds: number): number {
    let roundStartIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] instanceof AIMessage) {
        roundStartIndex = i;
        break;
      }
    }
    if (roundStartIndex === -1) return 0;

    const rounds: { start: number; end: number }[] = [];
    let i = roundStartIndex;
    while (i < messages.length) {
      if (messages[i] instanceof AIMessage) {
        const start = i;
        i++;
        while (i < messages.length && (messages[i] instanceof ToolMessage || messages[i] instanceof HumanMessage)) {
          i++;
        }
        rounds.push({ start, end: i });
      } else {
        i++;
      }
    }

    const roundsToRemove = Math.max(0, rounds.length - keepRounds);
    if (roundsToRemove === 0) return 0;

    const removeEnd = rounds[roundsToRemove - 1].end;
    const removed = removeEnd - roundStartIndex;
    messages.splice(roundStartIndex, removed);
    return removed;
  }

  /**
   * Replace message array with compacted version after LLM summarization.
   */
  private compactMessages(messages: BaseMessage[], summary: string, query: string): BaseMessage[] {
    return [
      messages[0], // SystemMessage
      new HumanMessage(`${query}\n\n${summary}`),
    ];
  }

  // ---------------------------------------------------------------------------
  // Context threshold management
  // ---------------------------------------------------------------------------

  private async *manageContextThreshold(
    ctx: RunContext,
    query: string,
    memoryFlushState: { alreadyFlushed: boolean },
    messageState: { messages: BaseMessage[] },
  ): AsyncGenerator<ContextClearedEvent | CompactionEvent | AgentEvent, void> {
    const estimatedContextTokens = ctx.lastApiInputTokens > 0
      ? ctx.lastApiInputTokens
      : estimateTokens(messageState.messages.map(m =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ).join('\n'));
    const threshold = getAutoCompactThreshold(this.model);

    if (estimatedContextTokens <= threshold) {
      return;
    }

    // Step 1: Memory flush
    const fullToolResults = ctx.scratchpad.getToolResults();
    if (
      this.memoryEnabled &&
      shouldRunMemoryFlush({
        estimatedContextTokens,
        threshold,
        alreadyFlushed: memoryFlushState.alreadyFlushed,
      })
    ) {
      yield { type: 'memory_flush', phase: 'start' };
      const flushResult = await runMemoryFlush({
        model: this.model,
        systemPrompt: this.systemPrompt,
        query,
        toolResults: fullToolResults,
        signal: this.signal,
      }).catch(() => ({ flushed: false, written: false as const }));
      memoryFlushState.alreadyFlushed = flushResult.flushed;
      yield {
        type: 'memory_flush',
        phase: 'end',
        filesWritten: flushResult.written ? [`${new Date().toISOString().slice(0, 10)}.md`] : [],
      };
    }

    // Step 2: Compaction
    if (
      this.compactionFailures < MAX_CONSECUTIVE_COMPACTION_FAILURES &&
      ctx.scratchpad.getActiveToolResultCount() >= MIN_TOOL_RESULTS_FOR_COMPACTION
    ) {
      yield { type: 'compaction', phase: 'start', preCompactTokens: estimatedContextTokens };

      try {
        const result = await compactContext({
          model: this.model,
          systemPrompt: this.systemPrompt,
          query,
          toolResults: fullToolResults,
          signal: this.signal,
        });

        messageState.messages = this.compactMessages(messageState.messages, result.summary, query);
        ctx.scratchpad.setCompactionSummary(result.summary);

        if (result.usage) {
          ctx.tokenCounter.add(result.usage);
        }

        this.compactionFailures = 0;
        memoryFlushState.alreadyFlushed = false;

        const postCompactTokens = estimateTokens(
          messageState.messages.map(m =>
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          ).join('\n'),
        );

        yield {
          type: 'compaction',
          phase: 'end',
          success: true,
          preCompactTokens: estimatedContextTokens,
          postCompactTokens,
          compactionModel: resolveProvider(this.model).fastModel ?? this.model,
        };

        return;
      } catch {
        this.compactionFailures++;
        yield {
          type: 'compaction',
          phase: 'end',
          success: false,
          preCompactTokens: estimatedContextTokens,
        };
      }
    }

    // Step 3: Fallback — truncate oldest rounds
    const removed = this.truncateMessages(messageState.messages, KEEP_TOOL_USES);
    if (removed > 0) {
      memoryFlushState.alreadyFlushed = false;
      yield { type: 'context_cleared', clearedCount: removed, keptCount: KEEP_TOOL_USES };
    }
  }
}

const MODE_PRIORITY: Record<StreamMode, number> = {
  requesting: 0,
  responding: 1,
  thinking: 2,
  'tool-input': 3,
  'tool-use': 4,
};

/**
 * Walk one streaming chunk's content and report total char-delta plus the most
 * "advanced" mode the chunk contains. LangChain content can be a plain string
 * (most providers) or an array of typed parts (Anthropic).
 */
function inspectChunkContent(chunk: AIMessageChunk): { charDelta: number; mode: StreamMode } {
  const content = chunk.content;
  if (typeof content === 'string') {
    return { charDelta: content.length, mode: 'responding' };
  }
  if (!Array.isArray(content)) {
    return { charDelta: 0, mode: 'responding' };
  }

  let charDelta = 0;
  let mode: StreamMode = 'responding';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const partType = (part as { type?: string }).type;
    if (partType === 'text') {
      const text = (part as { text?: string }).text;
      if (typeof text === 'string') charDelta += text.length;
      if (MODE_PRIORITY.responding > MODE_PRIORITY[mode]) mode = 'responding';
    } else if (partType === 'thinking' || partType === 'redacted_thinking') {
      const thinkingText = (part as { thinking?: string }).thinking;
      if (typeof thinkingText === 'string') charDelta += thinkingText.length;
      if (MODE_PRIORITY.thinking > MODE_PRIORITY[mode]) mode = 'thinking';
    } else if (partType === 'tool_use' || partType === 'input_json_delta') {
      const partialJson = (part as { input?: unknown; partial_json?: string }).partial_json;
      if (typeof partialJson === 'string') charDelta += partialJson.length;
      if (MODE_PRIORITY['tool-input'] > MODE_PRIORITY[mode]) mode = 'tool-input';
    }
  }
  return { charDelta, mode };
}
