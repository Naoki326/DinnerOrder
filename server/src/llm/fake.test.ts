import { describe, expect, it } from 'vitest';
import { createFakeLlmClient } from './fake.js';
import { createUnconfiguredLlmClient } from './unconfigured.js';
import { LlmCallError, type ToolDefinition } from './types.js';

const tools: ToolDefinition[] = [
  {
    name: 'seasonal_ingredients',
    description: '按月份给出时令食材（M2 会拆成 stdio MCP server）',
    inputSchema: { type: 'object', properties: { month: { type: 'number' } }, required: ['month'] },
  },
];

describe('fake LLM 客户端', () => {
  it('默认返回确定性的回显，同入参同出参', async () => {
    const llm = createFakeLlmClient(tools);
    const first = await llm.callTool('seasonal_ingredients', { month: 6 });
    const second = await llm.callTool('seasonal_ingredients', { month: 6 });
    expect(first).toEqual({
      content: JSON.stringify({ tool: 'seasonal_ingredients', args: { month: 6 } }),
    });
    expect(second).toEqual(first);
  });

  it('调用日志按序记录，且参数是深拷贝（调用方后续改动不会污染日志）', async () => {
    const llm = createFakeLlmClient(tools);
    const args = { month: 6, tags: ['时令'] };
    await llm.callTool('seasonal_ingredients', args);
    args.tags.push('改了');
    args.month = 12;

    expect(llm.calls).toEqual([{ name: 'seasonal_ingredients', args: { month: 6, tags: ['时令'] } }]);
  });

  it('未注册的工具直接抛错，不会静默返回空结果', async () => {
    const llm = createFakeLlmClient(tools);
    await expect(llm.callTool('unknown_tool', {})).rejects.toThrow(/未注册工具/);
  });

  it('编程的响应优先于默认回显，且可为函数', async () => {
    const llm = createFakeLlmClient(tools);
    llm.setToolResult('seasonal_ingredients', { content: '固定响应' });
    expect(await llm.callTool('seasonal_ingredients', { month: 6 })).toEqual({ content: '固定响应' });

    llm.setToolResult('seasonal_ingredients', (args) => ({ content: `月份 ${String(args.month)}` }));
    expect(await llm.callTool('seasonal_ingredients', { month: 9 })).toEqual({ content: '月份 9' });
  });

  it('编程的错误优先抛出（覆盖降级链的一环）', async () => {
    const llm = createFakeLlmClient(tools);
    llm.setToolResult('seasonal_ingredients', { content: '不该被返回' });
    llm.setToolError('seasonal_ingredients', new Error('模拟 schema 校验连败'));
    await expect(llm.callTool('seasonal_ingredients', {})).rejects.toThrow('模拟 schema 校验连败');
  });

  it('listTools 暴露 MCP 形状的工具定义', () => {
    const llm = createFakeLlmClient(tools);
    expect(llm.listTools()).toEqual(tools);
  });
});

/**
 * completion 的编程序：降级链的测试全靠它——按调用顺序排好「第一次返回什么、第二次返回什么」。
 */
describe('fake LLM 的 completion', () => {
  const request = {
    system: 's',
    prompt: 'p',
    responseFormat: 'json_object' as const,
    timeoutMs: 1000,
  };

  it('缺省回显 request：出参里能直接读到「LLM 被问了什么」', async () => {
    const llm = createFakeLlmClient();
    const result = await llm.complete(request);
    expect(JSON.parse(result.text)).toEqual({ echo: { system: 's', prompt: 'p' } });
    expect(result.model).toBe('fake-llm');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('queueCompletion 按调用顺序弹出，弹完回落到 setCompletion', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('回落值');
    llm.queueCompletion('第一次', '第二次');

    expect((await llm.complete(request)).text).toBe('第一次');
    expect((await llm.complete(request)).text).toBe('第二次');
    expect((await llm.complete(request)).text).toBe('回落值');
  });

  it('队列里混错误对象：那一次抛出，后续照常（降级链要逐档控制）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('成功档');
    llm.queueCompletion(new Error('模拟超时'), '第二次成功');

    await expect(llm.complete(request)).rejects.toThrow('模拟超时');
    expect((await llm.complete(request)).text).toBe('第二次成功');
    expect((await llm.complete(request)).text).toBe('成功档');
  });

  it('失败调用也进日志，且 request 是深拷贝（调用方后续改动不污染日志）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletionError(new Error('端点不可用'));
    await expect(llm.complete(request)).rejects.toThrow(/端点不可用|fake LLM/);

    expect(llm.completionCalls.map((call) => call.ok)).toEqual([false]);
    expect(llm.completionCalls[0]?.request.responseFormat).toBe('json_object');
  });

  it('clearCalls 同时清空工具与 completion 日志', async () => {
    const llm = createFakeLlmClient(tools);
    await llm.callTool('seasonal_ingredients', { month: 6 });
    await llm.complete(request);
    expect(llm.calls.length).toBe(1);
    expect(llm.completionCalls.length).toBe(1);

    llm.clearCalls();
    expect(llm.calls.length).toBe(0);
    expect(llm.completionCalls.length).toBe(0);
  });
});

describe('生产占位客户端', () => {
  it('无工具、工具面调用即抛错（M1 的推荐不走工具面）', async () => {
    const llm = createUnconfiguredLlmClient();
    expect(llm.listTools()).toEqual([]);
    await expect(llm.callTool('anything', {})).rejects.toThrow(/未配置/);
  });

  it('completion 抛 LlmCallError：没配 LLM 时推荐降级成简化推荐，而不是报错给家人', async () => {
    const llm = createUnconfiguredLlmClient();
    const failure = llm.complete({
      system: 's',
      prompt: 'p',
      responseFormat: 'json_object',
      timeoutMs: 1000,
    });
    await expect(failure).rejects.toBeInstanceOf(LlmCallError);
  });
});
