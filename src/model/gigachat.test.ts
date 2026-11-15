import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { ChatGigaChat, convertMessages, sanitizeSchema, toFunctionContent } from './gigachat.js';

describe('GigaChat adapter', () => {
  test('schema sanitizer drops unsupported keys and collapses nullable unions', () => {
    const out = sanitizeSchema({
      $schema: 'x',
      type: 'object',
      additionalProperties: false,
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'd' }, b: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } } },
    });
    expect(out).toEqual({
      type: 'object',
      properties: { a: { type: 'string', description: 'd' }, b: { type: 'array', items: { type: 'object', properties: {} } } },
    });
  });

  test('function results are always JSON objects', () => {
    expect(toFunctionContent('{"data":1}')).toBe('{"data":1}');
    expect(toFunctionContent('[1,2]')).toBe('{"result":[1,2]}');
    expect(toFunctionContent('Error: boom')).toBe('{"result":"Error: boom"}');
  });

  test('message conversion: single system message, function call and result', () => {
    const msgs = convertMessages([
      new SystemMessage('sys'),
      new HumanMessage('q'),
      new AIMessage({ content: '', tool_calls: [{ name: 'get_quotes', args: { tickers: ['SBER'] }, id: '1', type: 'tool_call' }] }),
      new ToolMessage({ content: '{"data":{"last":293}}', tool_call_id: '1', name: 'get_quotes' }),
      new SystemMessage('late'),
    ]);
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect(msgs[2]).toEqual({ role: 'assistant', content: '', function_call: { name: 'get_quotes', arguments: { tickers: ['SBER'] } } });
    expect(msgs[3]).toEqual({ role: 'function', name: 'get_quotes', content: '{"data":{"last":293}}' });
    expect(msgs[4].role).toBe('user');
  });

  test('bindTools emits real JSON schemas for zod v4 tools', async () => {
    const tool = new DynamicStructuredTool({
      name: 'get_quotes',
      description: 'quotes',
      schema: z.object({ tickers: z.array(z.string()).describe('Тикеры') }),
      func: async () => '',
    });
    let captured: Record<string, unknown> | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('oauth')) return Response.json({ access_token: 't', expires_at: Date.now() + 3600_000 });
      captured = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: { role: 'assistant', content: '', function_call: { name: 'get_quotes', arguments: { tickers: ['SBER'] } } }, finish_reason: 'function_call' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }) as typeof fetch;
    try {
      const llm = new ChatGigaChat({ credentials: 'test', model: 'GigaChat-3-Pro' });
      const res = (await llm.bindTools([tool]).invoke([new HumanMessage('цена сбера')])) as AIMessage;
      const fn = (captured!.functions as Array<{ parameters: { properties: Record<string, unknown>; required: string[] } }>)[0];
      expect(fn.parameters.properties.tickers).toEqual({ type: 'array', items: { type: 'string' }, description: 'Тикеры' });
      expect(fn.parameters.required).toEqual(['tickers']);
      expect(captured!.function_call).toBe('auto');
      await llm.bindTools([tool], { tool_choice: 'get_quotes' }).invoke([new HumanMessage('цена сбера')]);
      expect(captured!.function_call).toEqual({ name: 'get_quotes' });
      expect(captured!.max_tokens).toBe(600);
      await llm.bindTools([tool], { tool_choice: 'unknown_tool' }).invoke([new HumanMessage('цена сбера')]);
      expect(captured!.function_call).toBe('auto');
      expect(res.tool_calls?.[0]).toMatchObject({ name: 'get_quotes', args: { tickers: ['SBER'] } });
      expect(res.usage_metadata?.total_tokens).toBe(15);
    } finally {
      globalThis.fetch = original;
    }
  });
});
